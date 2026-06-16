using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Services;

/// <summary>The kind of a completion item; the LSP shell maps these to LSP numbers.</summary>
public enum CompletionItemKind { Keyword, Class, Enum, EnumMember, Field, Property, Method }

/// <summary>A single completion candidate, free of any LSP/JSON concepts.</summary>
public sealed record CompletionItem(string Label, CompletionItemKind Kind, string? Detail, string? Documentation);

/// <summary>A hover card: rendered markdown plus the located token's 1-based start.</summary>
public sealed record HoverResult(string Markdown);

/// <summary>A go-to-definition target: a single 1-based point (SourceSpan has no end).</summary>
public sealed record DefinitionResult(string Uri, SourceSpan Target);

/// <summary>
/// One text edit of a refactor: replace the source covered by <see cref="Range"/> (a 1-based,
/// end-EXCLUSIVE <see cref="SourceSpan"/>) with <see cref="NewText"/>. A zero-width range
/// (<c>EndLine == Line &amp;&amp; EndColumn == Column</c>) is a pure insertion. Editor-agnostic.
/// </summary>
public sealed record TextEditModel(SourceSpan Range, string NewText);

/// <summary>
/// A selection-driven refactor offered at a position/selection: a human-readable
/// <see cref="Title"/>, an LSP code-action <see cref="Kind"/> (e.g. <c>refactor.extract</c>),
/// and the ordered <see cref="Edits"/> that apply it within the active document. Editor-agnostic:
/// the LSP shell maps it to a CodeAction with an inline WorkspaceEdit.
/// </summary>
public sealed record CodeActionEdit(string Title, string Kind, IReadOnlyList<TextEditModel> Edits);

/// <summary>The kind of a document symbol; the LSP shell maps these to LSP SymbolKind numbers.</summary>
public enum SymbolKind { Namespace, Class, Enum, EnumMember, Field, Method, Constructor, Interface, Struct }

/// <summary>
/// One node of a document's symbol outline: a name, a kind, the full declaration
/// <see cref="Range"/> (the LSP <c>range</c>), the identifier <see cref="SelectionRange"/>
/// (the LSP <c>selectionRange</c>), and its nested children (context &gt; type &gt; members).
/// Editor-agnostic.
/// </summary>
public sealed record DocumentSymbol(
    string Name,
    SymbolKind Kind,
    SourceSpan Range,
    SourceSpan SelectionRange,
    IReadOnlyList<DocumentSymbol> Children);

/// <summary>
/// Editor-agnostic language services for <c>.koi</c>. <see cref="CompleteAt"/> is
/// single-file and lexer-only (works on broken documents). <see cref="HoverAt"/> and
/// <see cref="DefinitionAt"/> take a workspace document map (uri → source) plus the
/// active URI and resolve declarations across files via <see cref="WorkspaceIndex"/>,
/// returning null when nothing resolves.
/// </summary>
public sealed class KoineLanguageService
{
    private readonly KoineCompiler _compiler;

    public KoineLanguageService() : this(new KoineCompiler()) { }
    public KoineLanguageService(KoineCompiler compiler) => _compiler = compiler;

    // Declaration keywords offered at a statement start, keyed by enclosing scope.
    // These mirror the parser's member productions (programMember / contextMember /
    // serviceMember etc. in KoineParser.g4) so every legal declaration is offered.
    private static readonly string[] FileStarters = ["context", "contextmap"];
    private static readonly string[] ContextStarters =
    [
        "module", "import", "value", "quantity", "entity", "aggregate", "enum", "event",
          "spec", "service", "policy", "readmodel", "query"
    ];
    private static readonly string[] AggregateStarters =
        ["value", "quantity", "entity", "enum", "event", "spec", "repository"];
    private static readonly string[] ServiceStarters = ["operation", "usecase"];
    private static readonly string[] RepositoryStarters = ["operations", "find"];
    private static readonly string[] EntityStarters = ["states", "command", "create", "invariant"];
    // A module nests only types and further modules (KoineParser.g4: moduleMember).
    private static readonly string[] ModuleStarters =
    [
        "module", "value", "quantity", "entity", "aggregate", "enum", "event",
          "readmodel", "query"
    ];

    private static readonly string[] CollectionKeywords =
        [ModelIndex.ListTypeName, ModelIndex.SetTypeName, ModelIndex.MapTypeName, ModelIndex.RangeTypeName];

    public IReadOnlyList<CompletionItem> CompleteAt(string source, int line, int character)
    {
        var ctx = TokenLocator.Locate(source, line, character);
        if (ctx.InsideStringOrRegex)
        {
            return [];
        }

        var (model, _) = _compiler.Parse(source);
        var index = model is null ? null : new ModelIndex(model);

        // Member access (`receiver.`) almost always sits in a doc that doesn't parse yet —
        // the dangling '.' is a syntax error. Repair it by inserting a placeholder member
        // name at the cursor and re-parsing, so the receiver's type can still be resolved.
        if (index is null && ctx.PrecedingToken?.Type == KoineLexer.DOT)
        {
            var (repaired, _) = _compiler.Parse(InsertPlaceholder(source, line, character));
            if (repaired is not null)
            {
                index = new ModelIndex(repaired);
            }
        }

        var items = CandidatesFor(ctx, index);
        return Filter(items, ctx.Partial);
    }

    /// <summary>
    /// Inserts a synthetic identifier at an LSP 0-based <paramref name="line"/>/<paramref name="character"/>
    /// so a dangling member access (<c>x.</c>) parses for completion. Best-effort: an out-of-range
    /// position returns the source unchanged.
    /// </summary>
    private static string InsertPlaceholder(string source, int line, int character)
    {
        var lines = source.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        if (line < 0 || line >= lines.Length)
        {
            return source;
        }

        var text = lines[line];
        var col = Math.Clamp(character, 0, text.Length);
        lines[line] = text[..col] + "__koine_completion__" + text[col..];
        return string.Join('\n', lines);
    }

    private IReadOnlyList<CompletionItem> CandidatesFor(TokenContext ctx, ModelIndex? index)
    {
        var trigger = ctx.PrecedingToken?.Type;

        // Type position: after ':' (member/param/return type), or '<' inside a
        // generic argument list following a type name.
        // THEN: precise for policy reactions (then Type.command(...)); may over-offer
        // types after a conditional 'then' — acceptable, expression-aware completion is out of scope.
        if (trigger == KoineLexer.COLON
            || trigger == KoineLexer.ON
            || trigger == KoineLexer.THEN
            || IsGenericArgPosition(ctx, index))
        {
            return TypeCandidates(index);
        }

        // Member access: resolve the receiver to a type and offer that type's members.
        // Best-effort and only when the document parses (a broken doc has no model, so we
        // return nothing rather than guess — the no-noise contract). The receiver here is
        // the single token before the '.' (a field name in the enclosing type, an enum type
        // name, or a declared type name); a multi-hop chain `a.b.c` resolves left-to-right.
        if (trigger == KoineLexer.DOT)
        {
            return DotCandidates(ctx, index);
        }

        // Enum value position: after '=' (a field/param default). Resolve the
        // governing enum from the preceding `name : EnumType =` triple when possible;
        // otherwise fall back to every known enum member (still useful mid-edit).
        if (trigger == KoineLexer.ASSIGN)
        {
            return EnumMemberCandidates(ctx, index);
        }

        // Declaration start: cursor at the start of a statement (after '{' or '}'),
        // or at file scope.
        if (ctx.PrecedingToken is null
            || trigger == KoineLexer.LBRACE
            || trigger == KoineLexer.RBRACE)
        {
            return Keywords(StartersFor(ctx.EnclosingKeyword));
        }

        // Expression-operand position inside a fielded type body (e.g. `invariant
        // amount >= 0`, `requires qty > 0`): offer that type's field names AND the specs
        // declared on it (a spec is referenceable by name as a boolean, R10.1). We only
        // fire after a token that begins/continues an expression, so we never add
        // noise at a declaration or parameter position.
        if (index is not null && ctx.EnclosingTypeName is { } scopeType && IsExpressionOperand(trigger))
        {
            return FieldCandidates(index, scopeType).Concat(SpecCandidates(index, scopeType)).ToList();
        }

        return [];
    }

    /// <summary>
    /// Members offered after <c>receiver.</c>. The receiver is the token immediately
    /// before the '.' (<see cref="TokenContext.TokenBeforePreceding"/>): a field in the
    /// enclosing fielded type (offer that field type's members), a declared enum type
    /// (offer its members), or any declared value/entity type (offer its members). Returns
    /// nothing when nothing resolves — never guesses.
    /// </summary>
    private IReadOnlyList<CompletionItem> DotCandidates(TokenContext ctx, ModelIndex? index)
    {
        if (index is null)
        {
            return [];
        }

        var receiver = ctx.TokenBeforePreceding?.Text;
        if (string.IsNullOrEmpty(receiver))
        {
            return [];
        }

        // 1. `EnumType.` -> its members.
        if (index.IsEnumType(receiver) && index.TryGetDecl(receiver, out var ed) && ed is EnumDecl en)
        {
            return en.Members
                .Select(m => new CompletionItem(m.Name, CompletionItemKind.EnumMember, receiver, m.Doc))
                .ToList();
        }

        // 2. `Type.` where the receiver is itself a declared value/entity type name.
        if (index.IsKnownType(receiver) && MembersOf(index, receiver) is { Count: > 0 } directMembers)
        {
            return directMembers;
        }

        // 3. `field.` where the receiver is a field of the enclosing fielded type:
        //    resolve the field's declared type and offer ITS members.
        if (ctx.EnclosingTypeName is { } scopeType
            && index.TryGetMemberType(scopeType, receiver, out var fieldType)
            && MembersOf(index, fieldType.Name) is { Count: > 0 } members)
        {
            return members;
        }

        return [];
    }

    /// <summary>The member completions (name + type detail) of a value/entity type, or an empty list.</summary>
    private static IReadOnlyList<CompletionItem> MembersOf(ModelIndex index, string typeName) =>
        index.MemberNames(typeName)
            .Select(name =>
            {
                var detail = index.TryGetMemberType(typeName, name, out var t) ? RenderType(t) : "field";
                return new CompletionItem(name, CompletionItemKind.Property, detail, null);
            })
            .ToList();

    // Tokens after which an identifier is an expression operand (so a field name fits).
    // ASSIGN (enum defaults) and DOT (member access, kept noise-free) are deliberately excluded.
    private static bool IsExpressionOperand(int? trigger) => trigger is
        KoineLexer.INVARIANT or KoineLexer.REQUIRES or KoineLexer.WHEN or KoineLexer.IF
        or KoineLexer.ELSE or KoineLexer.COALESCE or KoineLexer.NOT or KoineLexer.MINUS
        or KoineLexer.PLUS or KoineLexer.STAR or KoineLexer.SLASH or KoineLexer.EQ
        or KoineLexer.NEQ or KoineLexer.LT or KoineLexer.LE or KoineLexer.GT or KoineLexer.GE
        or KoineLexer.AND or KoineLexer.OR or KoineLexer.MATCHES or KoineLexer.RARROW;

    private static IReadOnlyList<CompletionItem> FieldCandidates(ModelIndex index, string typeName) =>
        index.MemberNames(typeName)
            .Select(name =>
            {
                var detail = index.TryGetMemberType(typeName, name, out var t) ? RenderType(t) : "field";
                return new CompletionItem(name, CompletionItemKind.Field, detail, null);
            })
            .ToList();

    /// <summary>The specs declared on <paramref name="typeName"/> (R10.1), referenceable by name as booleans.</summary>
    private static IReadOnlyList<CompletionItem> SpecCandidates(ModelIndex index, string typeName) =>
        index.SpecsFor(typeName).Values
            .Select(s => new CompletionItem(s.Name, CompletionItemKind.Method, "spec", s.Doc))
            .ToList();

    /// <summary>Renders a (possibly generic/optional) type reference for a completion detail, e.g. <c>List&lt;OrderLine&gt;?</c>.</summary>
    private static string RenderType(TypeRef t)
    {
        var name = t.Qualifier is { } q ? $"{q}.{t.Name}" : t.Name;
        if (t.Element is not null)
        {
            name += t.Value is not null
                ? $"<{RenderType(t.Element)}, {RenderType(t.Value)}>"
                : $"<{RenderType(t.Element)}>";
        }

        return t.IsOptional ? name + "?" : name;
    }

    private static bool IsGenericArgPosition(TokenContext ctx, ModelIndex? index)
    {
        // Conservative: only treat '<' as a type-arg opener when the token before it
        // is a known type name. This avoids confusing the relational '<' operator in
        // an expression with a generic argument list. Without a model we cannot tell,
        // so we suppress.
        if (ctx.PrecedingToken?.Type != KoineLexer.LT || index is null)
        {
            return false;
        }

        var before = ctx.TokenBeforePreceding?.Text;
        return before is not null && index.IsKnownType(before);
    }

    private IReadOnlyList<CompletionItem> TypeCandidates(ModelIndex? index)
    {
        if (index is null)
        {
            // Broken document: offer primitives + collection keywords only.
            var fallback = ModelIndex.Primitives
                .Select(p => new CompletionItem(p, CompletionItemKind.Class, "primitive", null))
                .Concat(CollectionKeywords.Select(c => new CompletionItem(c, CompletionItemKind.Class, "collection", null)));
            return fallback.ToList();
        }

        return index.CandidateTypeNames
            .Select(name =>
            {
                var kind = index.Classify(name);
                return new CompletionItem(name, KindOf(kind), kind.ToString(), null);
            })
            .ToList();
    }

    private IReadOnlyList<CompletionItem> EnumMemberCandidates(TokenContext ctx, ModelIndex? index)
    {
        if (index is null)
        {
            return [];
        }

        // Resolve the governing enum from the type name just before '=' .
        var typeName = ctx.TokenBeforePreceding?.Text;
        if (typeName is not null && index.IsEnumType(typeName)
            && index.TryGetDecl(typeName, out var decl) && decl is EnumDecl e)
        {
            return e.Members
                .Select(m => new CompletionItem(m.Name, CompletionItemKind.EnumMember, typeName, m.Doc))
                .ToList();
        }

        // Fallback (e.g. the type name is not directly to the left): every enum member
        // declared anywhere — ambiguous, still useful mid-edit.
        return index.EnumMemberToType
            .Select(kvp => new CompletionItem(kvp.Key, CompletionItemKind.EnumMember, kvp.Value, null))
            .ToList();
    }

    private static CompletionItemKind KindOf(TypeKind kind) => kind switch
    {
        TypeKind.Enum => CompletionItemKind.Enum,
        TypeKind.Value or TypeKind.Entity or TypeKind.Aggregate or TypeKind.Event
            or TypeKind.IdValueObject => CompletionItemKind.Class,
        _ => CompletionItemKind.Class,
    };

    private static string[] StartersFor(string? enclosing) => enclosing switch
    {
        null => FileStarters,
        "context" => ContextStarters,
        "module" => ModuleStarters,
        "aggregate" => AggregateStarters,
        "service" => ServiceStarters,
        "repository" => RepositoryStarters,
        "entity" => EntityStarters,
        _ => [],
    };

    private static IReadOnlyList<CompletionItem> Keywords(string[] names) =>
        names.Select(n => new CompletionItem(n, CompletionItemKind.Keyword, "keyword", null)).ToList();

    private static IReadOnlyList<CompletionItem> Filter(IReadOnlyList<CompletionItem> items, string partial)
    {
        if (partial.Length == 0)
        {
            return items;
        }

        var matched = items.Where(i => i.Label.StartsWith(partial, StringComparison.Ordinal)).ToList();
        return matched; // empty list when nothing matches, by design
    }

    /// <summary>The identifier-like token text under the cursor, or null (whitespace, string, regex).</summary>
    public string? NameAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character);
        return ctx.InsideStringOrRegex ? null : ctx.CurrentToken?.Text;
    }

    /// <summary>
    /// The 0-based absolute character offset of an LSP 0-based <paramref name="line"/>/
    /// <paramref name="character"/> in <paramref name="source"/>, matching ANTLR's
    /// <c>StartIndex</c> (which counts every character of the raw stream, including <c>\r</c>).
    /// Out-of-range positions clamp to the end of the document.
    /// </summary>
    internal static int OffsetOf(string source, int line, int character)
    {
        var offset = 0;
        var currentLine = 0;
        while (currentLine < line && offset < source.Length)
        {
            if (source[offset] == '\n')
            {
                currentLine++;
            }

            offset++;
        }

        // Advance `character` columns within the target line, stopping at a line break / EOF.
        var col = 0;
        while (col < character && offset < source.Length && source[offset] != '\n')
        {
            offset++;
            col++;
        }

        return offset;
    }

    public HoverResult? HoverAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
        {
            return null;
        }

        var markdown = new WorkspaceIndex(documents).ResolveHover(activeUri, name, ctx.EnclosingTypeName);
        return markdown is null ? null : new HoverResult(markdown);
    }

    public DefinitionResult? DefinitionAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
        {
            return null;
        }

        var offset = OffsetOf(source, line, character);
        var loc = new WorkspaceIndex(documents).ResolveDefinition(activeUri, name, ctx.EnclosingTypeName, offset);
        return loc is null ? null : new DefinitionResult(loc.Uri, loc.Span);
    }

    /// <summary>
    /// The hierarchical symbol outline of one document (context &gt; type &gt; members).
    /// Returns an empty list when the document does not parse (no model, no spans).
    /// </summary>
    public IReadOnlyList<DocumentSymbol> DocumentSymbols(string source)
    {
        var (model, _) = _compiler.Parse(source);
        if (model is null)
        {
            return [];
        }

        var contexts = new List<DocumentSymbol>();
        foreach (var ctx in model.Contexts)
        {
            var children = new List<DocumentSymbol>();
            foreach (var t in ctx.Types)
            {
                children.Add(SymbolForType(t));
            }

            foreach (var svc in ctx.Services)
            {
                children.Add(SymbolForService(svc));
            }

            foreach (var spec in ctx.Specs)
            {
                if (spec.Span != SourceSpan.None)
                {
                    children.Add(new DocumentSymbol(spec.Name, SymbolKind.Method, spec.Span, spec.NameSpan, []));
                }
            }

            contexts.Add(new DocumentSymbol(ctx.Name, SymbolKind.Namespace, ctx.Span, ctx.NameSpan, children));
        }
        return contexts;
    }

    private static DocumentSymbol SymbolForType(TypeDecl t)
    {
        var children = new List<DocumentSymbol>();
        switch (t)
        {
            case ValueObjectDecl v:
                AddMembers(children, v.Members);
                break;
            case EntityDecl e:
                AddMembers(children, e.Members);
                foreach (var c in e.Commands)
                {
                    if (c.Span != SourceSpan.None)
                    {
                        children.Add(new DocumentSymbol(c.Name, SymbolKind.Method, c.Span, c.NameSpan, []));
                    }
                }

                foreach (var f in e.Factories)
                {
                    if (f.Span != SourceSpan.None)
                    {
                        children.Add(new DocumentSymbol(f.Name, SymbolKind.Constructor, f.Span, f.NameSpan, []));
                    }
                }

                break;
            case EventDecl ev:
                AddMembers(children, ev.Members);
                break;
            case IntegrationEventDecl ie:
                AddMembers(children, ie.Members);
                break;
            case EnumDecl en:
                foreach (var m in en.Members)
                {
                    if (m.Span != SourceSpan.None)
                    {
                        children.Add(new DocumentSymbol(m.Name, SymbolKind.EnumMember, m.Span, m.NameSpan, []));
                    }
                }

                break;
            case AggregateDecl agg:
                foreach (var nested in agg.Types)
                {
                    children.Add(SymbolForType(nested));
                }

                break;
        }
        return new DocumentSymbol(t.Name, SymbolKindOf(t), t.Span, t.NameSpan, children);
    }

    private static DocumentSymbol SymbolForService(ServiceDecl svc)
    {
        var children = new List<DocumentSymbol>();
        foreach (var op in svc.Operations)
        {
            if (op.Span != SourceSpan.None)
            {
                children.Add(new DocumentSymbol(op.Name, SymbolKind.Method, op.Span, op.NameSpan, []));
            }
        }

        foreach (var uc in svc.UseCases)
        {
            if (uc.Span != SourceSpan.None)
            {
                children.Add(new DocumentSymbol(uc.Name, SymbolKind.Method, uc.Span, uc.NameSpan, []));
            }
        }

        return new DocumentSymbol(svc.Name, SymbolKind.Interface, svc.Span, svc.NameSpan, children);
    }

    private static void AddMembers(List<DocumentSymbol> children, IReadOnlyList<Member> members)
    {
        foreach (var m in members)
        {
            if (m.Span != SourceSpan.None)
            {
                children.Add(new DocumentSymbol(m.Name, SymbolKind.Field, m.Span, m.NameSpan, []));
            }
        }
    }

    private static SymbolKind SymbolKindOf(TypeDecl t) => t switch
    {
        EnumDecl => SymbolKind.Enum,
        EntityDecl => SymbolKind.Class,
        AggregateDecl => SymbolKind.Class,
        EventDecl or IntegrationEventDecl => SymbolKind.Struct,
        _ => SymbolKind.Class,
    };

    /// <summary>
    /// Every reference to the name under the cursor, across the workspace (declaration
    /// included). Empty when the cursor is not on a renameable type/enum-member/spec name.
    /// </summary>
    public IReadOnlyList<Reference> ReferencesAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return [];
        }

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
        {
            return [];
        }

        var offset = OffsetOf(source, line, character);
        return new WorkspaceIndex(documents).FindReferences(activeUri, name, offset, ctx.EnclosingTypeName);
    }

    /// <summary>
    /// Computes the edits for renaming the name under the cursor to <paramref name="newName"/>:
    /// every reference across the workspace. Returns null when the cursor is not on a
    /// renameable name, the new name is not a valid identifier, or it is unchanged.
    /// </summary>
    public IReadOnlyList<Reference>? RenameAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character, string newName)
    {
        if (!WorkspaceIndex.IsValidIdentifier(newName))
        {
            return null;
        }

        if (!documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex || name == newName)
        {
            return null;
        }

        var offset = OffsetOf(source, line, character);
        var refs = new WorkspaceIndex(documents).FindReferences(activeUri, name, offset, ctx.EnclosingTypeName);
        return refs.Count == 0 ? null : refs;
    }

    /// <summary>
    /// The editable identifier range under the cursor — the LSP <c>prepareRename</c> answer.
    /// Returns the declaration/use occurrence at the cursor (a single-token <see cref="Reference"/>)
    /// when a rename would be valid there, or null when the cursor is inside a string/regex, not on a
    /// word token, or not on a renameable name (guarding exactly like <see cref="NameAt"/> /
    /// <see cref="RenameAt"/>). The returned range covers only the identifier under the cursor, so the
    /// editor pre-selects the right text.
    /// </summary>
    public Reference? PrepareRenameAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character);
        var current = ctx.CurrentToken;
        var name = current?.Text;
        if (current is null || string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
        {
            return null;
        }

        // Only offer a rename range where a rename would actually produce edits: resolve the
        // symbol under the cursor exactly as RenameAt does (offset + enclosing-type scope).
        var offset = OffsetOf(source, line, character);
        var refs = new WorkspaceIndex(documents).FindReferences(activeUri, name, offset, ctx.EnclosingTypeName);
        if (refs.Count == 0)
        {
            return null;
        }

        // The range is the identifier token under the cursor (current.Line is 1-based; columns 0-based).
        return new Reference(activeUri, current.Line, current.Column, current.Column + name.Length);
    }

    /// <summary>
    /// The refactors offered for the selection in the active document, spanning the 0-based LSP
    /// range <c>[startLine:startChar, endLine:endChar)</c>. Returns an empty list when the document
    /// is not open, does not parse, or no refactor applies at the selection. v1 offers
    /// "Extract value object" when the selection lands on contiguous member fields of a
    /// value/entity/event type (see <see cref="RefactorService"/>).
    /// </summary>
    public IReadOnlyList<CodeActionEdit> RefactorsAt(
        IReadOnlyDictionary<string, string> documents, string activeUri,
        int startLine, int startChar, int endLine, int endChar)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return [];
        }

        var startOffset = OffsetOf(source, startLine, startChar);
        var endOffset = OffsetOf(source, endLine, endChar);
        if (endOffset < startOffset)
        {
            (startOffset, endOffset) = (endOffset, startOffset);
        }

        return RefactorService.RefactorsFor(_compiler, source, startOffset, endOffset);
    }
}
