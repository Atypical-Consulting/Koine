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

/// <summary>The kind of an inlay hint; the LSP shell maps these to LSP InlayHintKind numbers (1 = Type, 2 = Parameter).</summary>
public enum InlayHintKind { Type, Parameter }

/// <summary>
/// One editor inlay hint: a short label rendered inline at the 0-based LSP <see cref="Line"/>/
/// <see cref="Character"/> position. A <see cref="InlayHintKind.Type"/> hint shows an inferred
/// type (e.g. <c>": Money"</c>) just after a direct read-model field name; a
/// <see cref="InlayHintKind.Parameter"/> hint shows a callee's parameter name (e.g. <c>"qty:"</c>)
/// just before a positional call argument. Editor-agnostic; the LSP/WASM shells map it to an LSP
/// <c>InlayHint</c>.
/// </summary>
public sealed record InlayHint(int Line, int Character, string Label, InlayHintKind Kind);

/// <summary>The kind of a call-hierarchy item: a command on an entity, or a domain event.</summary>
public enum CallHierarchyItemKind { Command, Event }

/// <summary>
/// One node of the call hierarchy over the domain call graph (<c>command --emit--> event
/// --policy--> command</c>). A <see cref="CallHierarchyItemKind.Command"/> item is identified by
/// <c>(<see cref="OwningType"/>, <see cref="Name"/>)</c>; a <see cref="CallHierarchyItemKind.Event"/>
/// item by <see cref="Name"/> alone (its <see cref="OwningType"/> is <c>null</c>). The
/// <see cref="Uri"/> + 1-based <see cref="Span"/> point an editor at the declaration (the
/// <c>NameSpan</c>). Editor-agnostic; the LSP/WASM shells map it to an LSP
/// <c>CallHierarchyItem</c>.
/// </summary>
public sealed record CallHierarchyItem(string Name, CallHierarchyItemKind Kind, string? OwningType, string Uri, SourceSpan Span);

/// <summary>One incoming edge: the <see cref="From"/> item that calls into the prepared item.</summary>
public sealed record CallHierarchyIncomingCall(CallHierarchyItem From);

/// <summary>One outgoing edge: the <see cref="To"/> item the prepared item calls.</summary>
public sealed record CallHierarchyOutgoingCall(CallHierarchyItem To);

/// <summary>
/// The category of a type-hierarchy item — the kind of declared type a node refers to. DDD has no OO
/// inheritance, so this drives the editor's icon and the wire reconstruction blob, not a class lattice.
/// </summary>
public enum TypeHierarchyItemKind { Aggregate, Entity, Value, ReadModel, Enum, Event, Other }

/// <summary>
/// One node of the type hierarchy: a declared type, located at its declaration <c>NameSpan</c>
/// (<see cref="Uri"/> + 1-based <see cref="Span"/>). The hierarchy's edges are the model's declared
/// relationships — <i>supertypes</i> are the types a node points at (an entity/value's member + identity
/// types, a read model's <c>from</c> source, an aggregate's root), <i>subtypes</i> the inverse — not OO
/// inheritance (Koine has none). Editor-agnostic; the LSP/WASM shells map it to an LSP TypeHierarchyItem.
/// </summary>
public sealed record TypeHierarchyItem(string Name, TypeHierarchyItemKind Kind, string Uri, SourceSpan Span)
{
    /// <summary>
    /// The bounded context that declares this type (#389): a type's identity is <b>(context, name)</b>,
    /// since the same name may be declared in two contexts. The resolver fills it from the cursor's
    /// enclosing context on <c>prepare</c> and from the resolved declaration on the super/sub walks; the
    /// wire shells round-trip it through the opaque <c>data</c> blob so a request reconstructs <i>which</i>
    /// same-named type the item refers to. <c>null</c> when the context can't be determined (a recovered
    /// or partial parse), in which case resolution falls back to first-wins-by-name — never a regression
    /// for single-context models.
    /// </summary>
    public string? Context { get; init; }
}

/// <summary>
/// Editor-agnostic language services for <c>.koi</c>. <see cref="CompleteAt"/> is
/// single-file and lexer-only (works on broken documents). <see cref="HoverAt(IReadOnlyDictionary{string,string},string,int,int)"/> and
/// <see cref="DefinitionAt(IReadOnlyDictionary{string,string},string,int,int)"/> take a workspace document map (uri → source) plus the
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
    private static string? ContextOf(SemanticModel semantic, string typeName) =>
        // The canonical accessor flattens aggregate-nested types (which the old hand-rolled
        // Contexts→Types loop missed); first-match-wins is preserved via FirstOrDefault.
        semantic.Index.DeclaringContextsOf(typeName).FirstOrDefault();

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
            if (!IsSubsequence(partial, item.Label))
            {
                continue;
            }

            var isPrefix = item.Label.StartsWith(partial, StringComparison.OrdinalIgnoreCase);
            var sort = (isPrefix ? "0" : "1") + item.Label;
            matched.Add(item with { SortText = sort });
        }

        return matched; // empty list when nothing matches, by design
    }

    /// <summary>The identifier-like token text under the cursor, or null (whitespace, string, regex).</summary>
    public string? NameAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
        {
            return null;
        }

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
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

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
        return ctx.InsideStringOrRegex ? null : ctx.CurrentToken?.Text;
    }

    /// <summary>
    /// The 0-based absolute character offset of an LSP 0-based <paramref name="line"/>/
    /// <paramref name="character"/> in <paramref name="source"/>, matching ANTLR's
    /// <c>StartIndex</c> (which counts every character of the raw stream, including <c>\r</c>).
    /// Out-of-range positions clamp to the end of the document.
    /// </summary>
    public static int OffsetOf(string source, int line, int character)
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

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
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

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
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
        return model is null ? [] : DocumentSymbols(model);
    }

    /// <summary>
    /// The hierarchical symbol outline of an already-parsed model. Lets callers that hold a warm
    /// <see cref="KoineCompilation"/> snapshot (e.g. <see cref="CodeLenses(KoineCompilation,string)"/>)
    /// reuse the memoized model instead of re-parsing the source.
    /// </summary>
    private static IReadOnlyList<DocumentSymbol> DocumentSymbols(KoineModel model)
    {
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
        var (pl, pc) = SourceTextGeometry.LineColumn(source, offset);
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

    /// <summary>
    /// Snapshot-accepting overload of <see cref="WorkspaceSymbols(IReadOnlyDictionary{string,string},string)"/>
    /// (issue #464): delegates via the compilation's <see cref="KoineCompilation.Documents"/> map so the
    /// caller's already-reconciled snapshot is reused — no re-parse. Output is byte-identical to the
    /// <c>documents</c>-based overload for the same sources.
    /// </summary>
    public IReadOnlyList<WorkspaceSymbol> WorkspaceSymbols(KoineCompilation compilation, string query) =>
        WorkspaceSymbols(compilation.Documents, query);

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

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
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

        // Reuse the warm snapshot's memoized per-file model rather than re-parsing the source.
        var perFile = compilation.SemanticModelFor(activeUri)?.Model;
        var outline = perFile is null ? DocumentSymbols(source) : DocumentSymbols(perFile);

        var lenses = new List<CodeLens>();
        foreach (var top in outline)
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
    /// The parse/syntax tree of the ACTIVE buffer <paramref name="activeUri"/> — its per-file
    /// <see cref="SemanticModel.Model"/> root projected into a serializable
    /// <see cref="SyntaxTreeNode"/> tree by <see cref="SyntaxTreeProvider.Build"/> (the target-agnostic
    /// child walk, so a new node kind is projected for free). Uses the warm snapshot's memoized per-file
    /// model — no re-parse. Returns <c>null</c> when <paramref name="activeUri"/> is not a document in
    /// <paramref name="compilation"/> (an absent tree, never an exception), mirroring the LSP nullable
    /// contract of hover/definition. The single core seam both Studio hosts serialize: the browser
    /// <c>[JSExport] SyntaxTree</c> and the desktop <c>koine/syntaxTree</c> LSP request.
    /// </summary>
    public SyntaxTreeNode? SyntaxTree(KoineCompilation compilation, string activeUri)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source)
            || compilation.SemanticModelFor(activeUri) is not { } semantic)
        {
            return null;
        }

        return SyntaxTreeProvider.Build(semantic.Model, source);
    }

    /// <summary>
    /// The inlay hints for the active document within the 0-based LSP range
    /// <c>[startLine:startChar, endLine:endChar]</c>. Two grammar-grounded sites:
    /// <list type="bullet">
    /// <item>a <see cref="InlayHintKind.Type"/> hint after each <em>direct</em> read-model field
    /// (a bare <c>softName</c> whose type is inferred from the source type's member of the same
    /// name), anchored at the end of the field-name token;</item>
    /// <item>a <see cref="InlayHintKind.Parameter"/> hint before each positional argument of a
    /// call (<c>receiver.op(a, b)</c>) whose callee resolves to a parameterized entity
    /// command/factory or service operation/use-case, anchored at the argument's start.</item>
    /// </list>
    /// Resolution is best-effort: a field/call that does not resolve produces no hint (never a
    /// wrong one). Declarations are scoped to <paramref name="activeUri"/> by their source-span
    /// file, so hints are file-local even though resolution uses the whole-workspace model.
    /// Returns an empty list when the active document is absent.
    /// </summary>
    public IReadOnlyList<InlayHint> InlayHintsAt(
        KoineCompilation compilation, string activeUri,
        int startLine, int startChar, int endLine, int endChar)
    {
        if (!compilation.Documents.ContainsKey(activeUri))
        {
            return [];
        }

        // Resolve against the whole-workspace model so a read model can infer a field type from a
        // source type declared in another file; emit only for declarations in the active document.
        var semantic = compilation.SemanticModel;
        var index = semantic.Index;
        var hints = new List<InlayHint>();

        foreach (var context in semantic.Model.Contexts)
        {
            CollectTypeHints(context, index, activeUri, hints);
            CollectParameterHints(context, index, activeUri, hints);
        }

        // Keep only hints whose 0-based position falls within the requested range (inclusive).
        return hints
            .Where(h => InRange(h.Line, h.Character, startLine, startChar, endLine, endChar))
            .ToList();
    }

    /// <summary>
    /// Adds a <see cref="InlayHintKind.Type"/> hint for each direct read-model field in
    /// <paramref name="context"/> declared in <paramref name="activeUri"/>: a field with no written
    /// type and no projection, whose inferred type is the source type's member of the same name.
    /// </summary>
    private static void CollectTypeHints(ContextNode context, ModelIndex index, string activeUri, List<InlayHint> hints)
    {
        foreach (var rm in context.Types.OfType<ReadModelDecl>())
        {
            foreach (var field in rm.Fields)
            {
                // Direct field only: a written type or a projection means the type is not inferred.
                if (field.Type is not null || field.Projection is not null)
                {
                    continue;
                }

                // The name span must live in the active document and have a real position.
                if (field.NameSpan.IsNone || !IsInActiveDocument(field.NameSpan, activeUri))
                {
                    continue;
                }

                // Infer the field's type from the source member of the same name (R12.3). Skip when
                // it can't be resolved (e.g. the synthetic `id`, or an unknown source) — no wrong hint.
                if (!index.TryGetMemberType(context.Name, rm.SourceType, field.Name, out var type))
                {
                    continue;
                }

                // Anchor at the end of the field-name token (the type follows the name).
                var (line, character) = ZeroBasedEnd(field.NameSpan);
                hints.Add(new InlayHint(line, character, ": " + RenderType(type), InlayHintKind.Type));
            }
        }
    }

    /// <summary>
    /// Adds a <see cref="InlayHintKind.Parameter"/> hint before each positional argument of every
    /// resolvable call in <paramref name="context"/>'s expressions: walks every expression of every
    /// declaration, and for each <see cref="CallExpr"/> whose method resolves to a parameterized
    /// command/factory/operation/use-case, emits one hint per positional argument (skipping a
    /// trailing lambda selector). Anchors each hint at the argument's start; only the active
    /// document's expressions contribute.
    /// </summary>
    private static void CollectParameterHints(ContextNode context, ModelIndex index, string activeUri, List<InlayHint> hints)
    {
        foreach (var expr in context.Services.SelectMany(ServiceExpressions))
        {
            foreach (var call in CallsIn(expr))
            {
                // Koine expression calls resolve by RECEIVER TYPE, which this pass doesn't model — it
                // matches the callee by bare name. If more than one command/factory/operation shares
                // that name we can't know which is the real callee, so emit nothing rather than a
                // possibly-wrong parameter label (the inlay pass never renders a guessed hint).
                if (!IsUniqueCalleeName(index, call.Method))
                {
                    continue;
                }

                var parameters = ResolveCalleeParameters(index, call.Method);
                if (parameters is null)
                {
                    continue;
                }

                for (var i = 0; i < call.Args.Count && i < parameters.Count; i++)
                {
                    var arg = call.Args[i];
                    // A lambda selector (e.g. `l => …`) is not a positional value argument.
                    if (arg is LambdaExpr || arg.Span.IsNone || !IsInActiveDocument(arg.Span, activeUri))
                    {
                        continue;
                    }

                    var (line, character) = ZeroBasedStart(arg.Span);
                    hints.Add(new InlayHint(line, character, parameters[i].Name + ":", InlayHintKind.Parameter));
                }
            }
        }
    }

    /// <summary>The body expressions of a service: each operation's result body (use cases are abstract).</summary>
    private static IEnumerable<Expr> ServiceExpressions(ServiceDecl svc)
    {
        foreach (var op in svc.Operations)
        {
            if (op.Body is not null)
            {
                yield return op.Body;
            }
        }
    }

    /// <summary>Every <see cref="CallExpr"/> in an expression tree, outermost-first.</summary>
    private static IEnumerable<CallExpr> CallsIn(Expr expr)
    {
        switch (expr)
        {
            case CallExpr call:
                yield return call;
                foreach (var c in CallsIn(call.Target))
                {
                    yield return c;
                }

                foreach (var arg in call.Args)
                {
                    foreach (var c in CallsIn(arg))
                    {
                        yield return c;
                    }
                }

                break;
            case BinaryExpr b:
                foreach (var c in CallsIn(b.Left))
                {
                    yield return c;
                }

                foreach (var c in CallsIn(b.Right))
                {
                    yield return c;
                }

                break;
            case UnaryExpr u:
                foreach (var c in CallsIn(u.Operand))
                {
                    yield return c;
                }

                break;
            case ConditionalExpr cond:
                foreach (var c in CallsIn(cond.Condition))
                {
                    yield return c;
                }

                foreach (var c in CallsIn(cond.Then))
                {
                    yield return c;
                }

                foreach (var c in CallsIn(cond.Else))
                {
                    yield return c;
                }

                break;
            case CoalesceExpr co:
                foreach (var c in CallsIn(co.Left))
                {
                    yield return c;
                }

                foreach (var c in CallsIn(co.Right))
                {
                    yield return c;
                }

                break;
            case GuardExpr g:
                foreach (var c in CallsIn(g.Body))
                {
                    yield return c;
                }

                foreach (var c in CallsIn(g.Condition))
                {
                    yield return c;
                }

                break;
            case MemberAccessExpr ma:
                foreach (var c in CallsIn(ma.Target))
                {
                    yield return c;
                }

                break;
            case MatchExpr m:
                foreach (var c in CallsIn(m.Target))
                {
                    yield return c;
                }

                break;
            case LambdaExpr l:
                foreach (var c in CallsIn(l.Body))
                {
                    yield return c;
                }

                break;
            case LetExpr let:
                foreach (var binding in let.Bindings)
                {
                    foreach (var c in CallsIn(binding.Value))
                    {
                        yield return c;
                    }
                }

                foreach (var c in CallsIn(let.Body))
                {
                    yield return c;
                }

                break;
        }
    }

    /// <summary>True when <paramref name="span"/> belongs to the file identified by <paramref name="activeUri"/>.</summary>
    private static bool IsInActiveDocument(SourceSpan span, string activeUri) =>
        string.Equals(span.File, activeUri, StringComparison.Ordinal);

    /// <summary>The 0-based LSP start position of a 1-based span.</summary>
    private static (int Line, int Character) ZeroBasedStart(SourceSpan span) =>
        (Math.Max(0, span.Line - 1), Math.Max(0, span.Column - 1));

    /// <summary>The 0-based LSP end position of a 1-based, end-EXCLUSIVE span.</summary>
    private static (int Line, int Character) ZeroBasedEnd(SourceSpan span) =>
        (Math.Max(0, span.EndLine - 1), Math.Max(0, span.EndColumn - 1));

    /// <summary>True when the 0-based point falls within the inclusive 0-based range.</summary>
    private static bool InRange(int line, int character, int startLine, int startChar, int endLine, int endChar)
    {
        // LSP ranges are start-INCLUSIVE, end-EXCLUSIVE: a hint anchored exactly at the range end
        // belongs to the next request, so it must not leak into this one (otherwise a hint on a
        // viewport boundary is returned by two adjacent inlayHint requests).
        var afterStart = line > startLine || (line == startLine && character >= startChar);
        var beforeEnd = line < endLine || (line == endLine && character < endChar);
        return afterStart && beforeEnd;
    }

    // ------------------------------------------------------------------------
    // Call hierarchy (#260, Task 3) — over the domain call graph
    // command --emit--> event --policy--> command. ONE level of edges per request
    // (so a self-emitting cycle terminates naturally — see the cycle test). The graph
    // walk is the Task 1 ModelIndex; this layer only resolves the cursor symbol and the
    // declaration span of each edge target.
    // ------------------------------------------------------------------------

    /// <summary>
    /// Resolves the call-hierarchy symbol under the 0-based LSP <paramref name="line"/>/
    /// <paramref name="character"/> in <paramref name="activeUri"/> (same opening as
    /// <see cref="DefinitionAt(KoineCompilation,string,int,int)"/>): an empty / string-or-regex token
    /// yields nothing. A token naming a declared <c>event</c> resolves to a single
    /// <see cref="CallHierarchyItemKind.Event"/> item; a token naming an entity <c>command</c>
    /// resolves to a single <see cref="CallHierarchyItemKind.Command"/> item (its owning entity is the
    /// qualifier of a <c>Target.command(…)</c> policy reaction when present, else the unique entity
    /// declaring the command, else the enclosing entity). Returns an empty list when the cursor is on
    /// neither (a list lets prepare yield more than one candidate, though one is the normal case).
    /// </summary>
    public IReadOnlyList<CallHierarchyItem> PrepareCallHierarchy(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
        {
            return [];
        }

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
        {
            return [];
        }

        var model = compilation.SemanticModel.Model;
        var index = compilation.SemanticModel.Index;

        // An event under the cursor -> a single Event item at its declaration.
        if (index.Classify(name) == TypeKind.Event && FindEvent(index, name) is { } ev)
        {
            return [EventItem(ev.Name, ev)];
        }

        // Otherwise, a command on an entity. Prefer the policy-reaction qualifier (Target.command),
        // then the unique declaring entity, then the enclosing entity.
        var owner = ResolveCommandOwner(model, name, ctx.TokenBeforePreceding?.Text, ctx.EnclosingTypeName);
        if (owner is { } e && FindCommand(model, e.Name, name) is { } command)
        {
            return [CommandItem(e.Name, command.Name, command)];
        }

        // Off any command/event (a field/primitive/whitespace): nothing to anchor.
        return [];
    }

    /// <summary>
    /// One level of incoming edges (who calls <paramref name="item"/>):
    /// <list type="bullet">
    /// <item>for an <c>Event</c>, the commands that <c>emit</c> it
    /// (<see cref="ModelIndex.CommandsEmitting"/>);</item>
    /// <item>for a <c>Command</c> on type <c>T</c>, every event whose policy re-triggers
    /// <c>(T, command)</c> — collected from <c>ctx.Policies</c> and deduped.</item>
    /// </list>
    /// An edge whose target is not declared in the model (e.g. an external command/event) is skipped
    /// silently rather than surfaced with no location.
    /// </summary>
    public IReadOnlyList<CallHierarchyIncomingCall> IncomingCalls(KoineCompilation compilation, CallHierarchyItem item)
    {
        var model = compilation.SemanticModel.Model;
        var index = compilation.SemanticModel.Index;
        var calls = new List<CallHierarchyIncomingCall>();

        if (item.Kind == CallHierarchyItemKind.Event)
        {
            // Who raises E = the commands that emit it.
            foreach (var (targetType, commandName) in index.CommandsEmitting(item.Name))
            {
                if (CommandItemFor(model, targetType, commandName) is { } from)
                {
                    calls.Add(new CallHierarchyIncomingCall(from));
                }
            }

            return calls;
        }

        // A command C on type T is triggered by every event whose policy reacts with (T, C).
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var policyCtx in model.Contexts)
        {
            foreach (var policy in policyCtx.Policies)
            {
                if (!string.Equals(policy.Reaction.TargetType, item.OwningType, StringComparison.Ordinal)
                    || !string.Equals(policy.Reaction.CommandName, item.Name, StringComparison.Ordinal))
                {
                    continue;
                }

                if (seen.Add(policy.EventName) && FindEvent(index, policy.EventName) is { } ev)
                {
                    calls.Add(new CallHierarchyIncomingCall(EventItem(ev.Name, ev)));
                }
            }
        }

        return calls;
    }

    /// <summary>
    /// One level of outgoing edges (what <paramref name="item"/> calls):
    /// <list type="bullet">
    /// <item>for an <c>Event</c>, the commands its policies trigger
    /// (<see cref="ModelIndex.PoliciesTriggeredByEvent"/>);</item>
    /// <item>for a <c>Command</c> on type <c>T</c>, the events it <c>emit</c>s
    /// (<see cref="ModelIndex.EventsEmittedBy"/>).</item>
    /// </list>
    /// An edge whose target is not declared in the model is skipped silently (no location to point at).
    /// </summary>
    public IReadOnlyList<CallHierarchyOutgoingCall> OutgoingCalls(KoineCompilation compilation, CallHierarchyItem item)
    {
        var model = compilation.SemanticModel.Model;
        var index = compilation.SemanticModel.Index;
        var calls = new List<CallHierarchyOutgoingCall>();

        if (item.Kind == CallHierarchyItemKind.Event)
        {
            // What E triggers = the (target, command) reactions of its policies.
            foreach (var (targetType, commandName) in index.PoliciesTriggeredByEvent(item.Name))
            {
                if (CommandItemFor(model, targetType, commandName) is { } to)
                {
                    calls.Add(new CallHierarchyOutgoingCall(to));
                }
            }

            return calls;
        }

        // The events command C on type T emits.
        foreach (var eventName in index.EventsEmittedBy(item.OwningType!, item.Name))
        {
            if (FindEvent(index, eventName) is { } ev)
            {
                calls.Add(new CallHierarchyOutgoingCall(EventItem(ev.Name, ev)));
            }
        }

        return calls;
    }

    /// <summary>
    /// Picks the entity that owns the command named <paramref name="commandName"/>. Priority:
    /// (1) the <paramref name="enclosingType"/> when the cursor sits inside an entity that declares
    /// the command (a declaration or in-body reference site — this is the owner, full stop);
    /// (2) the <paramref name="reactionQualifier"/> (the <c>Target</c> of a <c>Target.command(…)</c>
    /// policy reaction, where the cursor is NOT inside an entity body so enclosingType is null);
    /// (3) the unique declaring entity; (4) first-wins. Returns <c>null</c> when no entity declares a
    /// command of that name. Enclosing-type wins over the qualifier so a field-type token sitting just
    /// before a <c>command</c> keyword (which becomes <paramref name="reactionQualifier"/> at a
    /// declaration site) can't steer the owner to the wrong same-named entity.
    /// </summary>
    private static EntityDecl? ResolveCommandOwner(KoineModel model, string commandName, string? reactionQualifier, string? enclosingType)
    {
        var declaring = model.Contexts
            .SelectMany(c => c.AllTypeDecls().OfType<EntityDecl>())
            .Where(e => e.Commands.Any(cmd => string.Equals(cmd.Name, commandName, StringComparison.Ordinal)))
            .ToList();

        if (declaring.Count == 0)
        {
            return null;
        }

        // 1. The enclosing entity that declares the command — a declaration/in-body site. This binds
        //    the command to the entity whose body the cursor is actually in, regardless of any token
        //    sitting before the `command` keyword.
        if (enclosingType is not null
            && declaring.FirstOrDefault(e => string.Equals(e.Name, enclosingType, StringComparison.Ordinal)) is { } enclosing)
        {
            return enclosing;
        }

        // 2. A `Target.command(…)` policy reaction: the qualifier names the owning entity. (Policies
        //    are top-level, so the cursor is not inside an entity body and enclosingType is null here.)
        if (reactionQualifier is not null
            && declaring.FirstOrDefault(e => string.Equals(e.Name, reactionQualifier, StringComparison.Ordinal)) is { } qualified)
        {
            return qualified;
        }

        // 3. The unique declaring entity (the common case), else first-wins.
        return declaring[0];
    }

    /// <summary>A command edge item resolved to its declaration, or <c>null</c> when the target is not declared (silently skipped).</summary>
    private static CallHierarchyItem? CommandItemFor(KoineModel model, string targetType, string commandName) =>
        FindCommand(model, targetType, commandName) is { } command ? CommandItem(targetType, commandName, command) : null;

    /// <summary>Builds a Command item pointing at the command's <c>NameSpan</c> (its <c>File</c> is the declaring document's URI).</summary>
    private static CallHierarchyItem CommandItem(string owningType, string name, CommandDecl command)
    {
        var span = command.NameSpan.IsNone ? command.Span : command.NameSpan;
        return new CallHierarchyItem(name, CallHierarchyItemKind.Command, owningType, span.File ?? "", span);
    }

    /// <summary>Builds an Event item pointing at the event's <c>NameSpan</c> (its <c>File</c> is the declaring document's URI).</summary>
    private static CallHierarchyItem EventItem(string name, EventDecl ev)
    {
        var span = ev.NameSpan.IsNone ? ev.Span : ev.NameSpan;
        return new CallHierarchyItem(name, CallHierarchyItemKind.Event, null, span.File ?? "", span);
    }

    /// <summary>The entity command declaration named <paramref name="name"/> on <paramref name="type"/>, or <c>null</c>.</summary>
    private static CommandDecl? FindCommand(KoineModel model, string type, string name) =>
        model.Contexts
            .SelectMany(c => c.AllTypeDecls().OfType<EntityDecl>())
            .Where(e => string.Equals(e.Name, type, StringComparison.Ordinal))
            .SelectMany(e => e.Commands)
            .FirstOrDefault(cmd => string.Equals(cmd.Name, name, StringComparison.Ordinal));

    /// <summary>The event declaration named <paramref name="name"/>, or <c>null</c>. Resolved via the
    /// index's O(1) name map (events are types) rather than re-walking the model per call.</summary>
    private static EventDecl? FindEvent(ModelIndex index, string name) =>
        index.TryGetDecl(name, out var decl) && decl is EventDecl ev ? ev : null;

    // ---- Type hierarchy (#331, Task 3) ------------------------------------

    /// <summary>
    /// Resolves the type-hierarchy node under the 0-based LSP <paramref name="line"/>/
    /// <paramref name="character"/> in <paramref name="activeUri"/> (same opening as
    /// <see cref="PrepareCallHierarchy"/>): a token naming a declared type (value, entity, aggregate,
    /// read model, enum, event) resolves to a single <see cref="TypeHierarchyItem"/> at its declaration;
    /// anything else (a primitive, a field, whitespace, a string/regex) yields an empty list. A list lets
    /// <c>prepare</c> express "no anchor here" while staying shaped like the call-hierarchy seam.
    /// </summary>
    public IReadOnlyList<TypeHierarchyItem> PrepareTypeHierarchy(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
        {
            return [];
        }

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
        {
            return [];
        }

        var model = compilation.SemanticModel.Model;
        var index = compilation.SemanticModel.Index;
        // Resolve the type in the cursor's enclosing context (#389): a name declared in two contexts
        // resolves to the one the cursor sits in, so the prepared item carries the right (context, name).
        return ResolveDecl(model, name, ctx.EnclosingContextName) is (var decl, var context) && ItemFor(index, decl, context) is { } item
            ? [item]
            : [];
    }

    /// <summary>
    /// Supertypes of <paramref name="item"/> — the declared types it points <i>at</i>: for an entity, its
    /// identity type and the types of its members; for a value/event, its members' types; for a read model,
    /// its <c>from</c> source; for an aggregate, its root entity. Only edges whose target is a declared
    /// type (with a location) are surfaced — primitives and undeclared names are skipped silently, exactly
    /// as the call hierarchy skips undeclared targets. Deduped, in declaration order.
    /// </summary>
    public IReadOnlyList<TypeHierarchyItem> Supertypes(KoineCompilation compilation, TypeHierarchyItem item)
    {
        var model = compilation.SemanticModel.Model;
        var index = compilation.SemanticModel.Index;
        if (ResolveDecl(model, item.Name, item.Context) is not (var decl, var declContext))
        {
            return [];
        }

        var results = new List<TypeHierarchyItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (targetName, targetRef) in DeclaredTargets(decl))
        {
            // Resolve the edge target in the SAME context first, then by the model's cross-context
            // visibility rules (#389) — so an entity's `Money` member resolves to its own context's Money.
            var targetContext = ResolveTargetContext(index, declContext, targetName, targetRef);
            if (ResolveDecl(model, targetName, targetContext) is not (var target, var resolvedContext))
            {
                continue;
            }

            // Skip a self-edge (a recursive type — e.g. `entity Tree { parent: Tree }`): a type is not
            // its own supertype, and a self-loop would make a client's hierarchy tree expand forever.
            // Identity is (context, name): compared against the context the edge actually resolves to.
            if (string.Equals(target.Name, item.Name, StringComparison.Ordinal)
                && string.Equals(resolvedContext, declContext, StringComparison.Ordinal))
            {
                continue;
            }

            if (seen.Add(QualifiedKey(resolvedContext, target.Name)) && ItemFor(index, target, resolvedContext) is { } ti)
            {
                results.Add(ti);
            }
        }

        return results;
    }

    /// <summary>
    /// Subtypes of <paramref name="item"/> — the inverse edges: every declared type that points <i>at</i>
    /// it (an entity/value with a member of this type, a read model whose <c>from</c> source is this type,
    /// an aggregate rooted on it). Deduped, in declaration order. The complement of
    /// <see cref="Supertypes"/> over the same declared-relationship graph.
    /// </summary>
    public IReadOnlyList<TypeHierarchyItem> Subtypes(KoineCompilation compilation, TypeHierarchyItem item)
    {
        var model = compilation.SemanticModel.Model;
        var index = compilation.SemanticModel.Index;

        // Identify the target precisely as (context, name): prefer the item's carried context. When it is
        // unknown (a recovered parse), targetContext stays null and the walk matches by name only — today's
        // behavior, so single-context models never regress.
        var targetContext = ResolveDecl(model, item.Name, item.Context) is (_, var resolved) ? resolved : item.Context;

        var results = new List<TypeHierarchyItem>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var c in model.Contexts)
        {
            foreach (var decl in c.AllTypeDecls())
            {
                // Skip the self-edge of a recursive type (it is not its own subtype), mirroring Supertypes.
                if (string.Equals(decl.Name, item.Name, StringComparison.Ordinal)
                    && string.Equals(c.Name, targetContext, StringComparison.Ordinal))
                {
                    continue;
                }

                // A subtype is any decl with an edge to a type named `item.Name` that resolves — from its
                // own context — to the SAME (context, name) as the item (#389), not merely any same-named one.
                var pointsAtTarget = false;
                foreach (var (targetName, targetRef) in DeclaredTargets(decl))
                {
                    if (!string.Equals(targetName, item.Name, StringComparison.Ordinal))
                    {
                        continue;
                    }

                    if (targetContext is null
                        || string.Equals(ResolveTargetContext(index, c.Name, targetName, targetRef), targetContext, StringComparison.Ordinal))
                    {
                        pointsAtTarget = true;
                        break;
                    }
                }

                if (pointsAtTarget && seen.Add(QualifiedKey(c.Name, decl.Name)) && ItemFor(index, decl, c.Name) is { } ti)
                {
                    results.Add(ti);
                }
            }
        }

        return results;
    }

    /// <summary>
    /// Resolves the declared type named <paramref name="name"/> together with its declaring context
    /// (#389). When <paramref name="preferredContext"/> (the cursor's enclosing bounded context) declares
    /// the name, that same-context declaration wins; otherwise the first declaration across all contexts
    /// is taken — the deterministic first-wins fallback that keeps single-context (and recovered-parse)
    /// models behaving exactly as before. Returns <c>null</c> when no context declares the name.
    /// </summary>
    private static (TypeDecl Decl, string Context)? ResolveDecl(KoineModel model, string name, string? preferredContext)
    {
        // Same-context-first: the cursor's enclosing context wins when it declares the name.
        if (preferredContext is not null)
        {
            foreach (var c in model.Contexts)
            {
                if (!string.Equals(c.Name, preferredContext, StringComparison.Ordinal))
                {
                    continue;
                }

                var local = c.AllTypeDecls().FirstOrDefault(t => string.Equals(t.Name, name, StringComparison.Ordinal));
                if (local is not null)
                {
                    return (local, c.Name);
                }

                break;
            }
        }

        // Fallback: the first context that declares the name (deterministic on both backends).
        foreach (var c in model.Contexts)
        {
            var decl = c.AllTypeDecls().FirstOrDefault(t => string.Equals(t.Name, name, StringComparison.Ordinal));
            if (decl is not null)
            {
                return (decl, c.Name);
            }
        }

        return null;
    }

    /// <summary>
    /// The bounded context an edge to <paramref name="targetName"/> resolves to when referenced from
    /// <paramref name="fromContext"/> (#389), following Koine's name-resolution rules (R13.2/R14.1): an
    /// explicit <c>Context.Type</c> qualifier wins; else the same context when it declares the name; else
    /// the shared-kernel owner, a single import owner, or a context-map-permitted upstream. Falls back to
    /// the first declaring context (today's name-only behavior) when no rule applies, or <c>null</c> when
    /// the name is undeclared. Reuses <see cref="ModelIndex"/>'s existing cross-context queries — no new
    /// context-map semantics, and <c>Ast/</c> stays untouched.
    /// </summary>
    private static string? ResolveTargetContext(ModelIndex index, string fromContext, string targetName, TypeRef? targetRef)
    {
        // An explicit Context.Type qualifier resolves directly to that context.
        if (targetRef?.Qualifier is { } qualifier && index.DeclaresType(qualifier, targetName))
        {
            return qualifier;
        }

        // Same-context-first: a bare name resolves to the enclosing context's own declaration.
        if (index.DeclaresType(fromContext, targetName))
        {
            return fromContext;
        }

        // A shared-kernel type visible to this partner resolves to its kernel owner (R14.2).
        if (index.IsKernelVisibleFrom(fromContext, targetName) && index.KernelOwnerOfType(targetName) is { } kernelOwner)
        {
            return kernelOwner;
        }

        // A single import owner (R13.2).
        var importOwners = index.ImportOwnersOf(fromContext, targetName);
        if (importOwners.Count == 1)
        {
            return importOwners[0];
        }

        // A context-map-permitted upstream that declares the name (conformist/open-host/… — R14.1).
        var declaringContexts = index.DeclaringContextsOf(targetName);
        foreach (var upstream in declaringContexts)
        {
            if (!string.Equals(upstream, fromContext, StringComparison.Ordinal) && index.MapPermitsReference(fromContext, upstream))
            {
                return upstream;
            }
        }

        // Fallback: the first context that declares the name (deterministic first-wins).
        return declaringContexts.Count > 0 ? declaringContexts[0] : null;
    }

    /// <summary>A stable key for deduping a type-hierarchy node by its <b>(context, name)</b> identity.</summary>
    private static string QualifiedKey(string? context, string name) => $"{context} {name}";

    /// <summary>
    /// The declared types <paramref name="decl"/> points at (its supertype edges): identity + member
    /// types for an entity, member types for a value/event, the <c>from</c> source for a read model, the
    /// root for an aggregate. Each edge is a (name, ref) pair — the <see cref="TypeRef"/> is present for a
    /// member edge (so its optional <c>Context.Type</c> qualifier is available) and <c>null</c> for a bare
    /// identity/source/root name. The caller filters to those that resolve to a declared type.
    /// </summary>
    private static IEnumerable<(string Name, TypeRef? Ref)> DeclaredTargets(TypeDecl decl)
    {
        switch (decl)
        {
            case EntityDecl e:
                yield return (e.IdentityName, null);
                foreach (var t in e.Members.SelectMany(m => TypeRefTargets(m.Type)))
                {
                    yield return t;
                }

                break;
            case ValueObjectDecl v:
                foreach (var t in v.Members.SelectMany(m => TypeRefTargets(m.Type)))
                {
                    yield return t;
                }

                break;
            case EventDecl ev:
                foreach (var t in ev.Members.SelectMany(m => TypeRefTargets(m.Type)))
                {
                    yield return t;
                }

                break;
            case IntegrationEventDecl ie:
                foreach (var t in ie.Members.SelectMany(m => TypeRefTargets(m.Type)))
                {
                    yield return t;
                }

                break;
            case ReadModelDecl rm:
                yield return (rm.SourceType, null);
                break;
            case AggregateDecl agg:
                yield return (agg.RootName, null);
                break;
        }
    }

    /// <summary>Every type a <see cref="TypeRef"/> references, unwrapping generic collections
    /// (<c>List&lt;X&gt;</c>, <c>Set&lt;X&gt;</c>, <c>Map&lt;K,V&gt;</c>) to their element/value types.
    /// Each is a (name, ref) pair so the element's <c>Context.Type</c> qualifier (if any) is preserved.</summary>
    private static IEnumerable<(string Name, TypeRef? Ref)> TypeRefTargets(TypeRef? type)
    {
        if (type is null)
        {
            yield break;
        }

        yield return (type.Name, type);
        foreach (var t in TypeRefTargets(type.Element))
        {
            yield return t;
        }

        foreach (var t in TypeRefTargets(type.Value))
        {
            yield return t;
        }
    }

    /// <summary>Builds a type-hierarchy item pointing at the declaration's <c>NameSpan</c> (its <c>File</c>
    /// is the declaring document's URI), carrying its declaring <paramref name="context"/> (#389), or
    /// <c>null</c> when the declaration has no source location.</summary>
    private static TypeHierarchyItem? ItemFor(ModelIndex index, TypeDecl decl, string? context)
    {
        var span = decl.NameSpan.IsNone ? decl.Span : decl.NameSpan;
        if (span.IsNone)
        {
            return null;
        }

        return new TypeHierarchyItem(decl.Name, TypeHierarchyKindOf(index.Classify(decl.Name)), span.File ?? "", span)
        {
            Context = context,
        };
    }

    /// <summary>Maps the model's <see cref="TypeKind"/> to the editor-facing <see cref="TypeHierarchyItemKind"/>.</summary>
    private static TypeHierarchyItemKind TypeHierarchyKindOf(TypeKind kind) => kind switch
    {
        TypeKind.Aggregate => TypeHierarchyItemKind.Aggregate,
        TypeKind.Entity => TypeHierarchyItemKind.Entity,
        TypeKind.Value => TypeHierarchyItemKind.Value,
        TypeKind.IdValueObject => TypeHierarchyItemKind.Value,
        TypeKind.ReadModel => TypeHierarchyItemKind.ReadModel,
        TypeKind.Enum => TypeHierarchyItemKind.Enum,
        TypeKind.Event => TypeHierarchyItemKind.Event,
        TypeKind.IntegrationEvent => TypeHierarchyItemKind.Event,
        _ => TypeHierarchyItemKind.Other,
    };

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

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex || name == newName)
        {
            return null;
        }

        var offset = OffsetOf(source, line, character);

        // Reject a rename that would collide with an existing declaration in the SAME namespace
        // (e.g. type Order -> an existing type Customer). The check is kind-scoped, so a same-named
        // declaration in a DIFFERENT namespace (an enum member named like a type) does not block it.
        if (compilation.WorkspaceIndex.WouldCollide(activeUri, name, offset, ctx.EnclosingTypeName, newName))
        {
            return null;
        }

        var refs = compilation.WorkspaceIndex.FindReferences(activeUri, name, offset, ctx.EnclosingTypeName);
        return refs.Count == 0 ? null : refs;
    }

    /// <summary>
    /// Rename edits for the name under the cursor, each occurrence paired with its own replacement text.
    /// For an ordinary symbol this is just <see cref="RenameAt(KoineCompilation,string,int,int,string)"/>
    /// with every occurrence mapped to <paramref name="newName"/>. The extra power: when the renamed symbol
    /// is an <b>aggregate root entity</b> whose identity follows the <c>&lt;Root&gt;Id</c> convention, the
    /// edit ALSO co-renames that identity type to <c>&lt;newName&gt;Id</c> in the same pass (#550) — so a
    /// <c>PurchaseOrder</c> no longer ends up with an <c>OrderId</c>. Returns null in exactly the cases
    /// <see cref="RenameAt(KoineCompilation,string,int,int,string)"/> does.
    /// </summary>
    public IReadOnlyList<RenameEdit>? RenameEditsAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character, string newName) =>
        RenameEditsAt(ToCompilation(documents), activeUri, line, character, newName);

    /// <summary>
    /// Overload of <see cref="RenameEditsAt(IReadOnlyDictionary{string,string},string,int,int,string)"/>
    /// that reuses a held <see cref="KoineCompilation"/> snapshot.
    /// </summary>
    public IReadOnlyList<RenameEdit>? RenameEditsAt(KoineCompilation compilation, string activeUri, int line, int character, string newName)
    {
        var refs = RenameAt(compilation, activeUri, line, character, newName);
        if (refs is null)
        {
            return null;
        }

        var edits = new List<RenameEdit>(refs.Count);
        foreach (Reference r in refs)
        {
            edits.Add(new RenameEdit(r, newName));
        }

        // The old name under the cursor (RenameAt already validated it resolves and differs from newName).
        if (compilation.Documents.TryGetValue(activeUri, out var source))
        {
            var ctx = TokenLocator.Locate(source, line, character, navigation: true);
            var oldName = ctx.CurrentToken?.Text;
            if (!string.IsNullOrEmpty(oldName))
            {
                // Resolve the SYMBOL the cursor actually lands on (offset + enclosing-type scope, exactly
                // as RenameAt does) and gate the <Root>Id co-rename on it — not the bare token text — so a
                // same-named non-root symbol (enum member, value object, …) never triggers it (#621).
                var offset = OffsetOf(source, line, character);
                Symbol? target = compilation.WorkspaceIndex.ResolveSymbol(activeUri, oldName, offset, ctx.EnclosingTypeName);
                if (IdentityCoRenameEdits(compilation, activeUri, oldName, newName, target) is { } idEdits)
                {
                    edits.AddRange(idEdits);
                }
            }
        }

        return edits;
    }

    /// <summary>
    /// The co-rename edits for an aggregate root's convention-linked identity type, or null when none apply.
    /// Fires only when <paramref name="oldName"/> resolves, in the active file's model, to an aggregate
    /// <b>root entity</b> whose identity type is literally <c>&lt;oldName&gt;Id</c> (the <c>&lt;Root&gt;Id</c>
    /// convention) AND the proposed <c>&lt;newName&gt;Id</c> would not collide with an existing type. Each
    /// occurrence of the identity type (its <c>identified by</c> declaration and every <c>: &lt;Root&gt;Id</c>
    /// use across the workspace) is paired with <c>&lt;newName&gt;Id</c>. Returns null for a non-root entity,
    /// a non-conventional identity (e.g. <c>identified by Guid</c>), or a name collision — the caller then
    /// renames just the root and Studio surfaces the left-behind Id (#550, Approach 2 fallback).
    /// <para><paramref name="resolvedTarget"/> is the symbol the cursor actually resolved to; the
    /// co-rename gates on it being the aggregate root entity's OWN declaration, so a same-named non-root
    /// symbol (an enum member, value object, command, … sharing the root's text) never fires it (#621).</para>
    /// <para>The identity references are further scoped to the root's OWN bounded context (#565): two
    /// UNRELATED contexts may each declare a type literally named <c>&lt;oldName&gt;Id</c>, and
    /// <see cref="WorkspaceIndex.FindReferences"/> matches by bare token text, so without this scoping the
    /// co-rename would also rewrite the other context's same-named, unrelated identity type.</para>
    /// </summary>
    private static IReadOnlyList<RenameEdit>? IdentityCoRenameEdits(
        KoineCompilation compilation, string activeUri, string oldName, string newName, Symbol? resolvedTarget)
    {
        // Resolve the aggregate's OWN root entity across the WHOLE workspace, not just the active file: a
        // rename can be invoked from a reference in a different file than the one declaring the root
        // (R13/R14 multi-file), and an aggregate's root entity lives in that aggregate's nested types —
        // `AggregateDecl.RootEntity()` resolves it precisely (never a same-named non-root entity). The
        // per-file model that resolved it is kept alongside it so its owning context can be looked up below.
        EntityDecl? root = null;
        SemanticModel? rootModel = null;
        foreach (var uri in compilation.Uris)
        {
            if (compilation.SemanticModelFor(uri) is not { } model)
            {
                continue;
            }

            var candidate = model.Index.AllTypes()
                .OfType<AggregateDecl>()
                .Where(a => a.RootName == oldName)
                .Select(a => a.RootEntity())
                .FirstOrDefault(e => e is not null);
            if (candidate is not null)
            {
                root = candidate;
                rootModel = model;
                break;
            }
        }

        if (root is null || rootModel is null)
        {
            return null;
        }

        // #621: gate on the RESOLVED symbol, not the bare token text. Fire only when the cursor resolved
        // to the root entity's OWN type declaration — comparing the resolved symbol's declaration span to
        // the root entity's name span (the same DeclSpan-identity check FindReferences uses for enum
        // members). A same-named non-root symbol (enum member, value object, …) resolves elsewhere and is
        // rejected here, so renaming it no longer rewrites the unrelated root's <Root>Id.
        if (resolvedTarget is not TypeSymbol || resolvedTarget.DeclSpan != root.NameSpan)
        {
            return null;
        }

        // The <Root>Id convention: only co-rename when the identity type is literally <oldName>Id. A
        // non-conventional identity (a primitive like Guid, or a hand-named type) is left untouched.
        var oldIdName = oldName + "Id";
        if (root.IdentityName != oldIdName)
        {
            return null;
        }

        // Collision guard: if <newName>Id already names a type/spec/Id, do not co-rename (Approach 2 fallback).
        var newIdName = newName + "Id";
        if (compilation.WorkspaceIndex.DeclaresTypeLike(newIdName))
        {
            return null;
        }

        // Resolve the identity type workspace-wide (offset: null) so the co-rename is independent of which
        // file the rename was invoked from — its declaration and every cross-file `: <Root>Id` use rename.
        IReadOnlyList<Reference> idRefs = compilation.WorkspaceIndex.FindReferences(activeUri, oldIdName, offset: null, enclosingType: null);

        // #565: scope those references to the root's OWN owning context (the context the per-file model
        // above actually found it declared in) — `FindReferences` is a workspace-wide TEXT match, so an
        // unrelated context that happens to declare its own same-named `<oldName>Id` would otherwise be
        // swept in too. A reference is kept only when ITS OWN file, considered as that same context, also
        // recognizes `oldIdName` (its declaration or a same-context `: <Root>Id` use) — `NamespaceOfTypeIn`
        // is populated for both cases (ModelIndex step 3c), so this keeps every same-context, cross-file
        // occurrence (#550) while dropping a different context's coincidentally same-named identity type.
        if (rootModel.Index.DeclaringContextsOf(oldName).FirstOrDefault() is { } ownerContext)
        {
            idRefs = idRefs
                .Where(r => compilation.SemanticModelFor(r.Uri) is { } refModel
                    && refModel.Index.NamespaceOfTypeIn(ownerContext, oldIdName) is not null)
                .ToList();
        }

        return idRefs.Count == 0 ? null : idRefs.Select(r => new RenameEdit(r, newIdName)).ToList();
    }

    /// <summary>
    /// A preview-shaped rename: the same cross-file edits as <see cref="RenameAt(IReadOnlyDictionary{string,string},string,int,int,string)"/>,
    /// regrouped per file so an editor can show a file-by-file diff before applying. Returns null in
    /// exactly the cases <c>RenameAt</c> does (not on a renameable name, an invalid/unchanged identifier,
    /// or a collision with an existing declaration).
    /// </summary>
    public RenamePreview? RenamePreviewAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character, string newName) =>
        RenamePreviewAt(ToCompilation(documents), activeUri, line, character, newName);

    /// <summary>
    /// Overload of <see cref="RenamePreviewAt(IReadOnlyDictionary{string,string},string,int,int,string)"/> that
    /// uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests.
    /// </summary>
    public RenamePreview? RenamePreviewAt(KoineCompilation compilation, string activeUri, int line, int character, string newName)
    {
        // Delegate to RenameAt so the WouldCollide check and every other guard are reused, not duplicated.
        var refs = RenameAt(compilation, activeUri, line, character, newName);
        if (refs is null)
        {
            return null;
        }

        // Group by file, preserving first-seen file order and the occurrence order within each file.
        var files = refs
            .GroupBy(r => r.Uri, StringComparer.Ordinal)
            .Select(g => new RenameFileChanges(g.Key, g.ToList()))
            .ToList();
        return new RenamePreview(newName, files);
    }

    /// <summary>
    /// The occurrences of the name under the cursor <em>within the active file only</em> — the LSP
    /// <c>linkedEditingRange</c> answer (single-file, in-place editing). Resolves the symbol with the
    /// same guards as <see cref="PrepareRenameAt(KoineCompilation,string,int,int)"/> /
    /// <see cref="RenameAt(KoineCompilation,string,int,int,string)"/> (null on a string/regex, a primitive,
    /// or a non-renameable name), then filters the cross-file references to <paramref name="activeUri"/>.
    /// Returns null when there are no in-file occurrences.
    /// </summary>
    public IReadOnlyList<Reference>? LinkedEditingRangeAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character) =>
        LinkedEditingRangeAt(ToCompilation(documents), activeUri, line, character);

    /// <summary>
    /// Overload of <see cref="LinkedEditingRangeAt(IReadOnlyDictionary{string,string},string,int,int)"/> that
    /// uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests.
    /// </summary>
    public IReadOnlyList<Reference>? LinkedEditingRangeAt(KoineCompilation compilation, string activeUri, int line, int character)
    {
        // Resolve via the SAME path as find-references, then keep only the active-file occurrences —
        // linked editing edits a single file in place. Delegating to ReferencesAt (rather than copying
        // its string/regex/primitive guards and symbol resolution) keeps a future change to that
        // resolution from silently desyncing linked editing, mirroring how RenamePreviewAt delegates to
        // RenameAt. ReferencesAt already returns an empty list for every null case, so the filter yields
        // an empty list there too, which collapses to null.
        var inFile = ReferencesAt(compilation, activeUri, line, character)
            .Where(r => string.Equals(r.Uri, activeUri, StringComparison.Ordinal))
            .ToList();
        return inFile.Count == 0 ? null : inFile;
    }

    /// <summary>
    /// The editable identifier range under the cursor — the LSP <c>prepareRename</c> answer.
    /// Returns the declaration/use occurrence at the cursor (a single-token <see cref="Reference"/>)
    /// when a rename would be valid there, or null when the cursor is inside a string/regex, not on a
    /// word token, or not on a renameable name (guarding exactly like <see cref="NameAt(KoineCompilation, string, int, int)"/> /
    /// <see cref="RenameAt(KoineCompilation, string, int, int, string)"/>). The returned range covers only the identifier under the cursor, so the
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

        var ctx = TokenLocator.Locate(source, line, character, navigation: true);
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

        var (model, _) = _compiler.Parse(source);
        if (model is null)
        {
            return [];
        }

        // Route through the unified code-fix provider set, adapting the editor-agnostic CodeFix back
        // to the CodeActionEdit shape this overload's callers (e.g. the WASM bridge) consume.
        return _codeFixes.RefactorsForSelection(source, model, startOffset, endOffset)
            .Select(f => new CodeActionEdit(
                f.Title, f.Kind, f.Edits.Select(e => new TextEditModel(e.Range, e.NewText)).ToList()))
            .ToList();
    }

    /// <summary>
    /// Snapshot-accepting overload of
    /// <see cref="RefactorsAt(IReadOnlyDictionary{string,string},string,int,int,int,int)"/>
    /// (issue #464): reads the active document's source text from the already-reconciled
    /// <see cref="KoineCompilation"/> snapshot's <see cref="KoineCompilation.Documents"/> map.
    /// Uses a single-file parse (matching the <c>documents</c>-based overload exactly) so the
    /// returned refactors are byte-identical to the stateless path for the same input text —
    /// the warm/stateless invariant is preserved.
    /// </summary>
    public IReadOnlyList<CodeActionEdit> RefactorsAt(
        KoineCompilation compilation, string activeUri,
        int startLine, int startChar, int endLine, int endChar)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
        {
            return [];
        }

        var startOffset = OffsetOf(source, startLine, startChar);
        var endOffset = OffsetOf(source, endLine, endChar);
        if (endOffset < startOffset)
        {
            (startOffset, endOffset) = (endOffset, startOffset);
        }

        // Parse only the active document — mirrors the dict-based overload's single-file parse
        // so the code-fix result is byte-identical to the stateless path for the same source text.
        var (model, _) = _compiler.Parse(source);
        if (model is null)
        {
            return [];
        }

        // Route through the unified code-fix provider set, adapting the editor-agnostic CodeFix back
        // to the CodeActionEdit shape this overload's callers (e.g. the WASM bridge) consume.
        return _codeFixes.RefactorsForSelection(source, model, startOffset, endOffset)
            .Select(f => new CodeActionEdit(
                f.Title, f.Kind, f.Edits.Select(e => new TextEditModel(e.Range, e.NewText)).ToList()))
            .ToList();
    }

    private readonly CodeFixes.CodeFixService _codeFixes = new();

    /// <summary>
    /// Signature help for the call enclosing the cursor. Walks back from the cursor to the nearest
    /// UNCLOSED <c>(</c>, resolves the identifier immediately before it to a command/factory on an
    /// entity, or an operation/use-case on a service, and reports that declaration's parameter list
    /// plus the active parameter (the count of top-level commas between the <c>(</c> and the cursor).
    /// Returns null when the document is not open, the cursor is in a string/regex, there is no
    /// enclosing open call, or the callee does not resolve to a parameterized declaration.
    /// </summary>
    public SignatureHelp? SignatureHelpAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character) =>
        SignatureHelpAt(ToCompilation(documents), activeUri, line, character);

    /// <summary>
    /// Overload of <see cref="SignatureHelpAt(IReadOnlyDictionary{string,string},string,int,int)"/>
    /// that uses a held <see cref="KoineCompilation"/> snapshot, avoiding re-parses when the caller
    /// holds and reuses the same compilation across multiple requests. The callee parameter list is
    /// resolved from the snapshot's memoized model rather than a fresh parse; the lexer-only cursor
    /// scan still re-lexes the active source (it needs the raw token stream to the cursor).
    /// </summary>
    public SignatureHelp? SignatureHelpAt(KoineCompilation compilation, string activeUri, int line, int character)
    {
        if (!compilation.Documents.TryGetValue(activeUri, out var source))
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

        // Resolve the callee against the snapshot's memoized model (the active file's, falling back
        // to the merged whole-workspace model) instead of re-parsing the source on every keystroke.
        var model = compilation.SemanticModelFor(activeUri)?.Model ?? compilation.Model;
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
        // Clamp the active parameter: overshooting the last param (e.g. an extra trailing comma)
        // must still highlight the last parameter rather than index out of range.
        var active = paramInfos.Count == 0 ? 0 : Math.Min(activeParameter, paramInfos.Count - 1);
        return new SignatureHelp([new SignatureInfo(label, paramInfos)], 0, active);
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
    /// True when EXACTLY ONE command, factory, operation, or use-case across the model is named
    /// <paramref name="callee"/> — so a parameter-name inlay hint for a call to it is unambiguous.
    /// Used to gate <see cref="CollectParameterHints"/>: a name shared by two declarations can't be
    /// resolved to the right callee without the receiver type (not modeled here), so it gets no hint.
    /// </summary>
    private static bool IsUniqueCalleeName(ModelIndex index, string callee)
    {
        var count = 0;
        foreach (var t in index.AllTypes())
        {
            if (t is EntityDecl e)
            {
                count += e.Commands.Count(c => c.Name == callee) + e.Factories.Count(f => f.Name == callee);
                if (count > 1)
                {
                    return false;
                }
            }
        }

        foreach (var ctx in index.Model.Contexts)
        {
            foreach (var svc in ctx.Services)
            {
                count += svc.Operations.Count(o => o.Name == callee) + svc.UseCases.Count(u => u.Name == callee);
                if (count > 1)
                {
                    return false;
                }
            }
        }

        return count == 1;
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
