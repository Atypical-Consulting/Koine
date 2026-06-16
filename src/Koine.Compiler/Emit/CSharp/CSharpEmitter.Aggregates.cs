using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The aggregate slice of <see cref="CSharpEmitter"/> (R11): emitting an aggregate's
/// nested types and the aggregate root's persistence-ignorant repository contract,
/// plus the identity-strategy index. Split out as a partial to keep the orchestrating
/// emitter focused.
/// </summary>
public sealed partial class CSharpEmitter
{
    // ----------------------------------------------------------------------
    // Aggregates
    // ----------------------------------------------------------------------

    private void EmitAggregate(
        EmitContext emit,
        List<EmittedFile> files,
        AggregateDecl agg,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        // Nested types live in the enclosing context namespace (ns), not a sub-namespace.
        foreach (var type in agg.Types)
        {
            switch (type)
            {
                case ValueObjectDecl vo:
                    files.Add(EmitValueObject(emit, vo, ns, index, typeMapper, enumMemberToType));
                    break;
                case EntityDecl entity:
                    var isRoot = entity.Name == agg.RootName;
                    EmitEntityAndId(emit, files, entity, ns, isRoot, isRoot && agg.IsVersioned, index, typeMapper, enumMemberToType);
                    break;
                case EnumDecl @enum:
                    files.Add(EmitEnum(emit, @enum, ns, index, typeMapper, enumMemberToType));
                    break;
                case EventDecl @event:
                    files.Add(EmitEvent(emit, @event, ns, index, typeMapper, enumMemberToType));
                    break;
                case IntegrationEventDecl @event:
                    files.Add(EmitIntegrationEvent(emit, @event, ns, index, typeMapper, enumMemberToType));
                    break;
                case AggregateDecl nested:
                    // Nested aggregates are not part of v0 fixtures, but recurse safely.
                    EmitAggregate(emit, files, nested, ns, index, typeMapper, enumMemberToType);
                    break;
            }
        }

        // The aggregate root's repository contract (R11.2/R11.3).
        if (EmitRepository(emit, agg, ns, index, typeMapper) is { } repo)
            files.Add(repo);
    }

    // ----------------------------------------------------------------------
    // Repositories (R11.2 / R11.3)
    // ----------------------------------------------------------------------

    /// <summary>The mutating + query operations a repository exposes when none are listed.</summary>
    private static readonly IReadOnlyList<string> DefaultRepositoryOps =
        new[] { "getById", "add", "update", "remove" };

    /// <summary>
    /// Emits the <c>I&lt;Root&gt;Repository</c> interface for an aggregate: the
    /// fundamental <c>GetByIdAsync</c> lookup, the configured mutating operations
    /// (R11.3, default add/update/remove), and any declarative finders. Keyed on the
    /// root's ID value object. Returns <c>null</c> if the root cannot be resolved
    /// (already a validation error).
    /// </summary>
    private EmittedFile? EmitRepository(EmitContext emit, AggregateDecl agg, string ns, ModelIndex index, CSharpTypeMapper typeMapper)
    {
        var root = agg.RootEntity();
        if (root is null)
            return null;

        var rootName = root.Name;
        var idType = root.IdentityName;
        var ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        var finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();
        var iface = $"I{rootName}Repository";

        var sb = new StringBuilder();
        WriteXmlDoc(sb, $"Persistence-ignorant repository contract for the {rootName} aggregate root.", "");
        sb.Append("public interface ").Append(iface).Append("\n{\n");

        var first = true;
        void Gap()
        { if (!first) sb.Append('\n'); first = false; }

        if (ops.Contains("getById"))
        {
            Gap();
            sb.Append(Indent).Append("Task<").Append(rootName).Append("?> GetByIdAsync(")
              .Append(idType).Append(" id, CancellationToken ct = default);\n");
        }

        foreach (var (op, verb) in new[] { ("add", "Add"), ("update", "Update"), ("remove", "Remove") })
            if (ops.Contains(op))
            {
                Gap();
                // A versioned aggregate enforces the expected Version on a state-changing save.
                if (agg.IsVersioned && op != "add")
                    sb.Append(Indent).Append("/// <summary>Enforces the aggregate's expected Version; ")
                      .Append("throws ConcurrencyConflictException on a stale write.</summary>\n");
                sb.Append(Indent).Append("Task ").Append(verb).Append("Async(")
                  .Append(rootName).Append(" aggregate, CancellationToken ct = default);\n");
            }

        foreach (var finder in finders)
        {
            Gap();
            var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
            var ret = isList ? $"Task<IReadOnlyList<{rootName}>>" : $"Task<{rootName}?>";
            var paramList = string.Join(", ", finder.Parameters.Select(p =>
                $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}"));
            if (paramList.Length > 0)
                paramList += ", ";
            sb.Append(Indent).Append(ret).Append(' ')
              .Append(CSharpNaming.ToPascalCase(finder.Name)).Append("Async(")
              .Append(paramList).Append("CancellationToken ct = default);\n");
        }

        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(ns)}/{iface}.cs", Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>Maps every owned ID type name to its declared identity strategy (R11.1).</summary>
    private static IReadOnlyDictionary<string, (IdentityStrategy Strategy, string? Backing)> BuildIdentityStrategies(KoineModel model)
    {
        var map = new Dictionary<string, (IdentityStrategy, string?)>(StringComparer.Ordinal);
        foreach (var ctx in model.Contexts)
            foreach (var t in ctx.AllTypeDecls())
                if (t is EntityDecl e)
                    map[e.IdentityName] = (e.IdStrategy, e.IdBackingType);
        return map;
    }

    /// <summary>True when any aggregate is declared <c>versioned</c> (gates the concurrency runtime type).</summary>
    private static bool HasVersionedAggregate(KoineModel model) =>
        model.Contexts.SelectMany(c => c.AllTypeDecls()).OfType<AggregateDecl>().Any(a => a.IsVersioned);
}
