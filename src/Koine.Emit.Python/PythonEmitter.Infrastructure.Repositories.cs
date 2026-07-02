using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The repository + unit-of-work slice of the Python Infrastructure layer (issue #241): concrete
/// implementations of the <c>&lt;Root&gt;Repository</c> protocols the domain layer already emits, backed
/// by an injectable <c>koine_infrastructure.AggregateStore</c> (in-memory by default), plus a concrete
/// per-context <c>UnitOfWork</c>. Declarative finders become concrete in-memory queries (value equality
/// on each parameter that matches a root property), mirroring <c>CSharpEmitter.Infrastructure.Repositories.cs</c>.
/// </summary>
public sealed partial class PythonEmitter
{
    /// <summary>
    /// Emits <c>&lt;Root&gt;RepositoryImpl(&lt;Root&gt;Repository)</c> over an injectable
    /// <c>AggregateStore</c>: <c>get</c>, the configured mutating ops (<c>save</c>/<c>update</c>/<c>remove</c>),
    /// and each finder as a concrete in-memory query. The store defaults to a zero-dependency
    /// <c>InMemoryStore</c> keyed on the root's (hashable) identity, so the repository is runnable in tests
    /// out of the box; a team injects a persistent store to back it with a real datastore.
    /// </summary>
    private EmittedFile EmitRepositoryImpl(PyEmitContext emit, string contextName, AggregateDecl agg, PythonTypeMapper typeMapper)
    {
        EntityDecl root = agg.RootEntity()!;
        var rootName = PythonNaming.ToPascalCase(root.Name);
        var idType = PythonNaming.ToPascalCase(root.IdentityName);
        var protocol = $"{rootName}Repository";
        var className = $"{rootName}RepositoryImpl";
        var aggNs = ModelIndex.NamespaceOf(contextName, agg.ModulePath);

        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();
        var rootProps = new HashSet<string>(
            root.Members.Select(m => PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name))), StringComparer.Ordinal)
        {
            "id",
        };

        var sb = new StringBuilder();
        sb.Append("class ").Append(className).Append('(').Append(protocol).Append("):\n");
        WriteDoc(sb, $"In-memory-backed repository for the {rootName} aggregate root. Inject a persistent "
            + "AggregateStore to back it with a real datastore; the default in-memory store is runnable in tests.", Indent);
        sb.Append('\n');

        sb.Append(Indent).Append("def __init__(self, store: AggregateStore[").Append(idType).Append(", ").Append(rootName).Append("] | None = None) -> None:\n");
        sb.Append(Indent).Append(Indent).Append("self._store: AggregateStore[").Append(idType).Append(", ").Append(rootName).Append("] = (\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("store if store is not None else InMemoryStore[")
          .Append(idType).Append(", ").Append(rootName).Append("](lambda entity: entity.id)\n");
        sb.Append(Indent).Append(Indent).Append(")\n");

        if (ops.Contains("getById"))
        {
            sb.Append('\n');
            sb.Append(Indent).Append("async def get(self, id: ").Append(idType).Append(") -> ").Append(rootName).Append(" | None:\n");
            sb.Append(Indent).Append(Indent).Append("return await self._store.get(id)\n");
        }

        foreach (var (op, method, storeMethod) in new[] { ("add", "save", "add"), ("update", "update", "update"), ("remove", "remove", "remove") })
        {
            if (!ops.Contains(op))
            {
                continue;
            }

            sb.Append('\n');
            sb.Append(Indent).Append("async def ").Append(method).Append("(self, aggregate: ").Append(rootName).Append(") -> None:\n");
            sb.Append(Indent).Append(Indent).Append("await self._store.").Append(storeMethod).Append("(aggregate)\n");
        }

        var imports = new List<(string, string)>
        {
            (InfraModule, "AggregateStore"),
            (InfraModule, "InMemoryStore"),
            (ModuleDottedFor(aggNs, KindFolder.Root, rootName), rootName),
            (ModuleDottedFor(aggNs, KindFolder.ValueObjects, idType), idType),
            (ModuleDottedFor(aggNs, KindFolder.Repositories, protocol), protocol),
        };

        foreach (FinderDecl finder in finders)
        {
            WriteFinderImpl(emit, sb, contextName, rootName, finder, rootProps, typeMapper, imports);
        }

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, className),
            RenderPyInfra(sb.ToString(), Array.Empty<string>(), imports));
    }

    /// <summary>
    /// Writes a declarative finder as a concrete in-memory query: each parameter that matches a root
    /// property (by snake_case name) becomes a value-equality filter; a list finder returns a
    /// <c>tuple[&lt;Root&gt;, ...]</c>, a single finder the first match or <c>None</c>. A parameter with no
    /// matching property is left in the signature (the generated query ignores it), mirroring the C# emitter.
    /// </summary>
    private void WriteFinderImpl(
        PyEmitContext emit, StringBuilder sb, string contextName, string rootName, FinderDecl finder,
        ISet<string> rootProps, PythonTypeMapper typeMapper, List<(string, string)> imports)
    {
        var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
        var method = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(finder.Name));
        var paramList = string.Join(", ", finder.Parameters.Select(p =>
            $"{PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name))}: {typeMapper.Map(p.Type)}"));
        if (paramList.Length > 0)
        {
            paramList = ", " + paramList;
        }

        var predicate = string.Join(" and ", finder.Parameters
            .Where(p => rootProps.Contains(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name))))
            .Select(p =>
            {
                var snake = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(p.Name));
                return $"entity.{snake} == {snake}";
            }));
        var ret = isList ? $"tuple[{rootName}, ...]" : $"{rootName} | None";

        sb.Append('\n');
        sb.Append(Indent).Append("async def ").Append(method).Append("(self").Append(paramList).Append(") -> ").Append(ret).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("items = await self._store.all()\n");
        if (isList)
        {
            sb.Append(Indent).Append(Indent).Append(predicate.Length > 0
                ? $"return tuple(entity for entity in items if {predicate})\n"
                : "return items\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append(predicate.Length > 0
                ? $"return next((entity for entity in items if {predicate}), None)\n"
                : "return items[0] if items else None\n");
        }

        // Import each user-declared type the finder's parameters mention (value object / enum / ID).
        foreach (Param p in finder.Parameters)
        {
            foreach (System.Text.RegularExpressions.Match m in IdentifierRegex.Matches(typeMapper.Map(p.Type)))
            {
                if (ResolvePyModule(emit, contextName, m.Value) is { } module)
                {
                    imports.Add((module, m.Value));
                }
            }
        }
    }

    /// <summary>
    /// Emits the concrete per-context <c>UnitOfWork</c>: one repository attribute per aggregate root
    /// (declaration order, pluralized), each defaulting to its concrete <c>&lt;Root&gt;RepositoryImpl</c>
    /// so the unit of work is runnable with no wiring, plus an async <c>save_changes</c>. A publishing
    /// context's unit of work additionally enqueues integration events and flushes them to the outbox
    /// inside <c>save_changes</c> (the transactional-outbox enqueue seam).
    /// </summary>
    private EmittedFile EmitUnitOfWorkImpl(string contextName, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var roots = aggregates
            .Select(a => PythonNaming.ToPascalCase(a.RootEntity()!.Name))
            .Select(root => (Root: root, Attr: PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(Pluralize(root)))))
            .ToList();

        var sb = new StringBuilder();
        sb.Append("class UnitOfWork:\n");
        WriteDoc(sb, $"In-memory unit of work over the {contextName} context's aggregate repositories.", Indent);
        sb.Append('\n');

        foreach (var (root, attr) in roots)
        {
            sb.Append(Indent).Append(attr).Append(": ").Append(root).Append("Repository\n");
        }

        sb.Append('\n');
        sb.Append(Indent).Append("def __init__(\n");
        sb.Append(Indent).Append(Indent).Append("self,\n");
        foreach (var (root, attr) in roots)
        {
            sb.Append(Indent).Append(Indent).Append(attr).Append(": ").Append(root).Append("Repository | None = None,\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append(Indent).Append("outbox: OutboxStore | None = None,\n");
        }

        sb.Append(Indent).Append(") -> None:\n");
        foreach (var (root, attr) in roots)
        {
            sb.Append(Indent).Append(Indent).Append("self.").Append(attr).Append(" = ").Append(attr)
              .Append(" if ").Append(attr).Append(" is not None else ").Append(root).Append("RepositoryImpl()\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append(Indent).Append("self._outbox: OutboxStore = outbox if outbox is not None else InMemoryOutboxStore()\n");
            sb.Append(Indent).Append(Indent).Append("self._pending: list[object] = []\n");
            sb.Append('\n');
            sb.Append(Indent).Append("def enqueue(self, integration_event: object) -> None:\n");
            sb.Append(Indent).Append(Indent).Append("\"\"\"Enqueues an integration event to be written to the outbox on the next save_changes.\"\"\"\n");
            sb.Append(Indent).Append(Indent).Append("self._pending.append(integration_event)\n");
            sb.Append('\n');
            sb.Append(Indent).Append("async def save_changes(self) -> None:\n");
            sb.Append(Indent).Append(Indent).Append("for integration_event in self._pending:\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("await self._outbox.add(OutboxMessage.of(integration_event))\n");
            sb.Append(Indent).Append(Indent).Append("self._pending.clear()\n");
        }
        else
        {
            sb.Append('\n');
            sb.Append(Indent).Append("async def save_changes(self) -> None:\n");
            sb.Append(Indent).Append(Indent).Append("return None\n");
        }

        var imports = new List<(string, string)>();
        foreach (AggregateDecl agg in aggregates)
        {
            var root = PythonNaming.ToPascalCase(agg.RootEntity()!.Name);
            var aggNs = ModelIndex.NamespaceOf(contextName, agg.ModulePath);
            imports.Add((ModuleDottedFor(aggNs, KindFolder.Repositories, $"{root}Repository"), $"{root}Repository"));
            imports.Add((InfraModuleDotted(contextName, $"{root}RepositoryImpl"), $"{root}RepositoryImpl"));
        }

        if (publishesEvents)
        {
            imports.Add((InfraModule, "InMemoryOutboxStore"));
            imports.Add((InfraModule, "OutboxMessage"));
            imports.Add((InfraModule, "OutboxStore"));
        }

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, "UnitOfWork"),
            RenderPyInfra(sb.ToString(), Array.Empty<string>(), imports));
    }
}
