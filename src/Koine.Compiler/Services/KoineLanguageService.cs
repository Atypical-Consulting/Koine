using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Services;

/// <summary>The kind of a completion item; the LSP shell maps these to LSP numbers.</summary>
public enum CompletionItemKind { Keyword, Class, Enum, EnumMember, Field, Property, Method }

/// <summary>
/// A single completion candidate, free of any LSP/JSON concepts. The trailing fields are
/// optional and additive so the many <c>new CompletionItem(label, kind, detail, doc)</c> call
/// sites keep compiling unchanged: <see cref="InsertText"/>/<see cref="InsertTextFormat"/> carry a
/// snippet body (format 2 = snippet, 1/<c>null</c> = plaintext); <see cref="CommitCharacters"/>
/// commit the item when typed; <see cref="SortText"/> orders the list (prefix matches before
/// non-prefix subsequence matches); <see cref="Data"/> is an opaque round-trip token for an LSP
/// <c>completionItem/resolve</c>.
/// </summary>
public sealed record CompletionItem(
    string Label,
    CompletionItemKind Kind,
    string? Detail,
    string? Documentation,
    string? InsertText = null,
    int? InsertTextFormat = null,
    IReadOnlyList<string>? CommitCharacters = null,
    string? SortText = null,
    string? Data = null);

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
/// One collapsible region: the <see cref="SourceSpan"/> of a multi-line block declaration
/// (context, type, service, aggregate, entity, enum, …). The span is 1-based and end-EXCLUSIVE;
/// the LSP/WASM shells convert it to a 0-based <c>{ startLine, endLine }</c> fold. Editor-agnostic.
/// </summary>
public sealed record FoldingRange(SourceSpan Range);

/// <summary>
/// One link in an LSP selection-range chain: the <see cref="Range"/> the editor expands to,
/// and the <see cref="Parent"/> range it grows into next (a strictly larger enclosing node),
/// innermost first. The span is 1-based and end-EXCLUSIVE. Editor-agnostic; the LSP/WASM shells
/// map the chain to nested <c>{ range, parent? }</c> objects.
/// </summary>
public sealed record SelectionRange(SourceSpan Range, SelectionRange? Parent);

/// <summary>
/// One editor code lens: the <see cref="Range"/> it annotates (a declaration's identifier
/// <c>NameSpan</c>, 1-based end-EXCLUSIVE), the declaration <see cref="Name"/> and the
/// <see cref="Uri"/> of the file it lives in, plus the resolved <see cref="Title"/> — the
/// reference-count label (<c>"N references"</c>, references-from-elsewhere = total references
/// minus the declaration itself). The title may be filled lazily over an LSP
/// <c>codeLens/resolve</c> round-trip, so it is nullable. Editor-agnostic.
/// </summary>
public sealed record CodeLens(
    string Name,
    string Uri,
    SourceSpan Range,
    string? Title);

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

        // Member access (`receiver.`) almost always sits in a doc that doesn't parse yet —
        // the dangling '.' is a syntax error. Even when the whole doc DID parse, a syntax error
        // ELSEWHERE can leave the model partial. Repair the dangling '.' by inserting a
        // placeholder member name at the cursor and re-parsing, so the receiver's type still
        // binds; prefer the repaired model (it recovers the most declarations).
        if (ctx.PrecedingToken?.Type == KoineLexer.DOT)
        {
            var (repaired, _) = _compiler.Parse(InsertPlaceholder(source, line, character));
            if (repaired is not null)
            {
                model = repaired;
            }
        }

        var semantic = model is null ? null : new SemanticModel(model);
        var index = semantic?.Index;

        var items = CandidatesFor(ctx, semantic, index, source, line, character);
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

    private IReadOnlyList<CompletionItem> CandidatesFor(
        TokenContext ctx, SemanticModel? semantic, ModelIndex? index, string source, int line, int character)
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
            return DotCandidates(ctx, semantic, index, source, line, character);
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
            return Starters(StartersFor(ctx.EnclosingKeyword));
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
    /// Members offered after <c>receiver.</c>. The receiver immediately before the '.' may be a
    /// single token or a multi-hop chain (<c>order.line.</c>). Resolution is binder-first:
    /// the receiver chain is reconstructed as an <see cref="Expr"/> and typed through
    /// <see cref="SemanticModel.GetTypeInfo"/> against a <see cref="TypeScope"/> of the enclosing
    /// type's members (R13.2 context-scoped), so it survives a placeholder-repaired broken document
    /// AND multi-hops. When the binder cannot determine the receiver type, it falls back to the flat
    /// <see cref="ModelIndex"/> single-hop resolution (enum type / declared type / enclosing field),
    /// so existing behaviour never regresses. Returns nothing when nothing resolves — never guesses.
    /// </summary>
    private IReadOnlyList<CompletionItem> DotCandidates(
        TokenContext ctx, SemanticModel? semantic, ModelIndex? index, string source, int line, int character)
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

        // 1. `EnumType.` -> its members (a static enum reference, not a value).
        if (index.IsEnumType(receiver) && index.TryGetDecl(receiver, out var ed) && ed is EnumDecl en)
        {
            return en.Members
                .Select(m => new CompletionItem(m.Name, CompletionItemKind.EnumMember, receiver, m.Doc))
                .ToList();
        }

        // 2. Binder route: reconstruct the receiver chain (`a.b.c`) up to the trailing '.', type it
        //    through the SemanticModel, and offer the resolved type's members. This handles the
        //    multi-hop and broken-doc cases the flat ModelIndex can't.
        if (semantic is not null
            && BinderReceiverMembers(ctx, semantic, source, line, character) is { Count: > 0 } bound)
        {
            return bound;
        }

        // 3. Fallback — `Type.` where the receiver is itself a declared value/entity type name.
        if (index.IsKnownType(receiver) && MembersOf(index, receiver) is { Count: > 0 } directMembers)
        {
            return directMembers;
        }

        // 4. Fallback — `field.` where the receiver is a field of the enclosing fielded type:
        //    resolve the field's declared type and offer ITS members.
        if (ctx.EnclosingTypeName is { } scopeType
            && index.TryGetMemberType(scopeType, receiver, out var fieldType)
            && MembersOf(index, fieldType.Name) is { Count: > 0 } members)
        {
            return members;
        }

        return [];
    }

    /// <summary>
    /// The members of the type the receiver chain (everything up to the trailing '.') resolves to,
    /// via the binder. Builds the chain from the default-channel tokens immediately before the '.',
    /// constructs an <see cref="Expr"/> (an <see cref="IdentifierExpr"/> root threaded through
    /// <see cref="MemberAccessExpr"/> hops), and types it in a <see cref="TypeScope"/> of the
    /// enclosing fielded type's members, resolving from that type's bounded context (R13.2). Returns
    /// an empty list when there is no enclosing type, the chain doesn't reconstruct, or the receiver
    /// types to <see cref="ErrorType"/>.
    /// </summary>
    private static IReadOnlyList<CompletionItem> BinderReceiverMembers(
        TokenContext ctx, SemanticModel semantic, string source, int line, int character)
    {
        if (ctx.EnclosingTypeName is not { } scopeType
            || semantic.Index.TryGetDecl(scopeType, out var scopeDecl) is false)
        {
            return [];
        }

        var members = MembersOfDecl(scopeDecl);
        if (members is null)
        {
            return [];
        }

        var chain = ReceiverChainBeforeDot(source, line, character);
        if (chain.Count == 0)
        {
            return [];
        }

        Expr expr = new IdentifierExpr(chain[0]);
        for (var i = 1; i < chain.Count; i++)
        {
            expr = new MemberAccessExpr(expr, chain[i]);
        }

        var scope = TypeScope.FromMembers(members, semantic.Index);
        var context = ContextOf(semantic, scopeType);
        var type = semantic.GetTypeInfo(expr, scope, context);
        if (type.IsError || type.Name is not { } typeName)
        {
            return [];
        }

        return BinderMembersOf(semantic, typeName);
    }

    /// <summary>
    /// The default-channel identifier tokens forming the receiver chain immediately before the
    /// trailing '.' at the cursor (e.g. <c>order . line .</c> -> <c>["order","line"]</c>). Walks the
    /// lexer tokens back from the '.' nearest the cursor, alternating <c>IDENT . IDENT . …</c>;
    /// stops at the first non-identifier/non-dot boundary. Empty when no identifier precedes the '.'.
    /// </summary>
    private static IReadOnlyList<string> ReceiverChainBeforeDot(string source, int line, int character)
    {
        var cursorOffset = OffsetOf(source, line, character);
        var tokens = DefaultChannelTokensBefore(source, cursorOffset);

        // The token immediately before the cursor must be the trailing '.'.
        if (tokens.Count == 0 || tokens[^1].Type != KoineLexer.DOT)
        {
            return [];
        }

        var chain = new List<string>();
        var expectIdentifier = true; // moving backwards: '.' then IDENT then '.' then IDENT …
        for (var i = tokens.Count - 2; i >= 0; i--) // skip the trailing '.'
        {
            var t = tokens[i];
            if (expectIdentifier)
            {
                if (!IsWordToken(t))
                {
                    break;
                }

                chain.Add(t.Text);
                expectIdentifier = false;
            }
            else
            {
                if (t.Type != KoineLexer.DOT)
                {
                    break;
                }

                expectIdentifier = true;
            }
        }

        chain.Reverse(); // collected right-to-left
        return chain;
    }

    /// <summary>The fields of a value/entity declaration usable as an in-scope name set, else null.</summary>
    private static IReadOnlyList<Member>? MembersOfDecl(TypeDecl decl) => decl switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        _ => null,
    };

    /// <summary>The bounded context that declares <paramref name="typeName"/> (for R13.2 scoping), or null.</summary>
    private static string? ContextOf(SemanticModel semantic, string typeName)
    {
        foreach (var ctx in semantic.Model.Contexts)
        {
            foreach (var t in ctx.Types)
            {
                if (t.Name == typeName)
                {
                    return ctx.Name;
                }
            }
        }

        return null;
    }

    /// <summary>The member completions of the type the binder resolved the receiver to.</summary>
    private static IReadOnlyList<CompletionItem> BinderMembersOf(SemanticModel semantic, string typeName) =>
        MembersOf(semantic.Index, typeName);

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

    /// <summary>
    /// Declaration-start completions: each starter keyword as a SNIPPET (LSP
    /// <c>insertTextFormat = 2</c>) that scaffolds its idiomatic body with tab-stop placeholders
    /// (e.g. <c>entity ${1:Name} {\n\t$0\n}</c>), so accepting it lays down a ready-to-fill block.
    /// Keywords with no block body (e.g. <c>import</c>) fall back to a plain identifier snippet.
    /// </summary>
    private static IReadOnlyList<CompletionItem> Starters(string[] names) =>
        names.Select(n => new CompletionItem(
            n, CompletionItemKind.Keyword, "keyword", null,
            InsertText: SnippetFor(n),
            InsertTextFormat: 2)).ToList();

    /// <summary>The snippet body for a declaration starter keyword (LSP snippet syntax).</summary>
    private static string SnippetFor(string keyword) => keyword switch
    {
        "context" or "module" => keyword + " ${1:Name} {\n\t$0\n}",
        "value" or "quantity" or "enum" or "event" or "service" or "policy" or "readmodel" or "aggregate" =>
            keyword + " ${1:Name} {\n\t$0\n}",
        "entity" => "entity ${1:Name} identified by ${2:Id} {\n\t$0\n}",
        "spec" => "spec ${1:Name} on ${2:Type} = $0",
        "query" => "query ${1:Name} { $0 }",
        "import" => "import ${1:Type} from ${2:Context}",
        "contextmap" => "contextmap {\n\t$0\n}",
        "invariant" => "invariant $0",
        "command" => "command ${1:Name}($2) { $0 }",
        "create" => "create ${1:Name}($2) { $0 }",
        "states" => "states ${1:Field} {\n\t$0\n}",
        "operation" => "operation ${1:Name}($2): ${3:Result}",
        "usecase" => "usecase ${1:Name}($2): ${3:Result}",
        "operations" => "operations {\n\t$0\n}",
        "find" => "find ${1:Name}($2): ${3:Result}",
        "repository" => "repository {\n\t$0\n}",
        _ => keyword + " $0",
    };

    private static IReadOnlyList<CompletionItem> Filter(IReadOnlyList<CompletionItem> items, string partial)
    {
        if (partial.Length == 0)
        {
            return items;
        }

        // SUBSEQUENCE match (like an IDE fuzzy filter): every character of `partial` appears in the
        // label in order, not necessarily contiguous. A prefix match outranks a non-prefix
        // subsequence match via SortText ("0"+label before "1"+label), so the editor lists the
        // tightest matches first while still surfacing fuzzy hits.
        var matched = new List<CompletionItem>();
        foreach (var item in items)
        {
            if (!SubsequenceMatches(partial, item.Label))
            {
                continue;
            }

            var isPrefix = item.Label.StartsWith(partial, StringComparison.OrdinalIgnoreCase);
            var sort = (isPrefix ? "0" : "1") + item.Label;
            matched.Add(item with { SortText = sort });
        }

        return matched; // empty list when nothing matches, by design
    }

    /// <summary>
    /// Case-insensitive subsequence match: every character of <paramref name="query"/> appears in
    /// <paramref name="text"/> in order (not necessarily contiguous). An empty query matches anything.
    /// </summary>
    private static bool SubsequenceMatches(string query, string text)
    {
        if (query.Length == 0)
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

    /// <summary>
    /// The collapsible regions of one document — one <see cref="FoldingRange"/> per multi-line
    /// block declaration (context, type, service, member-bearing entity, enum, aggregate, …).
    /// Derived from the <see cref="DocumentSymbols(string)"/> outline: any symbol whose full
    /// <see cref="DocumentSymbol.Range"/> covers more than one line is foldable. Returns an empty
    /// list when the document does not parse.
    /// </summary>
    public IReadOnlyList<FoldingRange> FoldingRanges(string source)
    {
        var folds = new List<FoldingRange>();
        foreach (var top in DocumentSymbols(source))
        {
            CollectFolds(folds, top);
        }

        return folds;
    }

    private static void CollectFolds(List<FoldingRange> folds, DocumentSymbol symbol)
    {
        var range = symbol.Range;
        // A "multi-line block node" is a positioned node whose declaration spans >1 source line.
        if (!range.IsNone && range.EndLine > range.Line)
        {
            folds.Add(new FoldingRange(range));
        }

        foreach (var child in symbol.Children)
        {
            CollectFolds(folds, child);
        }
    }

    /// <summary>
    /// The selection-range chain at a 0-based LSP <paramref name="line"/>/<paramref name="character"/>:
    /// the innermost positioned node under the cursor, then each enclosing ancestor with a real span,
    /// linked innermost-first (each <see cref="SelectionRange.Parent"/> strictly contains its child).
    /// Returns <c>null</c> when the document does not parse or no node sits under the cursor.
    /// </summary>
    public SelectionRange? SelectionRangeAt(string source, int line, int character)
    {
        var (model, _) = _compiler.Parse(source);
        if (model is null)
        {
            return null;
        }

        var semantic = new SemanticModel(model);
        var offset = OffsetOf(source, line, character);

        // Gather every positioned node whose span contains the offset. The SyntaxGraph parent
        // chain alone can skip intermediate declarations (e.g. an entity is not the graph-parent of
        // its members), so we also fold in the DocumentSymbols outline — which nests
        // member ⊂ type ⊂ context by span — and rank the union by containment (innermost first).
        var (pl, pc) = OffsetToLineColumn(source, offset);
        var spans = new List<SourceSpan>();

        void Consider(SourceSpan span)
        {
            if (!span.IsNone && Contains(span, pl, pc))
            {
                spans.Add(span);
            }
        }

        if (semantic.NodeAt(offset) is { } node)
        {
            foreach (var n in semantic.AncestorsAndSelf(node))
            {
                Consider(n.Span);
            }
        }

        foreach (var top in DocumentSymbols(source))
        {
            CollectContainingSymbolSpans(top, pl, pc, spans);
        }

        if (spans.Count == 0)
        {
            return null;
        }

        // Innermost-first: smaller spans before the larger spans that contain them. De-duplicate so
        // the same declaration does not appear twice (graph + outline), then chain so each parent
        // strictly contains its child.
        spans.Sort((a, b) => SpanSize(a).CompareTo(SpanSize(b)));

        SelectionRange? chain = null;
        var ordered = new List<SourceSpan>();
        foreach (var span in spans)
        {
            if (ordered.Count == 0 || StrictlyContains(span, ordered[^1]))
            {
                ordered.Add(span);
            }
        }

        for (var i = ordered.Count - 1; i >= 0; i--)
        {
            chain = new SelectionRange(ordered[i], chain);
        }

        return chain;
    }

    private static void CollectContainingSymbolSpans(DocumentSymbol symbol, int line, int column, List<SourceSpan> spans)
    {
        if (!symbol.Range.IsNone && Contains(symbol.Range, line, column))
        {
            spans.Add(symbol.Range);
        }

        if (!symbol.SelectionRange.IsNone && Contains(symbol.SelectionRange, line, column))
        {
            spans.Add(symbol.SelectionRange);
        }

        foreach (var child in symbol.Children)
        {
            CollectContainingSymbolSpans(child, line, column, spans);
        }
    }

    /// <summary>True when the 1-based <paramref name="line"/>/<paramref name="column"/> point falls
    /// inside <paramref name="span"/> (end-EXCLUSIVE, matching <see cref="SourceSpan"/>).</summary>
    private static bool Contains(SourceSpan span, int line, int column)
    {
        var afterStart = line > span.Line || (line == span.Line && column >= span.Column);
        var beforeEnd = line < span.EndLine || (line == span.EndLine && column < span.EndColumn);
        return afterStart && beforeEnd;
    }

    /// <summary>A monotone size proxy for a span (line-weighted) used only to order nested spans.</summary>
    private static long SpanSize(SourceSpan span) =>
        ((long)(span.EndLine - span.Line) << 20) + (span.EndColumn - span.Column);

    /// <summary>The 1-based line/column of a 0-based absolute <paramref name="offset"/> in <paramref name="source"/>.</summary>
    private static (int Line, int Column) OffsetToLineColumn(string source, int offset)
    {
        var line = 1;
        var column = 1;
        var end = Math.Min(offset, source.Length);
        for (var i = 0; i < end; i++)
        {
            if (source[i] == '\n')
            {
                line++;
                column = 1;
            }
            else
            {
                column++;
            }
        }

        return (line, column);
    }

    /// <summary>
    /// True when <paramref name="outer"/> contains <paramref name="inner"/> and is strictly larger on
    /// at least one bound (so the two are not the same range). Bounds are 1-based, end-EXCLUSIVE.
    /// </summary>
    private static bool StrictlyContains(SourceSpan outer, SourceSpan inner)
    {
        var startsBeforeOrEqual =
            outer.Line < inner.Line || (outer.Line == inner.Line && outer.Column <= inner.Column);
        var endsAfterOrEqual =
            outer.EndLine > inner.EndLine || (outer.EndLine == inner.EndLine && outer.EndColumn >= inner.EndColumn);
        var strict =
            outer.Line < inner.Line || outer.Column < inner.Column
            || outer.EndLine > inner.EndLine || outer.EndColumn > inner.EndColumn;
        return startsBeforeOrEqual && endsAfterOrEqual && strict;
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
    /// The code lenses of the active document — one per top-level declaration (type / service /
    /// spec) in its outline, annotated with a reference-count label. The count is
    /// references-from-elsewhere: <see cref="WorkspaceIndex.FindReferences"/> includes the
    /// declaration's own name occurrence, so the label is <c>total - 1</c> (clamped at 0). Each
    /// lens sits on the declaration's identifier <c>NameSpan</c> (its <c>SelectionRange</c>).
    /// Returns an empty list when the active document is absent or does not parse.
    /// </summary>
    public IReadOnlyList<CodeLens> CodeLenses(IReadOnlyDictionary<string, string> documents, string activeUri) =>
        CodeLenses(ToCompilation(documents), activeUri);

    /// <summary>
    /// Overload of <see cref="CodeLenses(IReadOnlyDictionary{string,string},string)"/> that uses a
    /// held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller holds and
    /// reuses the same compilation across multiple requests.
    /// </summary>
    public IReadOnlyList<CodeLens> CodeLenses(KoineCompilation compilation, string activeUri)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
        {
            return [];
        }

        var lenses = new List<CodeLens>();
        foreach (var top in DocumentSymbols(source))
        {
            // Top-level declarations live one level under the context node; the context itself
            // carries no reference lens. Members are not lensed (they are file-/type-scoped).
            foreach (var decl in top.Children)
            {
                var nameSpan = decl.SelectionRange.IsNone ? decl.Range : decl.SelectionRange;
                if (nameSpan.IsNone)
                {
                    continue;
                }

                // Offset of the declaration's name so FindReferences scopes to the right symbol.
                // SelectionRange is 1-based; OffsetOf takes 0-based LSP line/character.
                var nameOffset = OffsetOf(source, nameSpan.Line - 1, nameSpan.Column - 1);
                var total = compilation.WorkspaceIndex.FindReferences(activeUri, decl.Name, nameOffset).Count;
                var n = Math.Max(0, total - 1); // subtract the declaration's own occurrence
                var title = $"{n} reference{(n == 1 ? "" : "s")}";
                lenses.Add(new CodeLens(decl.Name, activeUri, nameSpan, title));
            }
        }

        return lenses;
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
