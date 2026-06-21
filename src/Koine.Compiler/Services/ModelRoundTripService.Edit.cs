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
/// only on a clean bar slices the affected declaration back out via <see cref="AstPrinter"/> — so an
/// illegal edit comes back as <c>KOIxxxx</c> diagnostics, never broken <c>.koi</c>, and a legal edit
/// preserves the surrounding formatting and comments verbatim.
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

        // Re-parse + re-validate the whole workspace with the edited file swapped in.
        var editedFiles = files
            .Select(f => string.Equals(f.Path, op.Uri, StringComparison.Ordinal) ? new SourceFile(f.Path, editedText) : f)
            .ToList();
        var validationErrors = compiler.DiagnoseWorkspace(editedFiles).Where(IsError).ToList();
        if (validationErrors.Count > 0)
        {
            return new EditComputation(decl.Uri, decl.OriginalSpan, null, validationErrors);
        }

        // Clean bar: slice the affected declaration back out of the edited source, verbatim.
        var (newModel, _) = compiler.Parse(editedFiles);
        SourceSpan editedSpan = newModel is null ? SourceSpan.None : DeclSpan(newModel, decl);
        if (editedSpan.IsNone)
        {
            return new EditComputation(decl.Uri, decl.OriginalSpan, null, []);
        }

        var koine = SliceSpan(editedText, editedSpan);
        return new EditComputation(decl.Uri, decl.OriginalSpan, koine, []);
    }

    // ---- Declaration resolution ------------------------------------------

    /// <summary>The affected declaration: a <c>type</c> (value/entity/enum/event) or a state machine.</summary>
    private readonly record struct DeclTarget(bool IsStates, string QualifiedName, string? Uri, SourceSpan OriginalSpan);

    private static bool TryResolveDeclaration(KoineModel model, StructuredEdit edit, out DeclTarget decl)
    {
        decl = default;
        if (edit.Kind == StructuredEditKind.AddTransition)
        {
            if (FindStates(model, edit.Target) is not { } s)
            {
                return false;
            }

            decl = new DeclTarget(true, edit.Target, s.States.Span.File, s.States.Span);
            return true;
        }

        var typeQName = edit.Kind == StructuredEditKind.AddField ? edit.Target : StripLastSegment(edit.Target);
        if (FindType(model, typeQName) is not { } type)
        {
            return false;
        }

        decl = new DeclTarget(false, typeQName, type.Span.File, type.Span);
        return true;
    }

    /// <summary>Re-resolves the affected declaration's span in the (re-parsed) edited model.</summary>
    private static SourceSpan DeclSpan(KoineModel model, DeclTarget decl) =>
        decl.IsStates
            ? FindStates(model, decl.QualifiedName)?.States.Span ?? SourceSpan.None
            : FindType(model, decl.QualifiedName)?.Span ?? SourceSpan.None;

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
        if (string.IsNullOrEmpty(edit.Name) || string.IsNullOrEmpty(edit.Type)
            || FindType(model, edit.Target) is not { } type || FieldsOf(type) is not { } members)
        {
            return false;
        }

        var source = SourceOf(files, type.Span.File);
        if (source is null)
        {
            return false;
        }

        var line = $"{edit.Name}: {edit.Type}";
        if (members.Count > 0 && members[^1].Span is { IsNone: false } last && members[0].Span is { IsNone: false } first)
        {
            // Insert a new field right after the last existing member's content (before any closing
            // brace, so it stays inside the body even for a single-line declaration), sharing the
            // first member's indentation.
            var indent = new string(' ', Math.Max(0, first.Column - 1));
            op = new TextOp(type.Span.File, last.Offset + last.Length, 0, "\n" + indent + line);
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
        op = new TextOp(type.Span.File, brace + 1, 0, "\n" + bodyIndent + line + "\n" + closeIndent);
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
        var lineStart = StartOfLine(source, span.Offset);
        var lineEnd = EndOfLine(source, span.Offset + span.Length);
        if (lineEnd < source.Length && source[lineEnd] == '\n')
        {
            lineEnd++;   // swallow the trailing newline so no blank line is left behind.
        }

        op = new TextOp(hit.Member.Span.File, lineStart, lineEnd - lineStart, string.Empty);
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
        if (states.Rules.Count > 0 && states.Rules[0].Span is { IsNone: false } firstRule
            && states.Rules[^1].Span is { IsNone: false } lastRule)
        {
            var indent = new string(' ', Math.Max(0, firstRule.Column - 1));
            op = new TextOp(states.Span.File, lastRule.Offset + lastRule.Length, 0, "\n" + indent + rule);
            return true;
        }

        var brace = source.IndexOf('{', states.Span.Offset);
        if (brace < 0)
        {
            return false;
        }

        var bodyIndent = new string(' ', Math.Max(0, states.Span.Column - 1) + 2);
        var closeIndent = new string(' ', Math.Max(0, states.Span.Column - 1));
        op = new TextOp(states.Span.File, brace + 1, 0, "\n" + bodyIndent + rule + "\n" + closeIndent);
        return true;
    }

    // ---- Model lookups ----------------------------------------------------

    private static TypeDecl? FindType(KoineModel model, string qualifiedName) =>
        AllTypes(model).FirstOrDefault(t => string.Equals(t.QName, qualifiedName, StringComparison.Ordinal)).Type;

    private static (TypeDecl Owner, Member Member)? FindMember(KoineModel model, string qualifiedName)
    {
        var ownerQName = StripLastSegment(qualifiedName);
        var memberName = LastSegment(qualifiedName);
        if (FindType(model, ownerQName) is not { } type || FieldsOf(type) is not { } members)
        {
            return null;
        }

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
