using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The <c>UnitOfWork</c> slice of the Java Infrastructure layer (issue #1726) — the Java analogue of
/// <c>PythonEmitter.EmitUnitOfWorkImpl</c> / <c>TypeScriptEmitter.EmitUnitOfWork</c>, completing the Java
/// backend as the last of the five code emitters to get one. One concrete, injectable-with-in-memory-
/// default class per bounded context: a field per aggregate root defaulting to its
/// <c>InMemory&lt;Root&gt;Repository</c>, and — only for a context that <c>publishes</c> an integration
/// event — the producer half of the transactional outbox (<c>enqueue</c> buffers an event, <c>saveChanges</c>
/// flushes each buffered event to the outbox and clears the buffer). A non-publishing context still gets a
/// <c>saveChanges</c> (a no-op), so a caller can call it unconditionally regardless of context.
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>
    /// Emits the per-context <c>UnitOfWork</c>: one repository field per aggregate root (declaration
    /// order, pluralized — <c>Order</c> → <c>orders</c>), each defaulting to a fresh
    /// <c>InMemory&lt;Root&gt;Repository</c> via the no-arg convenience constructor. The injectable
    /// constructor accepts every repository (and, for a publishing context, the outbox) as a parameter, so
    /// a future composition helper can hand this class the very same instances it constructed elsewhere —
    /// a caller holding the composition result then sees one consistent set of repository instances, not
    /// two independent sets.
    /// </summary>
    private EmittedFile EmitUnitOfWork(
        JavaEmitContext emit, string context, IReadOnlyList<AggregateDecl> aggregates, bool publishesEvents)
    {
        var roots = aggregates
            .Select(a => JavaNaming.Type(a.RootEntity()!.Name))
            .Select(root => (Root: root, Field: JavaNaming.Member(Pluralize(root))))
            .ToList();

        var sb = new StringBuilder();
        WriteJavadoc(
            sb,
            $"In-memory unit of work over the {context} context's aggregate repositories.",
            string.Empty);
        sb.Append("public final class UnitOfWork {\n");

        foreach (var (root, field) in roots)
        {
            sb.Append(Indent).Append("private final ").Append(root).Append("Repository ").Append(field)
              .Append(";\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append("private final ").Append(JavaRuntime.Package).Append(".OutboxStore outbox;\n");
            sb.Append(Indent).Append("private final java.util.List<Object> pending = new java.util.ArrayList<>();\n");
        }

        sb.Append('\n');
        WriteJavadoc(
            sb,
            "Creates a unit of work over a fresh in-memory repository per root"
            + (publishesEvents ? " and a fresh in-memory outbox." : "."),
            Indent);
        sb.Append(Indent).Append("public UnitOfWork() {\n");
        sb.Append(Indent).Append(Indent).Append("this(");
        sb.Append(string.Join(", ", roots.Select(r => $"new InMemory{r.Root}Repository()")));
        if (publishesEvents)
        {
            sb.Append(roots.Count > 0 ? ", " : string.Empty)
              .Append("new ").Append(JavaRuntime.Package).Append(".InMemoryOutboxStore()");
        }

        sb.Append(");\n");
        sb.Append(Indent).Append("}\n");

        sb.Append('\n');
        WriteJavadoc(
            sb,
            "Creates a unit of work over the supplied repositories" + (publishesEvents ? " and outbox." : "."),
            Indent);
        sb.Append(Indent).Append("public UnitOfWork(");
        var ctorParams = roots.Select(r => $"{r.Root}Repository {r.Field}").ToList();
        if (publishesEvents)
        {
            ctorParams.Add($"{JavaRuntime.Package}.OutboxStore outbox");
        }

        sb.Append(string.Join(", ", ctorParams)).Append(") {\n");
        foreach (var (_, field) in roots)
        {
            sb.Append(Indent).Append(Indent).Append("this.").Append(field).Append(" = ").Append(field).Append(";\n");
        }

        if (publishesEvents)
        {
            sb.Append(Indent).Append(Indent).Append("this.outbox = outbox;\n");
        }

        sb.Append(Indent).Append("}\n");

        if (publishesEvents)
        {
            sb.Append('\n');
            WriteJavadoc(sb, "Buffers integrationEvent to be flushed to the outbox on the next saveChanges.", Indent);
            sb.Append(Indent).Append("public void enqueue(Object integrationEvent) {\n");
            sb.Append(Indent).Append(Indent).Append("this.pending.add(integrationEvent);\n");
            sb.Append(Indent).Append("}\n");
        }

        sb.Append('\n');
        WriteJavadoc(
            sb,
            publishesEvents
                ? "Flushes every buffered integration event to the outbox."
                : "No-op: this context publishes nothing, so there is nothing to flush.",
            Indent);
        sb.Append(Indent).Append("public java.util.concurrent.CompletableFuture<Void> saveChanges() {\n");
        if (publishesEvents)
        {
            sb.Append(Indent).Append(Indent).Append("for (Object integrationEvent : this.pending) {\n");
            sb.Append(Indent).Append(Indent).Append(Indent).Append("this.outbox.add(")
              .Append(JavaRuntime.Package).Append(".OutboxMessage.of(integrationEvent));\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append(Indent).Append("this.pending.clear();\n");
        }

        sb.Append(Indent).Append(Indent).Append("return java.util.concurrent.CompletableFuture.completedFuture(null);\n");
        sb.Append(Indent).Append("}\n");

        sb.Append("}\n");
        return TypeFile(context, "UnitOfWork", sb.ToString());
    }

    /// <summary>
    /// A small English pluralizer for unit-of-work repository field names (<c>Order</c> → <c>orders</c>,
    /// <c>Category</c> → <c>categories</c>). Ported verbatim from the Python/TypeScript emitters' own
    /// private helper — Java has no pluralizer of its own yet.
    /// </summary>
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
