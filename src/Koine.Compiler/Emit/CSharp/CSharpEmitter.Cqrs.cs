using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The application/CQRS slice of <see cref="CSharpEmitter"/> (R12): the context's
/// Unit of Work, application-service interfaces, read-model projections, query objects
/// and the generic query-handler contract. Split out as a partial to keep the
/// orchestrating emitter focused.
/// </summary>
public sealed partial class CSharpEmitter
{
    // ----------------------------------------------------------------------
    // Application services, read models, CQRS (R12)
    // ----------------------------------------------------------------------

    /// <summary>
    /// Emits the context's <c>IUnitOfWork</c> (R12.1): a repository property per aggregate
    /// (in declaration order) plus <c>SaveChangesAsync</c>. A pure abstraction — no
    /// infrastructure type appears.
    /// </summary>
    private EmittedFile EmitUnitOfWork(EmitContext emit, string ns, IReadOnlyList<AggregateDecl> aggregates)
    {
        var sb = new StringBuilder();
        WriteXmlDoc(sb, "Transactional boundary over this context's aggregate repositories.", "");
        sb.Append("public interface IUnitOfWork\n{\n");
        foreach (AggregateDecl agg in aggregates)
        {
            // The repository lives in the aggregate's namespace; when that is a module
            // sub-namespace (R13.3), fully-qualify it so the base-namespace UoW resolves it.
            var aggNs = ModelIndex.NamespaceOf(ContextOf(ns), agg.ModulePath);
            var repo = aggNs == ns ? $"I{agg.RootName}Repository" : $"{aggNs}.I{agg.RootName}Repository";
            sb.Append(Indent).Append(repo).Append(' ').Append(Pluralize(agg.RootName)).Append(" { get; }\n");
        }
        sb.Append('\n');
        sb.Append(Indent).Append("Task<int> SaveChangesAsync(CancellationToken ct = default);\n");
        sb.Append("}\n");
        return new EmittedFile(PathFor(ns, KindFolder.Abstractions, "IUnitOfWork.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits a service's application boundary (R12.2): an <c>I&lt;Name&gt;</c> interface with one
    /// async method per use case (<c>Task</c> or <c>Task&lt;Result&gt;</c>), inputs mapped through
    /// the type mapper.
    /// </summary>
    private EmittedFile EmitApplicationService(EmitContext emit, ServiceDecl svc, string ns, CSharpTypeMapper typeMapper)
    {
        var iface = "I" + svc.Name;
        var sb = new StringBuilder();
        WriteXmlDoc(sb, svc.Doc ?? $"Application-service boundary for the {svc.Name} use cases.", "");
        sb.Append("public interface ").Append(iface).Append("\n{\n");

        var first = true;
        foreach (UseCaseDecl uc in svc.UseCases)
        {
            if (!first)
            {
                sb.Append('\n');
            }

            first = false;
            WriteXmlDoc(sb, uc.Doc, Indent);
            var ret = uc.ReturnType is null ? "Task" : $"Task<{typeMapper.Map(uc.ReturnType)}>";
            IEnumerable<string> args = uc.Parameters
                .Select(p => $"{typeMapper.Map(p.Type)} {CSharpNaming.ToCamelCase(p.Name)}")
                // The use case is an async boundary: flow cancellation, like every
                // other generated async seam (repositories, UoW, query handlers).
                .Append("CancellationToken ct = default");
            sb.Append(Indent).Append(ret).Append(' ').Append(CSharpNaming.ToPascalCase(uc.Name))
              .Append('(').Append(string.Join(", ", args)).Append(");\n");
        }

        sb.Append("}\n");
        return new EmittedFile(PathFor(ns, KindFolder.Services, $"{iface}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits a read model (R12.3): a value-equal <c>sealed record</c> of the projected
    /// fields plus a static <c>To&lt;Name&gt;(this Source src)</c> mapper. Direct fields map to
    /// the source property; derived fields translate their projection (rooted at <c>src</c>).
    /// </summary>
    private EmittedFile EmitReadModel(
        EmitContext emit,
        ReadModelDecl rm,
        string ns,
        ModelIndex index,
        CSharpTypeMapper typeMapper,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        // A read model emits into the base context namespace, so `ns` is the context used
        // to resolve its source (R13.2) when a type name is shared across contexts.
        var context = ContextOf(ns);
        IReadOnlyList<Member> sourceMembers = ReadModelSourceMembers(context, rm.SourceType, index);
        var translator = new CSharpExpressionTranslator(index, sourceMembers, enumMemberToType, memberReceiver: "src", context: context);

        var fields = new List<(string CsType, string Prop, string Rhs)>();
        foreach (ReadModelField f in rm.Fields)
        {
            var prop = CSharpNaming.ToPascalCase(f.Name);
            string csType, rhs;
            if (f.Projection is null)
            {
                // Direct field: type and value come from the like-named source member.
                csType = index.TryGetMemberType(context, rm.SourceType, f.Name, out TypeRef t) ? typeMapper.Map(t) : "object";
                rhs = $"src.{prop}";
            }
            else
            {
                csType = typeMapper.Map(f.Type!);
                var expectedEnum = index.Classify(f.Type!.Name) == TypeKind.Enum ? f.Type!.Name : null;
                rhs = translator.TranslateTopLevel(f.Projection, CSharpExpressionTranslator.NameMode.Property, expectedEnum);
            }
            fields.Add((csType, prop, rhs));
        }

        var sb = new StringBuilder();
        WriteXmlDoc(sb, rm.Doc, "");
        sb.Append("public sealed record ").Append(rm.Name).Append('(')
          .Append(string.Join(", ", fields.Select(f => $"{f.CsType} {f.Prop}"))).Append(");\n\n");

        WriteXmlDoc(sb, $"Projects {rm.SourceType} to {rm.Name}.", "");
        sb.Append("public static class ").Append(rm.Name).Append("Projection\n{\n");
        sb.Append(Indent).Append("public static ").Append(rm.Name).Append(" To").Append(rm.Name)
          .Append("(this ").Append(rm.SourceType).Append(" src)\n");
        sb.Append(Indent).Append(Indent).Append("=> new ").Append(rm.Name).Append('(')
          .Append(string.Join(", ", fields.Select(f => f.Rhs))).Append(");\n");
        sb.Append("}\n");

        var usesLinq = rm.Fields.Any(f => f.Projection is not null && ExprUsesLinq(f.Projection));
        return new EmittedFile(PathFor(ns, KindFolder.ReadModels, $"{rm.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq));
    }

    /// <summary>
    /// The members a read model projects from (entities add the synthetic <c>id</c>, unless
    /// the entity already declares its own <c>id</c> member).
    /// </summary>
    private static IReadOnlyList<Member> ReadModelSourceMembers(string context, string sourceType, ModelIndex index)
    {
        if (!index.TryGetDeclIn(context, sourceType, out TypeDecl decl) && !index.TryGetDecl(sourceType, out decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members.Any(m => string.Equals(m.Name, "id", StringComparison.OrdinalIgnoreCase))
                ? e.Members
                : e.Members.Append(new Member("id", new TypeRef(e.IdentityName), null)).ToList(),
            _ => Array.Empty<Member>()
        };
    }

    /// <summary>
    /// Emits a query object (R12.4): a <c>sealed record</c> carrying the criteria, handled via
    /// the generic runtime <c>IQueryHandler&lt;TQuery,TResult&gt;</c> (named in its doc).
    /// </summary>
    private EmittedFile EmitQuery(EmitContext emit, QueryDecl q, string ns, CSharpTypeMapper typeMapper)
    {
        var isList = q.ResultType.Name == ModelIndex.ListTypeName;
        var resultName = isList ? q.ResultType.Element!.Name : q.ResultType.Name;
        var resultType = isList ? $"IReadOnlyList<{resultName}>" : resultName;

        var sb = new StringBuilder();
        WriteXmlDoc(sb, q.Doc ?? $"Query returning {resultType}; implement IQueryHandler<{q.Name}, {resultType}>.", "");
        var criteria = string.Join(", ", q.Criteria.Select(p =>
            $"{typeMapper.Map(p.Type)} {CSharpNaming.ToPascalCase(p.Name)}"));
        sb.Append("public sealed record ").Append(q.Name).Append('(').Append(criteria).Append(");\n");

        return new EmittedFile(PathFor(ns, KindFolder.Queries, $"{q.Name}.cs"), Assemble(emit, ns, sb.ToString(), usesLinq: false));
    }

    /// <summary>True when the model declares any query object (gates the query-handler runtime type).</summary>
    private static bool HasQueries(KoineModel model) =>
        model.Contexts.SelectMany(c => c.AllTypeDecls()).OfType<QueryDecl>().Any();

    /// <summary>Emits the generic <c>IQueryHandler&lt;TQuery,TResult&gt;</c> once into Koine.Runtime (R12.4).</summary>
    private EmittedFile EmitQueryHandlerInterface(EmitContext emit)
    {
        var sb = new StringBuilder();
        sb.Append("/// <summary>Handles a query object, returning its typed result.</summary>\n");
        sb.Append("public interface IQueryHandler<TQuery, TResult>\n{\n");
        sb.Append(Indent).Append("Task<TResult> HandleAsync(TQuery query, CancellationToken ct = default);\n");
        sb.Append("}\n");
        return new EmittedFile($"{FolderFor(RuntimeNamespace)}/IQueryHandler.cs",
            Assemble(emit, RuntimeNamespace, sb.ToString(), usesLinq: false));
    }

    /// <summary>A small English pluralizer for repository property names (Order -&gt; Orders, Category -&gt; Categories).</summary>
    private static string Pluralize(string name)
    {
        if (name.Length == 0)
        {
            return name;
        }

        if (name.EndsWith("s", StringComparison.Ordinal) || name.EndsWith("x", StringComparison.Ordinal)
                                                         || name.EndsWith("z", StringComparison.Ordinal) || name.EndsWith("ch", StringComparison.Ordinal)
                                                         || name.EndsWith("sh", StringComparison.Ordinal))
        {
            return name + "es";
        }

        if (name.Length >= 2 && char.ToLowerInvariant(name[^1]) == 'y'
                             && "aeiou".IndexOf(char.ToLowerInvariant(name[^2])) < 0)
        {
            return name[..^1] + "ies";
        }

        return name + "s";
    }
}
