using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The repository + unit-of-work slice of the TypeScript Infrastructure layer (issue #241): concrete
/// realizations of the <c>I&lt;Root&gt;Repository</c> and per-context <c>IUnitOfWork</c> contracts the
/// domain layer already emits, backed by an injectable <see cref="TsRuntime.InfrastructureModuleName"/>
/// <c>AggregateStore</c> (in-memory by default). Declarative finders become concrete in-memory queries
/// (structural equality on each parameter that matches a root property), mirroring
/// <c>CSharpEmitter.Infrastructure.Repositories.cs</c>.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    /// <summary>
    /// Emits <c>&lt;Root&gt;Repository implements I&lt;Root&gt;Repository</c> over an injectable
    /// <c>AggregateStore</c>: <c>getById</c> via the store, the configured add/update/remove (default
    /// add/update/remove), and each finder as a concrete in-memory query. The store defaults to a
    /// zero-dependency <c>InMemoryStore</c> keyed on the root's branded id, so the repository is runnable
    /// in tests out of the box; a team injects a persistent store to back it with a real datastore.
    /// </summary>
    private EmittedFile EmitRepositoryImpl(TsEmitContext emit, string contextName, AggregateDecl agg, TypeScriptTypeMapper typeMapper)
    {
        EntityDecl root = agg.RootEntity()!;
        var rootName = TypeScriptNaming.ToPascalCase(root.Name);
        var idType = TypeScriptNaming.ToPascalCase(root.IdentityName);
        var iface = $"I{rootName}Repository";
        var className = $"{rootName}Repository";
        var aggNs = ModelIndex.NamespaceOf(contextName, agg.ModulePath);
        var folder = InfraFolder(contextName);

        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();
        var rootProps = new HashSet<string>(
            root.Members.Select(m => TypeScriptNaming.ToCamelCase(m.Name)), StringComparer.Ordinal) { "id" };

        var sb = new StringBuilder();
        WriteDoc(sb, $"In-memory-backed repository for the {rootName} aggregate root. Inject a persistent "
            + "AggregateStore to back it with a real datastore; the default in-memory store is runnable in tests.", "");
        sb.Append("export class ").Append(className).Append(" implements ").Append(iface).Append(" {\n");
        sb.Append(Indent).Append("constructor(\n");
        sb.Append(Indent).Append(Indent).Append("private readonly store: AggregateStore<").Append(idType).Append(", ")
          .Append(rootName).Append("> = new InMemoryStore<").Append(idType).Append(", ").Append(rootName)
          .Append(">((entity) => entity.id),\n");
        sb.Append(Indent).Append(") {}\n");

        if (ops.Contains("getById"))
        {
            sb.Append('\n');
            sb.Append(Indent).Append("getById(id: ").Append(idType).Append("): Promise<").Append(rootName).Append(" | undefined> {\n");
            sb.Append(Indent).Append(Indent).Append("return this.store.get(id);\n");
            sb.Append(Indent).Append("}\n");
        }

        foreach (var op in new[] { "add", "update", "remove" })
        {
            if (!ops.Contains(op))
            {
                continue;
            }

            sb.Append('\n');
            sb.Append(Indent).Append(op).Append("(aggregate: ").Append(rootName).Append("): Promise<void> {\n");
            sb.Append(Indent).Append(Indent).Append("return this.store.").Append(op).Append("(aggregate);\n");
            sb.Append(Indent).Append("}\n");
        }

        foreach (FinderDecl finder in finders)
        {
            WriteFinderImpl(sb, rootName, finder, rootProps, typeMapper);
        }

        sb.Append("}\n");

        var imports = new List<(string, string)>
        {
            (rootName, ImportSpecifier(folder, ModulePathFor(aggNs, KindFolder.Root, rootName))),
            (idType, ImportSpecifier(folder, ModulePathFor(aggNs, KindFolder.ValueObjects, idType))),
            (iface, ImportSpecifier(folder, ModulePathFor(aggNs, KindFolder.Repositories, iface))),
        };
        imports.AddRange(InfraRuntimeImports(contextName, "AggregateStore", "InMemoryStore"));
        foreach (FinderDecl finder in finders)
        {
            foreach (Param p in finder.Parameters)
            {
                imports.AddRange(FinderParamImports(emit, contextName, folder, p.Type, typeMapper));
            }
        }

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, className),
            RenderInfraFile(folder, sb.ToString(), imports));
    }

    /// <summary>
    /// Writes a declarative finder as a concrete in-memory query: each parameter that matches a root
    /// property (by camelCase name) becomes a <c>structuralEquals</c> filter; a list finder returns the
    /// filtered array, a single finder the first match. A parameter with no matching property is left in
    /// the signature for the developer to wire up (the generated query ignores it), mirroring the C#
    /// emitter's convention.
    /// </summary>
    private void WriteFinderImpl(StringBuilder sb, string rootName, FinderDecl finder, ISet<string> rootProps, TypeScriptTypeMapper typeMapper)
    {
        var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
        var method = TypeScriptNaming.ToCamelCase(finder.Name);
        var paramList = string.Join(", ", finder.Parameters.Select(p =>
            $"{TypeScriptNaming.ToCamelCase(p.Name)}: {typeMapper.Map(p.Type)}"));
        var predicate = string.Join(" && ", finder.Parameters
            .Where(p => rootProps.Contains(TypeScriptNaming.ToCamelCase(p.Name)))
            .Select(p =>
            {
                var camel = TypeScriptNaming.ToCamelCase(p.Name);
                return $"structuralEquals(entity.{camel}, {camel})";
            }));
        var ret = isList ? $"Promise<readonly {rootName}[]>" : $"Promise<{rootName} | undefined>";

        sb.Append('\n');
        sb.Append(Indent).Append("async ").Append(method).Append('(').Append(paramList).Append("): ").Append(ret).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append("const all = await this.store.all();\n");
        if (isList)
        {
            sb.Append(Indent).Append(Indent).Append(predicate.Length > 0
                ? $"return all.filter((entity) => {predicate});\n"
                : "return all;\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append(predicate.Length > 0
                ? $"return all.find((entity) => {predicate});\n"
                : "return all[0];\n");
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits <c>UnitOfWork implements IUnitOfWork</c>: one repository-typed property per aggregate root
    /// (declaration order, pluralized like the contract), each defaulting to its concrete repository so
    /// the unit of work is runnable with no wiring, plus <c>saveChangesAsync</c>. A publishing context's
    /// unit of work additionally enqueues integration events and flushes them to the outbox inside
    /// <c>saveChangesAsync</c> (the transactional-outbox enqueue seam).
    /// </summary>
    private EmittedFile EmitUnitOfWorkImpl(string contextName, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var folder = InfraFolder(contextName);

        var sb = new StringBuilder();
        WriteDoc(sb, $"In-memory unit of work over the {contextName} context's aggregate repositories.", "");
        sb.Append("export class UnitOfWork implements IUnitOfWork {\n");
        if (publishesEvents)
        {
            sb.Append(Indent).Append("private readonly pending: object[] = [];\n\n");
        }

        sb.Append(Indent).Append("constructor(\n");
        foreach (AggregateDecl agg in aggregates)
        {
            var rootName = TypeScriptNaming.ToPascalCase(agg.RootEntity()!.Name);
            var prop = TypeScriptNaming.ToCamelCase(Pluralize(rootName));
            sb.Append(Indent).Append(Indent).Append("readonly ").Append(prop).Append(": I").Append(rootName)
              .Append("Repository = new ").Append(rootName).Append("Repository(),\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append(Indent).Append("private readonly outbox: OutboxStore = new InMemoryOutboxStore(),\n");
        }

        sb.Append(Indent).Append(") {}\n");

        if (publishesEvents)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("/** Enqueues an integration event to be written to the outbox on the next saveChangesAsync. */\n");
            sb.Append(Indent).Append("enqueue(integrationEvent: object): void {\n");
            sb.Append(Indent).Append(Indent).Append("this.pending.push(integrationEvent);\n");
            sb.Append(Indent).Append("}\n\n");
            sb.Append(Indent).Append("async saveChangesAsync(): Promise<void> {\n");
            sb.Append(Indent).Append(Indent).Append("for (const integrationEvent of this.pending) {\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("await this.outbox.add(OutboxMessage.from(integrationEvent));\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append(Indent).Append("this.pending.length = 0;\n");
            sb.Append(Indent).Append("}\n");
        }
        else
        {
            sb.Append('\n');
            sb.Append(Indent).Append("saveChangesAsync(): Promise<void> {\n");
            sb.Append(Indent).Append(Indent).Append("return Promise.resolve();\n");
            sb.Append(Indent).Append("}\n");
        }

        sb.Append("}\n");

        var imports = new List<(string, string)>
        {
            ("IUnitOfWork", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Abstractions, "IUnitOfWork"))),
        };
        foreach (AggregateDecl agg in aggregates)
        {
            var rootName = TypeScriptNaming.ToPascalCase(agg.RootEntity()!.Name);
            var aggNs = ModelIndex.NamespaceOf(contextName, agg.ModulePath);
            imports.Add(($"I{rootName}Repository", ImportSpecifier(folder, ModulePathFor(aggNs, KindFolder.Repositories, $"I{rootName}Repository"))));
            imports.Add(($"{rootName}Repository", ImportSpecifier(folder, ModulePathFor(contextName, KindFolder.Infrastructure, $"{rootName}Repository"))));
        }

        if (publishesEvents)
        {
            imports.AddRange(InfraRuntimeImports(contextName, "OutboxMessage", "OutboxStore", "InMemoryOutboxStore"));
        }

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, "UnitOfWork"),
            RenderInfraFile(folder, sb.ToString(), imports));
    }
}
