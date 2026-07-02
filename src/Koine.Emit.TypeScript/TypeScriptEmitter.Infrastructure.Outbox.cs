using System.Text;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The transactional-outbox slice of the TypeScript Infrastructure layer (issue #241). For a context
/// that publishes at least one integration event, the emitter produces a per-context
/// <c>IntegrationEventDispatcher</c> that drains unprocessed <c>OutboxMessage</c> rows in order and hands
/// each to the single <c>IntegrationEventHandler</c> delivery seam, marking it processed — the out-of-band
/// half of the transactional-outbox pattern (the unit of work enqueues; the dispatcher delivers). The
/// shared <c>OutboxMessage</c> / <c>OutboxStore</c> / <c>InMemoryOutboxStore</c> / <c>IntegrationEventHandler</c>
/// primitives live once in the <c>infrastructure-runtime</c> module, mirroring
/// <c>CSharpEmitter.Infrastructure.Outbox.cs</c>. A subscribe-only context gets no dispatcher.
///
/// <para>Delivery is decoupled from the concrete <c>IHandle&lt;Event&gt;</c> subscriber seams on purpose:
/// those live in the <em>subscriber</em> contexts, and a publisher must not depend on its subscribers.
/// The consumer wires the single <c>IntegrationEventHandler</c> to fan out to its handlers.</para>
/// </summary>
public sealed partial class TypeScriptEmitter
{
    /// <summary>
    /// Emits the per-context <c>IntegrationEventDispatcher</c>: reads unprocessed outbox rows from the
    /// injected <c>OutboxStore</c>, delivers each to the <c>IntegrationEventHandler</c>, and marks it
    /// processed. Emitted only for a publishing context.
    /// </summary>
    private EmittedFile EmitIntegrationEventDispatcher(string contextName)
    {
        var folder = InfraFolder(contextName);

        var sb = new StringBuilder();
        WriteDoc(sb, $"Drains the {contextName} outbox and delivers each integration event to the handler in order.", "");
        sb.Append("export class IntegrationEventDispatcher {\n");
        sb.Append(Indent).Append("constructor(\n");
        sb.Append(Indent).Append(Indent).Append("private readonly outbox: OutboxStore,\n");
        sb.Append(Indent).Append(Indent).Append("private readonly handler: IntegrationEventHandler,\n");
        sb.Append(Indent).Append(") {}\n\n");
        sb.Append(Indent).Append("async dispatchPending(): Promise<void> {\n");
        sb.Append(Indent).Append(Indent).Append("const pending = await this.outbox.unprocessed();\n");
        sb.Append(Indent).Append(Indent).Append("for (const message of pending) {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("await this.handler.handle(message);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("await this.outbox.markProcessed(message);\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, "IntegrationEventDispatcher"),
            RenderInfraFile(folder, sb.ToString(), InfraRuntimeImports(contextName, "IntegrationEventHandler", "OutboxStore")));
    }
}
