using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The opt-in Infrastructure layer of <see cref="JavaEmitter"/> (issue #241's
/// <c>--layers infrastructure</c>, brought to Java in #1090) — the Java analogue of
/// <c>PythonEmitter.Infrastructure.*.cs</c> and <c>CSharpEmitter.Infrastructure.*.cs</c>. It realizes,
/// dependency-free, the persistence-ignorant contracts the domain layer already emits: a concrete
/// in-memory repository per aggregate root over an injectable <c>koine.runtime.AggregateStore</c>, and —
/// for a context that publishes an integration event — the out-of-band half of the transactional outbox.
/// <para>
/// Off by default, so the domain output stays byte-identical to Phase 1's. The shared primitives
/// (<c>AggregateStore</c>, <c>InMemoryStore</c>, <c>OutboxMessage</c>, <c>OutboxStore</c>,
/// <c>InMemoryOutboxStore</c>, <c>IntegrationEventHandler</c>) ship once into <c>koine.runtime</c>, and
/// only when the layer emits something.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>
    /// Emits the Infrastructure layer for every bounded context that has at least one aggregate whose root
    /// is an entity — the same gate as the repository contract emission. A model with none produces
    /// nothing extra (and no error). The shared runtime primitives are emitted once, only if anything else
    /// was.
    /// </summary>
    private void EmitInfrastructure(JavaEmitContext emit, KoineModel model, List<EmittedFile> files)
    {
        var anyEmitted = false;
        foreach (ContextNode ctx in model.Contexts)
        {
            var aggregates = ctx.Types.OfType<AggregateDecl>()
                .Where(a => a.RootEntity() is not null)
                .ToList();
            if (aggregates.Count == 0)
            {
                continue;
            }

            anyEmitted = true;
            var publishesEvents = ctx.Publishes.Count > 0;

            foreach (AggregateDecl agg in aggregates)
            {
                files.Add(EmitInMemoryRepository(emit, ctx.Name, agg));
            }

            files.Add(EmitUnitOfWork(emit, ctx.Name, aggregates, publishesEvents));

            // Only a PUBLISHING context needs to drain an outbox; a subscribe-only context gets none.
            if (publishesEvents)
            {
                files.Add(EmitIntegrationEventDispatcher(ctx.Name));
            }
        }

        if (!anyEmitted)
        {
            return;
        }

        files.Add(new EmittedFile(JavaRuntime.AggregateStoreFileName, JavaRuntime.AggregateStoreSource + "\n"));
        files.Add(new EmittedFile(JavaRuntime.InMemoryStoreFileName, JavaRuntime.InMemoryStoreSource + "\n"));
        files.Add(new EmittedFile(JavaRuntime.OutboxMessageFileName, JavaRuntime.OutboxMessageSource + "\n"));
        files.Add(new EmittedFile(JavaRuntime.OutboxStoreFileName, JavaRuntime.OutboxStoreSource + "\n"));
        files.Add(new EmittedFile(JavaRuntime.InMemoryOutboxStoreFileName, JavaRuntime.InMemoryOutboxStoreSource + "\n"));
        files.Add(new EmittedFile(
            JavaRuntime.IntegrationEventHandlerFileName, JavaRuntime.IntegrationEventHandlerSource + "\n"));
    }

    /// <summary>
    /// Emits <c>InMemory&lt;Root&gt;Repository implements &lt;Root&gt;Repository</c> over an injectable
    /// <c>AggregateStore</c>: the CONFIGURED operations only (implementing one the contract does not
    /// declare would not override anything), plus each declarative finder as a concrete in-memory query.
    /// The no-arg constructor defaults the store to a zero-dependency <c>InMemoryStore</c> keyed on the
    /// root's own identity accessor, so the repository is runnable in tests out of the box; injecting a
    /// persistent store backs it with a real datastore without touching this class.
    /// </summary>
    private EmittedFile EmitInMemoryRepository(JavaEmitContext emit, string context, AggregateDecl agg)
    {
        EntityDecl root = agg.RootEntity()!;
        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);
        var rootName = JavaNaming.Type(root.Name);
        var idType = JavaNaming.Type(root.IdentityName);
        var contract = rootName + "Repository";
        var className = "InMemory" + contract;
        var storeType = $"{JavaRuntime.Package}.AggregateStore<{idType}, {rootName}>";

        IReadOnlyList<string> ops = agg.Repository?.Operations ?? DefaultRepositoryOps;
        IReadOnlyList<FinderDecl> finders = agg.Repository?.Finders ?? Array.Empty<FinderDecl>();

        // The root's member accessors a finder parameter can filter on, including the synthetic `id`.
        var rootAccessors = new HashSet<string>(
            root.Members.Select(m => JavaNaming.Member(m.Name)), StringComparer.Ordinal)
        {
            "id",
        };

        var sb = new StringBuilder();
        WriteJavadoc(
            sb,
            $"In-memory-backed repository for the {rootName} aggregate root. Inject a persistent "
            + "AggregateStore to back it with a real datastore; the default in-memory store is runnable "
            + "in tests.",
            string.Empty);
        sb.Append("public final class ").Append(className).Append(" implements ").Append(contract).Append(" {\n");
        sb.Append(Indent).Append("private final ").Append(storeType).Append(" store;\n");

        sb.Append('\n');
        WriteJavadoc(sb, "Creates a repository over the default in-memory store.", Indent);
        sb.Append(Indent).Append("public ").Append(className).Append("() {\n");
        sb.Append(Indent).Append(Indent).Append("this(new ").Append(JavaRuntime.Package).Append(".InMemoryStore<>(")
          .Append(rootName).Append("::id));\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        WriteJavadoc(sb, "Creates a repository over the supplied store.", Indent);
        sb.Append(Indent).Append("public ").Append(className).Append('(').Append(storeType).Append(" store) {\n");
        sb.Append(Indent).Append(Indent).Append("this.store = store;\n");
        sb.Append(Indent).Append("}\n");

        if (ops.Contains("getById"))
        {
            sb.Append('\n');
            WriteOverride(sb);
            sb.Append(Indent).Append("public java.util.Optional<").Append(rootName).Append("> getById(")
              .Append(idType).Append(" id) {\n");
            sb.Append(Indent).Append(Indent).Append("return this.store.get(id);\n");
            sb.Append(Indent).Append("}\n");
        }

        // `add`/`update` take the aggregate and forward to the like-named store method, so one loop
        // covers both; `remove` differs (it takes the identity) and is written out below.
        foreach (var op in new[] { "add", "update" })
        {
            if (!ops.Contains(op))
            {
                continue;
            }

            sb.Append('\n');
            WriteOverride(sb);
            sb.Append(Indent).Append("public void ").Append(op).Append('(').Append(rootName)
              .Append(" aggregate) {\n");
            sb.Append(Indent).Append(Indent).Append("this.store.").Append(op).Append("(aggregate);\n");
            sb.Append(Indent).Append("}\n");
        }

        if (ops.Contains("remove"))
        {
            sb.Append('\n');
            WriteOverride(sb);
            sb.Append(Indent).Append("public void remove(").Append(idType).Append(" id) {\n");
            sb.Append(Indent).Append(Indent).Append("this.store.remove(id);\n");
            sb.Append(Indent).Append("}\n");
        }

        foreach (FinderDecl finder in finders)
        {
            sb.Append('\n');
            WriteFinderImpl(sb, rootName, finder, rootAccessors, typeMapper);
        }

        sb.Append("}\n");
        return TypeFile(context, className, sb.ToString());
    }

    /// <summary>
    /// Writes a declarative finder as a concrete in-memory query over the store's snapshot: every
    /// parameter whose name matches a root member accessor becomes a value-equality filter (via
    /// <c>Objects.equals</c>, correct for the branded records and boxed values these types are). A list
    /// finder returns <c>java.util.List</c>, a single finder <c>java.util.Optional</c> — matching the
    /// shapes the emitted contract declares. A parameter with no matching member stays in the signature
    /// and is simply not filtered on, mirroring the C#/Python emitters.
    /// </summary>
    private static void WriteFinderImpl(
        StringBuilder sb, string rootName, FinderDecl finder, ISet<string> rootAccessors, JavaTypeMapper typeMapper)
    {
        var isList = finder.ResultType.Name == ModelIndex.ListTypeName;
        var method = JavaNaming.Member(finder.Name);
        var returnType = isList ? $"java.util.List<{rootName}>" : $"java.util.Optional<{rootName}>";
        var paramList = string.Join(
            ", ",
            finder.Parameters.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));

        WriteOverride(sb);
        sb.Append(Indent).Append("public ").Append(returnType).Append(' ').Append(method).Append('(')
          .Append(paramList).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append("return this.store.all().stream()\n");

        foreach (Param p in finder.Parameters)
        {
            var accessor = JavaNaming.Member(p.Name);
            if (!rootAccessors.Contains(accessor))
            {
                continue;
            }

            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append(".filter(entity -> java.util.Objects.equals(entity.").Append(accessor).Append("(), ")
              .Append(accessor).Append("))\n");
        }

        sb.Append(Indent).Append(Indent).Append(Indent).Append(isList ? ".toList();\n" : ".findFirst();\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Emits the per-context <c>IntegrationEventDispatcher</c>: drains the undelivered outbox rows in
    /// order, hands each to the single <c>IntegrationEventHandler</c> delivery seam, and marks it
    /// processed — the out-of-band half of the transactional outbox (the producer appends; this
    /// delivers). Emitted only for a publishing context.
    /// </summary>
    private EmittedFile EmitIntegrationEventDispatcher(string context)
    {
        const string className = "IntegrationEventDispatcher";

        var sb = new StringBuilder();
        WriteJavadoc(
            sb,
            $"Drains the {context} outbox and delivers each integration event to the handler, in order. "
            + "A handler that throws leaves its row undelivered, so the next run retries it.",
            string.Empty);
        sb.Append("public final class ").Append(className).Append(" {\n");
        sb.Append(Indent).Append("private final ").Append(JavaRuntime.Package).Append(".OutboxStore outbox;\n");
        sb.Append(Indent).Append("private final ").Append(JavaRuntime.Package)
          .Append(".IntegrationEventHandler handler;\n");

        sb.Append('\n');
        sb.Append(Indent).Append("public ").Append(className).Append('(')
          .Append(JavaRuntime.Package).Append(".OutboxStore outbox, ")
          .Append(JavaRuntime.Package).Append(".IntegrationEventHandler handler) {\n");
        sb.Append(Indent).Append(Indent).Append("this.outbox = outbox;\n");
        sb.Append(Indent).Append(Indent).Append("this.handler = handler;\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        WriteJavadoc(sb, "Delivers every undelivered outbox row, marking each processed as it goes.", Indent);
        sb.Append(Indent).Append("public void dispatchPending() {\n");
        sb.Append(Indent).Append(Indent).Append("for (").Append(JavaRuntime.Package)
          .Append(".OutboxMessage message : this.outbox.unprocessed()) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("this.handler.handle(message);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("this.outbox.markProcessed(message);\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");

        sb.Append("}\n");
        return TypeFile(context, className, sb.ToString());
    }

    /// <summary>Writes the <c>@Override</c> annotation at member indentation.</summary>
    private static void WriteOverride(StringBuilder sb) => sb.Append(Indent).Append("@Override\n");
}
