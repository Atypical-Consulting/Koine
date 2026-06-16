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
    private static readonly string[] FileStarters = { "context" };
    private static readonly string[] ContextStarters =
        { "value", "quantity", "entity", "aggregate", "enum", "event", "spec", "service", "policy" };
    private static readonly string[] AggregateStarters =
        { "value", "quantity", "entity", "enum", "event", "spec", "repository" };
    private static readonly string[] ServiceStarters = { "operation" };
    private static readonly string[] RepositoryStarters = { "operations", "find" };
    private static readonly string[] EntityStarters = { "states", "command", "create", "invariant" };

    private static readonly string[] CollectionKeywords =
        { ModelIndex.ListTypeName, ModelIndex.SetTypeName, ModelIndex.MapTypeName, ModelIndex.RangeTypeName };

    public IReadOnlyList<CompletionItem> CompleteAt(string source, int line, int character)
    {
        var ctx = TokenLocator.Locate(source, line, character);
        if (ctx.InsideStringOrRegex)
            return Array.Empty<CompletionItem>();

        var (model, _) = _compiler.Parse(source);
        var index = model is null ? null : new ModelIndex(model);

        var items = CandidatesFor(ctx, index);
        return Filter(items, ctx.Partial);
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
            return TypeCandidates(index);

        // Member access: intentionally minimal this iteration. Resolving members
        // after '.' needs a parsed receiver expression + scope (TypeResolver), which
        // is unavailable on broken docs; we return nothing rather than guess (no noise).
        if (trigger == KoineLexer.DOT)
            return Array.Empty<CompletionItem>();

        // Enum value position: after '=' (a field/param default). Resolve the
        // governing enum from the preceding `name : EnumType =` triple when possible;
        // otherwise fall back to every known enum member (still useful mid-edit).
        if (trigger == KoineLexer.ASSIGN)
            return EnumMemberCandidates(ctx, index);

        // Declaration start: cursor at the start of a statement (after '{' or '}'),
        // or at file scope.
        if (ctx.PrecedingToken is null
            || trigger == KoineLexer.LBRACE
            || trigger == KoineLexer.RBRACE)
            return Keywords(StartersFor(ctx.EnclosingKeyword));

        // Expression-operand position inside a fielded type body (e.g. `invariant
        // amount >= 0`, `requires qty > 0`): offer that type's field names. We only
        // fire after a token that begins/continues an expression, so we never add
        // noise at a declaration or parameter position.
        if (index is not null && ctx.EnclosingTypeName is { } scopeType && IsExpressionOperand(trigger))
            return FieldCandidates(index, scopeType);

        return Array.Empty<CompletionItem>();
    }

    // Tokens after which an identifier is an expression operand (so a field name fits).
    // ASSIGN (enum defaults) and DOT (member access, kept noise-free) are deliberately excluded.
    private static bool IsExpressionOperand(int? trigger) => trigger is
        KoineLexer.INVARIANT or KoineLexer.REQUIRES or KoineLexer.WHEN or KoineLexer.IF
        or KoineLexer.ELSE or KoineLexer.COALESCE or KoineLexer.NOT or KoineLexer.MINUS
        or KoineLexer.PLUS or KoineLexer.STAR or KoineLexer.SLASH or KoineLexer.EQ
        or KoineLexer.NEQ or KoineLexer.LT or KoineLexer.LE or KoineLexer.GT or KoineLexer.GE
        or KoineLexer.AND or KoineLexer.OR or KoineLexer.MATCHES or KoineLexer.LARROW;

    private static IReadOnlyList<CompletionItem> FieldCandidates(ModelIndex index, string typeName) =>
        index.MemberNames(typeName)
            .Select(name =>
            {
                var detail = index.TryGetMemberType(typeName, name, out var t) ? RenderType(t) : "field";
                return new CompletionItem(name, CompletionItemKind.Field, detail, null);
            })
            .ToList();

    /// <summary>Renders a (possibly generic/optional) type reference for a completion detail, e.g. <c>List&lt;OrderLine&gt;?</c>.</summary>
    private static string RenderType(TypeRef t)
    {
        var name = t.Qualifier is { } q ? $"{q}.{t.Name}" : t.Name;
        if (t.Element is not null)
            name += t.Value is not null
                ? $"<{RenderType(t.Element)}, {RenderType(t.Value)}>"
                : $"<{RenderType(t.Element)}>";
        return t.IsOptional ? name + "?" : name;
    }

    private static bool IsGenericArgPosition(TokenContext ctx, ModelIndex? index)
    {
        // Conservative: only treat '<' as a type-arg opener when the token before it
        // is a known type name. This avoids confusing the relational '<' operator in
        // an expression with a generic argument list. Without a model we cannot tell,
        // so we suppress.
        if (ctx.PrecedingToken?.Type != KoineLexer.LT || index is null)
            return false;
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
            return Array.Empty<CompletionItem>();

        // Resolve the governing enum from the type name just before '=' .
        var typeName = ctx.TokenBeforePreceding?.Text;
        if (typeName is not null && index.IsEnumType(typeName)
            && index.TryGetDecl(typeName, out var decl) && decl is EnumDecl e)
            return e.Members
                .Select(m => new CompletionItem(m.Name, CompletionItemKind.EnumMember, typeName, m.Doc))
                .ToList();

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
        "aggregate" => AggregateStarters,
        "service" => ServiceStarters,
        "repository" => RepositoryStarters,
        "entity" => EntityStarters,
        _ => Array.Empty<string>(),
    };

    private static IReadOnlyList<CompletionItem> Keywords(string[] names) =>
        names.Select(n => new CompletionItem(n, CompletionItemKind.Keyword, "keyword", null)).ToList();

    private static IReadOnlyList<CompletionItem> Filter(IReadOnlyList<CompletionItem> items, string partial)
    {
        if (partial.Length == 0)
            return items;
        var matched = items.Where(i => i.Label.StartsWith(partial, StringComparison.Ordinal)).ToList();
        return matched; // empty list when nothing matches, by design
    }

    public HoverResult? HoverAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
            return null;

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var markdown = new WorkspaceIndex(documents).ResolveHover(activeUri, name);
        return markdown is null ? null : new HoverResult(markdown);
    }

    public DefinitionResult? DefinitionAt(IReadOnlyDictionary<string, string> documents, string activeUri, int line, int character)
    {
        if (!documents.TryGetValue(activeUri, out var source))
            return null;

        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var loc = new WorkspaceIndex(documents).ResolveDefinition(activeUri, name);
        return loc is null ? null : new DefinitionResult(loc.Uri, loc.Span);
    }

}
