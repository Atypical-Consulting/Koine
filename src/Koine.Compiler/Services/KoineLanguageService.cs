using Antlr4.Runtime;
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

/// <summary>One parameter of a signature, with its display <see cref="Label"/> (e.g. <c>a: Decimal</c>).</summary>
public sealed record ParameterInfo(string Label);

/// <summary>
/// One callable signature for signature help: a full <see cref="Label"/> (e.g.
/// <c>place(a: Decimal, b: Decimal)</c>) and its ordered <see cref="Parameters"/>. Editor-agnostic.
/// </summary>
public sealed record SignatureInfo(string Label, IReadOnlyList<ParameterInfo> Parameters);

/// <summary>
/// A signature-help answer: the resolved <see cref="Signatures"/> (always one for Koine, which
/// has no overloads), the <see cref="ActiveSignature"/> index, and the <see cref="ActiveParameter"/>
/// the cursor sits on (the count of top-level commas between the call's <c>(</c> and the cursor).
/// Editor-agnostic; the LSP/WASM shells map it to an LSP SignatureHelp.
/// </summary>
public sealed record SignatureHelp(
    IReadOnlyList<SignatureInfo> Signatures,
    int ActiveSignature,
    int ActiveParameter);

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
/// One flat workspace-wide symbol: a declaration's <see cref="Name"/> and <see cref="Kind"/>,
/// the <see cref="Uri"/> of the file it lives in, its identifier <see cref="Range"/> (the LSP
/// <c>location.range</c>), and the name of its containing declaration (<see cref="ContainerName"/> —
/// a type's container is its context, a member's container is its type). Editor-agnostic; the LSP /
/// WASM shells map it to an LSP <c>SymbolInformation</c>.
/// </summary>
public sealed record WorkspaceSymbol(
    string Name,
    SymbolKind Kind,
    string Uri,
    SourceSpan Range,
    string? ContainerName);

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
    /// Overload of <see cref="NameAt(IReadOnlyDictionary{string,string},string,int,int)"/> that
    /// reads the active document's source text from a held <see cref="KoineCompilation"/> snapshot.
    /// </summary>
    public string? NameAt(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
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

    public HoverResult? HoverAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character) =>
        HoverAt(ToCompilation(documents), activeUri, line, character);

    /// <summary>
    /// Overload of <see cref="HoverAt(IReadOnlyDictionary{string,string},string,int,int)"/> that
    /// uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests.
    /// </summary>
    public HoverResult? HoverAt(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
        {
            return null;
        }

        var markdown = compilation.WorkspaceIndex.ResolveHover(activeUri, name, ctx.EnclosingTypeName);
        return markdown is null ? null : new HoverResult(markdown);
    }

    public DefinitionResult? DefinitionAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character) =>
        DefinitionAt(ToCompilation(documents), activeUri, line, character);

    /// <summary>
    /// Overload of <see cref="DefinitionAt(IReadOnlyDictionary{string,string},string,int,int)"/> that
    /// uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests.
    /// </summary>
    public DefinitionResult? DefinitionAt(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
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
        var loc = compilation.WorkspaceIndex.ResolveDefinition(activeUri, name, ctx.EnclosingTypeName, offset);
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
    /// A flat, workspace-wide symbol search — the LSP <c>workspace/symbol</c> answer. Flattens
    /// the <see cref="DocumentSymbols(string)"/> outline of every document, recording each symbol's
    /// containing parent name (a type's container is its context, a member's container is its type),
    /// then keeps only those whose name <paramref name="query"/>-subsequence-matches (case-insensitive,
    /// like an IDE fuzzy filter). An empty <paramref name="query"/> returns every declaration.
    /// </summary>
    public IReadOnlyList<WorkspaceSymbol> WorkspaceSymbols(IReadOnlyDictionary<string, string> documents, string query)
    {
        var results = new List<WorkspaceSymbol>();
        foreach (var (uri, source) in documents)
        {
            foreach (var top in DocumentSymbols(source))
            {
                FlattenSymbol(results, uri, top, container: null, query);
            }
        }

        return results;
    }

    private static void FlattenSymbol(
        List<WorkspaceSymbol> results,
        string uri,
        DocumentSymbol symbol,
        string? container,
        string query)
    {
        if (IsSubsequence(query, symbol.Name))
        {
            // Use the identifier span (selectionRange) as the location; fall back to the full range.
            var range = symbol.SelectionRange.IsNone ? symbol.Range : symbol.SelectionRange;
            results.Add(new WorkspaceSymbol(symbol.Name, symbol.Kind, uri, range, container));
        }

        foreach (var child in symbol.Children)
        {
            FlattenSymbol(results, uri, child, symbol.Name, query);
        }
    }

    /// <summary>
    /// Case-insensitive subsequence match: every character of <paramref name="query"/> appears in
    /// <paramref name="text"/> in order (not necessarily contiguous). An empty query matches anything.
    /// </summary>
    private static bool IsSubsequence(string query, string text)
    {
        if (string.IsNullOrEmpty(query))
        {
            return true;
        }

        var qi = 0;
        foreach (var c in text)
        {
            if (char.ToLowerInvariant(c) == char.ToLowerInvariant(query[qi]))
            {
                qi++;
                if (qi == query.Length)
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>
    /// Every reference to the name under the cursor, across the workspace (declaration
    /// included). Empty when the cursor is not on a renameable type/enum-member/spec name.
    /// </summary>
    public IReadOnlyList<Reference> ReferencesAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character) =>
        ReferencesAt(ToCompilation(documents), activeUri, line, character);

    /// <summary>
    /// Overload of <see cref="ReferencesAt(IReadOnlyDictionary{string,string},string,int,int)"/> that
    /// uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests.
    /// </summary>
    public IReadOnlyList<Reference> ReferencesAt(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
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
        return compilation.WorkspaceIndex.FindReferences(activeUri, name, offset, ctx.EnclosingTypeName);
    }

    /// <summary>
    /// Computes the edits for renaming the name under the cursor to <paramref name="newName"/>:
    /// every reference across the workspace. Returns null when the cursor is not on a
    /// renameable name, the new name is not a valid identifier, or it is unchanged.
    /// </summary>
    public IReadOnlyList<Reference>? RenameAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character, string newName) =>
        RenameAt(ToCompilation(documents), activeUri, line, character, newName);

    /// <summary>
    /// Overload of <see cref="RenameAt(IReadOnlyDictionary{string,string},string,int,int,string)"/> that
    /// uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests.
    /// </summary>
    public IReadOnlyList<Reference>? RenameAt(KoineCompilation compilation, string activeUri, int line, int character, string newName)
    {
        if (!WorkspaceIndex.IsValidIdentifier(newName))
        {
            return null;
        }

        if (!compilation.Documents.TryGetValue(activeUri, out var source))
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
        var refs = compilation.WorkspaceIndex.FindReferences(activeUri, name, offset, ctx.EnclosingTypeName);
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
    public Reference? PrepareRenameAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character) =>
        PrepareRenameAt(ToCompilation(documents), activeUri, line, character);

    /// <summary>
    /// Overload of <see cref="PrepareRenameAt(IReadOnlyDictionary{string,string},string,int,int)"/> that
    /// uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests.
    /// </summary>
    public Reference? PrepareRenameAt(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
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
        var refs = compilation.WorkspaceIndex.FindReferences(activeUri, name, offset, ctx.EnclosingTypeName);
        if (refs.Count == 0)
        {
            return null;
        }

        // The range is the identifier token under the cursor (current.Line is 1-based; columns 0-based).
        return new Reference(activeUri, current.Line, current.Column, current.Column + name.Length);
    }

    /// <summary>
    /// Converts a <c>uri → source</c> document map to a <see cref="KoineCompilation"/> for
    /// the delegation path of the existing documents-based overloads. This is a fresh (non-cached)
    /// compilation per call, which preserves today's behavior for the WASM/CLI callers that pass a
    /// fresh documents map on every request.
    /// </summary>
    private static KoineCompilation ToCompilation(IReadOnlyDictionary<string, string> documents) =>
        KoineCompilation.Create(
            documents.Select(kv => new SourceFile(kv.Key, kv.Value)).ToList());

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

    /// <summary>
    /// Signature help for the call enclosing the cursor. Walks back from the cursor to the nearest
    /// UNCLOSED <c>(</c>, resolves the identifier immediately before it to a command/factory on an
    /// entity, or an operation/use-case on a service, and reports that declaration's parameter list
    /// plus the active parameter (the count of top-level commas between the <c>(</c> and the cursor).
    /// Returns null when the document is not open, the cursor is in a string/regex, there is no
    /// enclosing open call, or the callee does not resolve to a parameterized declaration.
    /// </summary>
    public SignatureHelp? SignatureHelpAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character);
        if (ctx.InsideStringOrRegex)
        {
            return null;
        }

        // Lex the document and keep the default-channel tokens up to the cursor offset.
        var cursorOffset = OffsetOf(source, line, character);
        var tokens = DefaultChannelTokensBefore(source, cursorOffset);

        // Walk back to the nearest unclosed '(' (balancing nested parens), counting the
        // top-level commas seen between that '(' and the cursor — that count is the active parameter.
        var depth = 0;
        var activeParameter = 0;
        var openIndex = -1;
        for (var i = tokens.Count - 1; i >= 0; i--)
        {
            var type = tokens[i].Type;
            if (type == KoineLexer.RPAREN)
            {
                depth++;
            }
            else if (type == KoineLexer.LPAREN)
            {
                if (depth == 0)
                {
                    openIndex = i;
                    break;
                }

                depth--;
            }
            else if (type == KoineLexer.COMMA && depth == 0)
            {
                activeParameter++;
            }
        }

        if (openIndex <= 0)
        {
            return null;
        }

        // The callee is the identifier immediately before the '('.
        var callee = tokens[openIndex - 1];
        if (!IsWordToken(callee))
        {
            return null;
        }

        var (model, _) = _compiler.Parse(source);
        if (model is null)
        {
            return null;
        }

        var index = new ModelIndex(model);
        var parameters = ResolveCalleeParameters(index, callee.Text);
        if (parameters is null)
        {
            return null;
        }

        var paramInfos = parameters
            .Select(p => new ParameterInfo($"{p.Name}: {RenderType(p.Type)}"))
            .ToList();
        var label = $"{callee.Text}({string.Join(", ", paramInfos.Select(p => p.Label))})";
        return new SignatureHelp([new SignatureInfo(label, paramInfos)], 0, activeParameter);
    }

    /// <summary>
    /// Resolves a callee name to the parameter list of the entity command/factory or service
    /// operation/use-case that declares it, using the same enumeration shape as
    /// <see cref="SemanticTokenProvider"/>. Returns null when no parameterized declaration matches.
    /// </summary>
    private static IReadOnlyList<Param>? ResolveCalleeParameters(ModelIndex index, string callee)
    {
        foreach (var t in index.AllTypes())
        {
            if (t is EntityDecl e)
            {
                foreach (var c in e.Commands)
                {
                    if (c.Name == callee)
                    {
                        return c.Parameters;
                    }
                }

                foreach (var f in e.Factories)
                {
                    if (f.Name == callee)
                    {
                        return f.Parameters;
                    }
                }
            }
        }

        foreach (var ctx in index.Model.Contexts)
        {
            foreach (var svc in ctx.Services)
            {
                foreach (var op in svc.Operations)
                {
                    if (op.Name == callee)
                    {
                        return op.Parameters;
                    }
                }

                foreach (var uc in svc.UseCases)
                {
                    if (uc.Name == callee)
                    {
                        return uc.Parameters;
                    }
                }
            }
        }

        return null;
    }

    /// <summary>
    /// The default-channel tokens whose start offset is strictly before <paramref name="cursorOffset"/>.
    /// Lexer-only (tolerant of broken documents), matching <see cref="TokenLocator"/>'s approach.
    /// </summary>
    private static List<IToken> DefaultChannelTokensBefore(string source, int cursorOffset)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();
        var stream = new CommonTokenStream(lexer);
        stream.Fill();

        var result = new List<IToken>();
        foreach (IToken t in stream.GetTokens())
        {
            if (t.Type == TokenConstants.EOF || t.Channel != TokenConstants.DefaultChannel)
            {
                continue;
            }

            if (t.StartIndex >= cursorOffset)
            {
                break;
            }

            result.Add(t);
        }

        return result;
    }

    private static bool IsWordToken(IToken t)
    {
        if (t.Type == KoineLexer.Identifier)
        {
            return true;
        }

        var s = t.Text;
        return !string.IsNullOrEmpty(s) && (char.IsLetter(s[0]) || s[0] == '_');
    }
}
