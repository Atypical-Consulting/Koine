using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Formatting;

namespace Koine.Compiler.Services;

/// <summary>
/// The write paths of the round-trip seam (#91): <see cref="EmitKoine"/> (structured edit → validated
/// canonical <c>.koi</c>) and <see cref="ApplyEdit"/> (the same, as a scoped
/// <see cref="TextEditModel"/> patch). The engine is deliberately compiler-driven, never a
/// string-mangling shortcut: it computes the structural change as a precise text edit over the owning
/// file (using the model's source spans), <b>re-parses and re-validates</b> the whole workspace, and
/// only on a clean bar takes the affected declaration's text from the re-parsed edited source — so an
/// illegal edit comes back as <c>KOIxxxx</c> diagnostics, never broken <c>.koi</c>, and a legal edit
/// preserves the surrounding formatting and comments verbatim.
///
/// <para>The re-emit is a verbatim slice of the declaration's span out of the edited source (not a
/// re-print through <see cref="AstPrinter"/>): the edit already lives in that source, so slicing both
/// reflects it and keeps the emitted text byte-aligned with the <see cref="TextEditModel"/> range
/// <see cref="ApplyEdit"/> returns — re-printing would re-attach the declaration's leading doc/trivia
/// and desync that range.</para>
/// </summary>
public static partial class ModelRoundTripService
{
    /// <summary>
    /// Applies <paramref name="edit"/> to the workspace and returns the canonical <c>.koi</c> for just
    /// the affected declaration, or — when the edit produces an invalid model (duplicate member,
    /// unknown type, broken invariant) — the rejecting diagnostics with no <c>.koi</c>. Idempotent for
    /// a no-op edit (re-emits the source declaration). Never emits broken <c>.koi</c>.
    /// </summary>
    public static EmitResult EmitKoine(IReadOnlyList<SourceFile> files, StructuredEdit edit)
    {
        EditComputation c = Compute(files, edit);
        return new EmitResult(c.Koine, c.Diagnostics);
    }

    /// <summary>
    /// Applies <paramref name="edit"/> and returns a span-minimal patch: a single
    /// <see cref="TextEditModel"/> replacing the affected declaration's original range with its
    /// re-emitted text, so the editor patches only the touched declaration and every other byte of the
    /// file (formatting, comments, ordering) stays stable. Empty edits + diagnostics when illegal.
    /// </summary>
    public static ModelEditResult ApplyEdit(IReadOnlyList<SourceFile> files, StructuredEdit edit)
    {
        EditComputation c = Compute(files, edit);
        if (c.Koine is null || c.OriginalDeclSpan.IsNone)
        {
            return new ModelEditResult(c.Uri, [], c.Diagnostics);
        }

        var patch = new TextEditModel(c.OriginalDeclSpan, c.Koine);
        return new ModelEditResult(c.Uri, [patch], c.Diagnostics);
    }

    /// <summary>The shared output of the edit pipeline, projected by both public entry points.</summary>
    private sealed record EditComputation(
        string? Uri,
        SourceSpan OriginalDeclSpan,
        string? Koine,
        IReadOnlyList<Diagnostic> Diagnostics);

    private static EditComputation Compute(IReadOnlyList<SourceFile> files, StructuredEdit edit)
    {
        // Defensive: an unexpected throw (e.g. a malformed span) becomes a clean no-op rather than
        // bubbling out — so the desktop LSP never drops a response (which would hang the client) and
        // both backends fail symmetrically (the WASM JSExports catch identically).
        try
        {
            return ComputeCore(files, edit);
        }
        catch
        {
            return new EditComputation(null, SourceSpan.None, null, []);
        }
    }

    private static EditComputation ComputeCore(IReadOnlyList<SourceFile> files, StructuredEdit edit)
    {
        var compiler = new KoineCompiler();
        var (model, parseDiags) = compiler.Parse(files);
        var parseErrors = parseDiags.Where(IsError).ToList();
        if (model is null || parseErrors.Count > 0)
        {
            // No usable model to edit against — no-op with the parse errors (mirrors the read-path guard).
            return new EditComputation(null, SourceSpan.None, null, parseErrors);
        }

        // Resolve the affected declaration (the type or state machine) and the precise text edit.
        if (!TryResolveDeclaration(model, edit, out DeclTarget decl)
            || !TryComputeTextEdit(model, files, edit, out TextOp op))
        {
            return new EditComputation(decl.Uri, SourceSpan.None, null, []);
        }

        var originalText = SourceOf(files, op.Uri);
        if (originalText is null)
        {
            return new EditComputation(decl.Uri, SourceSpan.None, null, []);
        }

        var editedText = originalText[..op.Start] + op.Replacement + originalText[(op.Start + op.Length)..];

        // Compile the edited workspace ONCE (swap the edited file in), validate it, and reuse the very
        // same snapshot's model to re-resolve the declaration span — no second parse.
        var editedFiles = files
            .Select(f => string.Equals(f.Path, op.Uri, StringComparison.Ordinal) ? new SourceFile(f.Path, editedText) : f)
            .ToList();
        KoineCompilation edited = KoineCompilation.Create(editedFiles);
        var validationErrors = compiler.DiagnoseWorkspace(edited).Where(IsError).ToList();
        if (validationErrors.Count > 0)
        {
            return new EditComputation(decl.Uri, decl.OriginalSpan, null, validationErrors);
        }

        // Clean bar: slice the affected declaration back out of the edited source, verbatim.
        SourceSpan editedSpan = DeclSpan(edited.Model, decl);
        if (editedSpan.IsNone)
        {
            return new EditComputation(decl.Uri, decl.OriginalSpan, null, []);
        }

        var koine = SliceSpan(editedText, editedSpan);
        return new EditComputation(decl.Uri, decl.OriginalSpan, koine, []);
    }

    // ---- Declaration resolution ------------------------------------------

    /// <summary>
    /// The affected declaration the edit re-emits: a <c>type</c> (value/entity/enum/event), a state
    /// machine, or — for add/remove-type — the owning <c>context</c> (the surviving declaration whose
    /// re-sliced text reflects the added/removed type).
    /// </summary>
    private readonly record struct DeclTarget(bool IsStates, bool IsContext, string QualifiedName, string? Uri, SourceSpan OriginalSpan);

    private static bool TryResolveDeclaration(KoineModel model, StructuredEdit edit, out DeclTarget decl)
    {
        decl = default;
        if (edit.Kind == StructuredEditKind.AddTransition)
        {
            if (FindStates(model, edit.Target) is not { } s)
            {
                return false;
            }

            decl = new DeclTarget(true, false, edit.Target, s.States.Span.File, s.States.Span);
            return true;
        }

        // Add/remove a whole type: the affected declaration is the owning CONTEXT, which survives the
        // edit and whose re-sliced text carries the change (for add, Target IS the context name).
        if (edit.Kind is StructuredEditKind.AddType or StructuredEditKind.RemoveType)
        {
            var ctxName = edit.Kind == StructuredEditKind.AddType ? edit.Target : ContextOf(edit.Target);
            if (edit.Kind == StructuredEditKind.RemoveType && FindEditType(model, edit.Target) is null)
            {
                return false; // can't remove a type that isn't there
            }

            if (FindContext(model, ctxName) is not { } ctx)
            {
                return false;
            }

            decl = new DeclTarget(false, true, ctx.Name, ctx.Span.File, ctx.Span);
            return true;
        }

        var typeQName = edit.Kind == StructuredEditKind.AddField ? edit.Target : StripLastSegment(edit.Target);
        if (FindEditType(model, typeQName) is not { } type)
        {
            return false;
        }

        // Re-emit the matched declaration (an aggregate is re-emitted whole — its re-slice still captures
        // a field added to / removed from its root entity). Store the resolved canonical qname so the
        // post-edit re-slice (DeclSpan) finds it again without the diagram-form fallback.
        decl = new DeclTarget(false, false, typeQName, type.Span.File, type.Span);
        return true;
    }

    /// <summary>Re-resolves the affected declaration's span in the (re-parsed) edited model.</summary>
    private static SourceSpan DeclSpan(KoineModel model, DeclTarget decl) =>
        decl.IsContext
            ? FindContext(model, decl.QualifiedName)?.Span ?? SourceSpan.None
            : decl.IsStates
                ? FindStates(model, decl.QualifiedName)?.States.Span ?? SourceSpan.None
                : FindEditType(model, decl.QualifiedName)?.Span ?? SourceSpan.None;

    // ---- Text-edit computation per edit kind -----------------------------

    /// <summary>A computed text edit: replace <c>[Start, Start+Length)</c> of file <c>Uri</c> with <c>Replacement</c>.</summary>
    private readonly record struct TextOp(string? Uri, int Start, int Length, string Replacement);

    private static bool TryComputeTextEdit(KoineModel model, IReadOnlyList<SourceFile> files, StructuredEdit edit, out TextOp op)
    {
        op = default;
        switch (edit.Kind)
        {
            case StructuredEditKind.RenameMember:
                return TryRename(model, edit, out op);
            case StructuredEditKind.ChangeFieldType:
                return TryChangeFieldType(model, edit, out op);
            case StructuredEditKind.AddField:
                return TryAddField(model, files, edit, out op);
            case StructuredEditKind.RemoveMember:
                return TryRemoveMember(model, files, edit, out op);
            case StructuredEditKind.AddTransition:
                return TryAddTransition(model, files, edit, out op);
            case StructuredEditKind.AddType:
                return TryAddType(model, files, edit, out op);
            case StructuredEditKind.RemoveType:
                return TryRemoveType(model, files, edit, out op);
            default:
                return false;
        }
    }

    private static bool TryRename(KoineModel model, StructuredEdit edit, out TextOp op)
    {
        op = default;
        if (string.IsNullOrEmpty(edit.Name))
        {
            return false;
        }

        SourceSpan nameSpan = FindMember(model, edit.Target)?.Member.NameSpan
            ?? FindEnumMember(model, edit.Target)?.Member.NameSpan
            ?? SourceSpan.None;
        if (nameSpan.IsNone || nameSpan.Length <= 0)
        {
            return false;
        }

        op = new TextOp(nameSpan.File, nameSpan.Offset, nameSpan.Length, edit.Name!);
        return true;
    }

    private static bool TryChangeFieldType(KoineModel model, StructuredEdit edit, out TextOp op)
    {
        op = default;
        if (string.IsNullOrEmpty(edit.Type) || FindMember(model, edit.Target) is not { } hit)
        {
            return false;
        }

        SourceSpan typeSpan = hit.Member.Type.Span;
        if (typeSpan.IsNone || typeSpan.Length <= 0)
        {
            return false;
        }

        op = new TextOp(typeSpan.File, typeSpan.Offset, typeSpan.Length, edit.Type!);
        return true;
    }

    private static bool TryAddField(KoineModel model, IReadOnlyList<SourceFile> files, StructuredEdit edit, out TextOp op)
    {
        op = default;
        // The diagram addresses an aggregate root by the aggregate's qname; a field is added to its root
        // entity (FieldOwner), and a nested type is addressed as "Context.SimpleName" (FindEditType).
        if (string.IsNullOrEmpty(edit.Name) || string.IsNullOrEmpty(edit.Type)
            || FindEditType(model, edit.Target) is not { } resolved || FieldsOf(FieldOwner(resolved)) is not { } members)
        {
            return false;
        }

        var type = FieldOwner(resolved);
        var source = SourceOf(files, type.Span.File);
        if (source is null)
        {
            return false;
        }

        var line = $"{edit.Name}: {edit.Type}";
        var nl = NewlineOf(source);
        if (members.Count > 0 && members[^1].Span is { IsNone: false } last)
        {
            if (StartsOwnLine(source, last.Offset, out var anchorLineStart))
            {
                // The last member starts its own line: append a new line AFTER its whole physical line
                // (past any trailing comment), reusing that line's exact leading indentation.
                var indent = source[anchorLineStart..last.Offset];
                op = new TextOp(type.Span.File, EndOfLine(source, last.Offset + last.Length), 0, nl + indent + line);
                return true;
            }

            // The last member shares its line with the braces/siblings (a single-line declaration):
            // insert right after its content, before the closing brace, indented one body level in.
            var inlineIndent = new string(' ', Math.Max(0, type.Span.Column - 1) + 2);
            op = new TextOp(type.Span.File, last.Offset + last.Length, 0, nl + inlineIndent + line);
            return true;
        }

        // Empty body: open it up after the type's '{'.
        var brace = source.IndexOf('{', type.Span.Offset);
        if (brace < 0)
        {
            return false;
        }

        var bodyIndent = new string(' ', Math.Max(0, type.Span.Column - 1) + 2);
        var closeIndent = new string(' ', Math.Max(0, type.Span.Column - 1));
        op = new TextOp(type.Span.File, brace + 1, 0, nl + bodyIndent + line + nl + closeIndent);
        return true;
    }

    private static bool TryRemoveMember(KoineModel model, IReadOnlyList<SourceFile> files, StructuredEdit edit, out TextOp op)
    {
        op = default;
        if (FindMember(model, edit.Target) is not { } hit || hit.Member.Span.IsNone)
        {
            return false;   // enum-member removal (comma-separated) is out of scope for v1.
        }

        var source = SourceOf(files, hit.Member.Span.File);
        if (source is null)
        {
            return false;
        }

        SourceSpan span = hit.Member.Span;
        var end = span.Offset + span.Length;
        if (StartsOwnLine(source, span.Offset, out var lineStart))
        {
            // The member starts its own line: delete the whole line (incl any trailing comment) and
            // its line break, leaving no blank line behind.
            var lineEnd = EndOfLine(source, end);
            if (lineEnd < source.Length && source[lineEnd] == '\r')
            {
                lineEnd++;
            }

            if (lineEnd < source.Length && source[lineEnd] == '\n')
            {
                lineEnd++;
            }

            op = new TextOp(span.File, lineStart, lineEnd - lineStart, string.Empty);
            return true;
        }

        // The member shares its line with the braces/siblings (a single-line declaration): delete only
        // the member span plus its surrounding inline whitespace, keeping every structural token (the
        // braces, other members) intact rather than wiping the whole line.
        while (end < source.Length && (source[end] == ' ' || source[end] == '\t'))
        {
            end++;
        }

        var start = span.Offset;
        while (start > lineStart && (source[start - 1] == ' ' || source[start - 1] == '\t'))
        {
            start--;
        }

        op = new TextOp(span.File, start, end - start, string.Empty);
        return true;
    }

    private static bool TryAddTransition(KoineModel model, IReadOnlyList<SourceFile> files, StructuredEdit edit, out TextOp op)
    {
        op = default;
        if (string.IsNullOrEmpty(edit.Name) || string.IsNullOrEmpty(edit.Type)
            || FindStates(model, edit.Target) is not { } hit)
        {
            return false;
        }

        StatesDecl states = hit.States;
        var source = SourceOf(files, states.Span.File);
        if (source is null || states.Span.IsNone)
        {
            return false;
        }

        var rule = $"{edit.Name} -> {edit.Type}";
        var nl = NewlineOf(source);
        if (states.Rules.Count > 0 && states.Rules[^1].Span is { IsNone: false } lastRule
            && StartsOwnLine(source, lastRule.Offset, out var ruleLineStart))
        {
            // Append a new rule after the last rule's whole line, reusing its exact indentation.
            var indent = source[ruleLineStart..lastRule.Offset];
            op = new TextOp(states.Span.File, EndOfLine(source, lastRule.Offset + lastRule.Length), 0, nl + indent + rule);
            return true;
        }

        var brace = source.IndexOf('{', states.Span.Offset);
        if (brace < 0)
        {
            return false;
        }

        var bodyIndent = new string(' ', Math.Max(0, states.Span.Column - 1) + 2);
        var closeIndent = new string(' ', Math.Max(0, states.Span.Column - 1));
        op = new TextOp(states.Span.File, brace + 1, 0, nl + bodyIndent + rule + nl + closeIndent);
        return true;
    }

    /// <summary>
    /// Insert a minimal, valid <c>value</c>-object skeleton (one <c>String</c> field) into the
    /// <paramref name="edit"/>.Target context — after its last top-level type, or into an empty body.
    /// Re-validation rejects a duplicate / invalid name, so a broken model is never produced.
    /// </summary>
    private static bool TryAddType(KoineModel model, IReadOnlyList<SourceFile> files, StructuredEdit edit, out TextOp op)
    {
        op = default;
        if (string.IsNullOrEmpty(edit.Name) || FindContext(model, edit.Target) is not { } ctx || ctx.Span.IsNone)
        {
            return false;
        }

        var source = SourceOf(files, ctx.Span.File);
        if (source is null)
        {
            return false;
        }

        var nl = NewlineOf(source);
        var typeIndent = new string(' ', Math.Max(0, ctx.Span.Column - 1) + 2);
        // A value object with a single String field is the minimal valid type; the author refines it.
        var skeleton = $"value {edit.Name} {{{nl}{typeIndent}  name: String{nl}{typeIndent}}}";

        if (ctx.Types.Count > 0 && ctx.Types[^1].Span is { IsNone: false } last)
        {
            // After the last top-level type's whole physical block, with a blank line between.
            op = new TextOp(ctx.Span.File, EndOfLine(source, last.Offset + last.Length), 0, nl + nl + typeIndent + skeleton);
            return true;
        }

        // Empty context body: open it after the context's '{'.
        var brace = source.IndexOf('{', ctx.Span.Offset);
        if (brace < 0)
        {
            return false;
        }

        var closeIndent = new string(' ', Math.Max(0, ctx.Span.Column - 1));
        op = new TextOp(ctx.Span.File, brace + 1, 0, nl + typeIndent + skeleton + nl + closeIndent);
        return true;
    }

    /// <summary>
    /// Delete a whole type declaration (its full span plus the line break behind it). Re-validation
    /// rejects the edit when the type is still referenced, so the model never dangles.
    /// </summary>
    private static bool TryRemoveType(KoineModel model, IReadOnlyList<SourceFile> files, StructuredEdit edit, out TextOp op)
    {
        op = default;
        if (FindEditType(model, edit.Target) is not { } type || type.Span.IsNone)
        {
            return false;
        }

        var source = SourceOf(files, type.Span.File);
        if (source is null)
        {
            return false;
        }

        SourceSpan span = type.Span;
        var end = span.Offset + span.Length;
        if (StartsOwnLine(source, span.Offset, out var lineStart))
        {
            // Also delete the type's leading /// doc-comment lines, so they don't reattach to the next type.
            lineStart = IncludeLeadingDocLines(source, lineStart);
            var lineEnd = EndOfLine(source, end);
            if (lineEnd < source.Length && source[lineEnd] == '\r')
            {
                lineEnd++;
            }

            if (lineEnd < source.Length && source[lineEnd] == '\n')
            {
                lineEnd++;
            }

            op = new TextOp(span.File, lineStart, lineEnd - lineStart, string.Empty);
            return true;
        }

        op = new TextOp(span.File, span.Offset, end - span.Offset, string.Empty);
        return true;
    }

    // ---- Model lookups ----------------------------------------------------

    private static TypeDecl? FindType(KoineModel model, string qualifiedName) =>
        AllTypes(model).FirstOrDefault(t => string.Equals(t.QName, qualifiedName, StringComparison.Ordinal)).Type;

    /// <summary>
    /// Resolve a type for an EDIT, accepting the diagram's addressing as well as the canonical qname:
    /// an exact <see cref="FindType"/> match, else — for a two-segment <c>"Context.SimpleName"</c> — the
    /// first type in that context whose simple name matches. Diagram nodes drop the aggregate segment, so
    /// a nested <c>OrderLine</c> is addressed as <c>"Ordering.OrderLine"</c>, not <c>"Ordering.Order.OrderLine"</c>.
    /// </summary>
    private static TypeDecl? FindEditType(KoineModel model, string qualifiedName)
    {
        if (FindType(model, qualifiedName) is { } exact)
        {
            return exact;
        }

        var dot = qualifiedName.IndexOf('.');
        if (dot < 0 || qualifiedName.IndexOf('.', dot + 1) >= 0)
        {
            return null; // only "Context.SimpleName" gets the nested-type fallback
        }

        var ctx = qualifiedName[..dot];
        var simple = qualifiedName[(dot + 1)..];
        return AllTypes(model)
            .Where(t => string.Equals(t.Type.Name, simple, StringComparison.Ordinal) && ContextOf(t.QName) == ctx)
            .Select(t => t.Type)
            .FirstOrDefault();
    }

    /// <summary>
    /// The declaration that OWNS a type's fields: an aggregate's fields live on its root entity, so a
    /// field edit addressed to an aggregate (the diagram's aggregate-root node) is redirected there.
    /// Every other type owns its own fields.
    /// </summary>
    private static TypeDecl FieldOwner(TypeDecl type) =>
        type is AggregateDecl agg && agg.RootEntity() is { } root ? root : type;

    private static ContextNode? FindContext(KoineModel model, string name) =>
        model.Contexts.FirstOrDefault(c => string.Equals(c.Name, name, StringComparison.Ordinal));

    /// <summary>The bounded-context prefix of a qualified name (everything before the first dot).</summary>
    private static string ContextOf(string qualifiedName)
    {
        var dot = qualifiedName.IndexOf('.');
        return dot < 0 ? qualifiedName : qualifiedName[..dot];
    }

    private static (TypeDecl Owner, Member Member)? FindMember(KoineModel model, string qualifiedName)
    {
        var ownerQName = StripLastSegment(qualifiedName);
        var memberName = LastSegment(qualifiedName);
        // Resolve the owner the same way edits address it: a nested type by "Context.SimpleName", and an
        // aggregate qname redirected to its root entity, which is where the composition field actually lives.
        if (FindEditType(model, ownerQName) is not { } resolved || FieldsOf(FieldOwner(resolved)) is not { } members)
        {
            return null;
        }

        var type = FieldOwner(resolved);
        Member? member = members.FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal));
        return member is null ? null : (type, member);
    }

    private static (EnumDecl Owner, EnumMember Member)? FindEnumMember(KoineModel model, string qualifiedName)
    {
        var ownerQName = StripLastSegment(qualifiedName);
        var memberName = LastSegment(qualifiedName);
        if (FindType(model, ownerQName) is not EnumDecl en)
        {
            return null;
        }

        EnumMember? member = en.Members.FirstOrDefault(m => string.Equals(m.Name, memberName, StringComparison.Ordinal));
        return member is null ? null : (en, member);
    }

    private static (EntityDecl Owner, StatesDecl States)? FindStates(KoineModel model, string qualifiedName)
    {
        const string marker = ".states.";
        var idx = qualifiedName.LastIndexOf(marker, StringComparison.Ordinal);
        if (idx < 0)
        {
            return null;
        }

        var entityQName = qualifiedName[..idx];
        var field = qualifiedName[(idx + marker.Length)..];
        if (FindType(model, entityQName) is not EntityDecl entity)
        {
            return null;
        }

        StatesDecl? states = entity.States.FirstOrDefault(s => string.Equals(s.Field, field, StringComparison.Ordinal));
        return states is null ? null : (entity, states);
    }

    private static IEnumerable<(string QName, TypeDecl Type)> AllTypes(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl t in ctx.Types)
            {
                foreach ((string, TypeDecl) pair in TypesWithin(t, ctx.Name))
                {
                    yield return pair;
                }
            }
        }
    }

    private static IEnumerable<(string QName, TypeDecl Type)> TypesWithin(TypeDecl type, string prefix)
    {
        var qualified = prefix + "." + type.Name;
        yield return (qualified, type);
        if (type is AggregateDecl agg)
        {
            foreach (TypeDecl nested in agg.Types)
            {
                foreach ((string, TypeDecl) pair in TypesWithin(nested, qualified))
                {
                    yield return pair;
                }
            }
        }
    }

    private static IReadOnlyList<Member>? FieldsOf(TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => null,
    };

    // ---- Small text + name helpers ---------------------------------------

    private static bool IsError(Diagnostic d) => d.Severity == DiagnosticSeverity.Error;

    private static string? SourceOf(IReadOnlyList<SourceFile> files, string? uri)
    {
        foreach (SourceFile f in files)
        {
            if (string.Equals(f.Path, uri, StringComparison.Ordinal))
            {
                return f.Source;
            }
        }

        return null;
    }

    private static string SliceSpan(string text, SourceSpan span) =>
        span.IsNone || span.Offset < 0 || span.Offset + span.Length > text.Length
            ? string.Empty
            : text.Substring(span.Offset, span.Length);

    /// <summary>The line break used by <paramref name="text"/> (CRLF when present, else LF), so inserted lines match.</summary>
    private static string NewlineOf(string text) =>
        text.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";

    /// <summary>
    /// True when everything from the start of the line up to <paramref name="offset"/> is whitespace —
    /// i.e. the token at <paramref name="offset"/> begins its own line (as opposed to sharing the line
    /// with braces or sibling members, the single-line-declaration case).
    /// </summary>
    private static bool StartsOwnLine(string text, int offset, out int lineStart)
    {
        lineStart = StartOfLine(text, offset);
        for (var i = lineStart; i < offset && i < text.Length; i++)
        {
            if (text[i] != ' ' && text[i] != '\t')
            {
                return false;
            }
        }

        return true;
    }

    /// <summary>The offset of the first character of the line containing <paramref name="offset"/>.</summary>
    private static int StartOfLine(string text, int offset)
    {
        var i = Math.Min(offset, text.Length) - 1;
        while (i >= 0 && text[i] != '\n')
        {
            i--;
        }

        return i + 1;
    }

    /// <summary>
    /// Extend a deletion's start backwards over the declaration's contiguous leading <c>///</c> doc-comment
    /// lines, so removing a documented type doesn't leave its doc block orphaned onto the next declaration.
    /// </summary>
    private static int IncludeLeadingDocLines(string text, int lineStart)
    {
        var start = lineStart;
        while (start > 0)
        {
            var prevLineStart = StartOfLine(text, start - 1);
            if (text[prevLineStart..start].TrimStart().StartsWith("///", StringComparison.Ordinal))
            {
                start = prevLineStart;
            }
            else
            {
                break;
            }
        }

        return start;
    }

    /// <summary>The offset just past the last non-newline character of the line containing <paramref name="offset"/>.</summary>
    private static int EndOfLine(string text, int offset)
    {
        var i = Math.Max(0, Math.Min(offset, text.Length));
        while (i < text.Length && text[i] != '\n')
        {
            i++;
        }

        return i;
    }

    private static string StripLastSegment(string qualifiedName)
    {
        var idx = qualifiedName.LastIndexOf('.');
        return idx < 0 ? qualifiedName : qualifiedName[..idx];
    }

    private static string LastSegment(string qualifiedName)
    {
        var idx = qualifiedName.LastIndexOf('.');
        return idx < 0 ? qualifiedName : qualifiedName[(idx + 1)..];
    }
}
