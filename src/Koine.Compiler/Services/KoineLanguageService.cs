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
public sealed record DefinitionResult(SourceSpan Target);

/// <summary>
/// Editor-agnostic language services for <c>.koi</c>: completion, hover, and
/// go-to-definition over (source, line, character). Completion is lexer-only and
/// works on broken documents; hover/definition build a model and return null when
/// parsing fails.
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

        return Array.Empty<CompletionItem>();
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

    public HoverResult? HoverAt(string source, int line, int character)
    {
        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var (model, _) = _compiler.Parse(source);
        if (model is null)
            return null;
        var index = new ModelIndex(model);

        var markdown = RenderHover(name, index);
        return markdown is null ? null : new HoverResult(markdown);
    }

    public DefinitionResult? DefinitionAt(string source, int line, int character)
    {
        var ctx = TokenLocator.Locate(source, line, character);
        var name = ctx.CurrentToken?.Text;
        if (string.IsNullOrEmpty(name) || ctx.InsideStringOrRegex)
            return null;

        var (model, _) = _compiler.Parse(source);
        if (model is null)
            return null;
        var index = new ModelIndex(model);

        // 1. A declared type -> its declaration span.
        if (index.TryGetDecl(name, out var decl) && decl.Span != SourceSpan.None)
            return new DefinitionResult(decl.Span);

        // 2. An enum member -> the member's own span. Navigate only when the member
        // name is unambiguous; if two enums declare it, fall through (return null)
        // rather than jump to an arbitrary one — matches hover's ambiguity handling.
        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1
            && index.TryGetDecl(owners[0], out var enumDecl) && enumDecl is EnumDecl e)
        {
            var member = e.Members.FirstOrDefault(m => m.Name == name);
            if (member is not null && member.Span != SourceSpan.None)
                return new DefinitionResult(member.Span);
        }

        // 3. A spec -> its declaration span.
        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null && spec.Span != SourceSpan.None)
            return new DefinitionResult(spec.Span);

        // Primitives, collection keywords, and ID value objects have no node: not navigable.
        return null;
    }

    private static string? RenderHover(string name, ModelIndex index)
    {
        // 1. A declared type.
        if (index.TryGetDecl(name, out var decl))
        {
            var kind = index.Classify(name);
            var sb = new System.Text.StringBuilder();
            sb.Append("**").Append(name).Append("** *(").Append(KindLabel(kind)).Append(")*");
            AppendBody(sb, decl);
            if (decl.Doc is { Length: > 0 } doc)
                sb.Append("\n\n").Append(doc);
            return sb.ToString();
        }

        // 2. A bare enum member.
        var owners = index.EnumsDeclaring(name);
        if (owners.Count == 1)
            return $"**{name}** *(enum member of {owners[0]})*";
        if (owners.Count >= 2)
            return $"**{name}** *(ambiguous enum member — declared in {string.Join(", ", owners)})*";

        // 3. A spec.
        var spec = index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null)
            return $"**{name}** *(spec on {spec.TargetType})*";

        // 4. Primitives / collection keywords / ID value objects: minimal card.
        var classified = index.Classify(name);
        return classified == TypeKind.Unknown ? null : $"**{name}** *({KindLabel(classified)})*";
    }

    private static string KindLabel(TypeKind kind) => kind switch
    {
        TypeKind.IdValueObject => "ID value object",
        _ => kind.ToString(),
    };

    private static string TypeLabel(TypeRef t)
    {
        var name = t.Element is null ? t.Name
            : t.Value is null ? $"{t.Name}<{TypeLabel(t.Element)}>"
            : $"{t.Name}<{TypeLabel(t.Element)}, {TypeLabel(t.Value)}>";
        return t.IsOptional ? name + "?" : name;
    }

    private static void AppendBody(System.Text.StringBuilder sb, TypeDecl decl)
    {
        switch (decl)
        {
            case ValueObjectDecl v:
                foreach (var m in v.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EntityDecl e:
                sb.Append("\n\nidentified by `").Append(e.IdentityName).Append("` (")
                  .Append(e.IdStrategy).Append(')');
                foreach (var m in e.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case EnumDecl en:
                sb.Append("\n\n").Append(string.Join(", ", en.MemberNames));
                break;
            case EventDecl ev:
                foreach (var m in ev.Members)
                    sb.Append("\n\n`").Append(m.Name).Append(" : ").Append(TypeLabel(m.Type)).Append('`');
                break;
            case AggregateDecl agg:
                // Listing the aggregate's owned/nested types is intentionally omitted for now.
                sb.Append("\n\nroot `").Append(agg.RootName).Append('`');
                if (agg.IsVersioned) sb.Append(" *(versioned)*");
                break;
        }
    }
}
