using System.Text;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The transactional-outbox slice of the Python Infrastructure layer (issue #241). For a context that
/// publishes at least one integration event, the emitter produces a per-context
/// <c>IntegrationEventDispatcher</c> that drains unprocessed <c>OutboxMessage</c> rows in order and hands
/// each to the single <c>IntegrationEventHandler</c> delivery seam, marking it processed — the out-of-band
/// half of the transactional-outbox pattern (the unit of work enqueues; the dispatcher delivers). The
/// shared <c>OutboxMessage</c> / <c>OutboxStore</c> / <c>InMemoryOutboxStore</c> / <c>IntegrationEventHandler</c>
/// primitives live once in <c>koine_infrastructure</c>, mirroring <c>CSharpEmitter.Infrastructure.Outbox.cs</c>.
/// A subscribe-only context gets no dispatcher.
/// </summary>
public sealed partial class PythonEmitter
{
    /// <summary>
    /// Emits the per-context <c>IntegrationEventDispatcher</c>: reads unprocessed outbox rows from the
    /// injected <c>OutboxStore</c>, delivers each to the <c>IntegrationEventHandler</c>, and marks it
    /// processed. Emitted only for a publishing context.
    /// </summary>
    private EmittedFile EmitIntegrationEventDispatcher(string contextName)
    {
        var sb = new StringBuilder();
        sb.Append("class IntegrationEventDispatcher:\n");
        WriteDoc(sb, $"Drains the {contextName} outbox and delivers each integration event to the handler in order.", Indent);
        sb.Append('\n');
        sb.Append(Indent).Append("def __init__(self, outbox: OutboxStore, handler: IntegrationEventHandler) -> None:\n");
        sb.Append(Indent).Append(Indent).Append("self._outbox = outbox\n");
        sb.Append(Indent).Append(Indent).Append("self._handler = handler\n");
        sb.Append('\n');
        sb.Append(Indent).Append("async def dispatch_pending(self) -> None:\n");
        sb.Append(Indent).Append(Indent).Append("for message in await self._outbox.unprocessed():\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("await self._handler.handle(message)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("await self._outbox.mark_processed(message)\n");

        var imports = new List<(string, string)>
        {
            (InfraModule, "IntegrationEventHandler"),
            (InfraModule, "OutboxStore"),
        };

        return new EmittedFile(
            PathFor(contextName, KindFolder.Infrastructure, "IntegrationEventDispatcher"),
            RenderPyInfra(sb.ToString(), Array.Empty<string>(), imports));
    }
}
