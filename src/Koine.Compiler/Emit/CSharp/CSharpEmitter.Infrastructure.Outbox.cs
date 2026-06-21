using System.Text;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The transactional-outbox slice of the EF Core Infrastructure layer (issue #128). For a context that
/// publishes at least one integration event, the emitter produces an <c>OutboxMessage</c> table (written
/// in the same <c>SaveChangesAsync</c> as the aggregate change, so an event is never lost), an
/// <c>IIntegrationEventHandler</c> delivery seam, and a drainable <c>IntegrationEventDispatcher</c> that
/// reads unprocessed rows and hands each event to the seam. A subscribe-only context gets none of this.
///
/// <para>Delivery is decoupled from the concrete <c>IHandle&lt;Event&gt;</c> subscriber seams on purpose:
/// those live in the <em>subscriber</em> contexts, and a publisher must not depend on its subscribers.
/// The consumer wires the single <c>IIntegrationEventHandler</c> to fan out to its handlers.</para>
/// </summary>
public sealed partial class CSharpEmitter
{
    /// <summary>The EF Core namespace the dispatcher's outbox query needs.</summary>
    private static readonly string[] DispatcherUsings = { "Microsoft.EntityFrameworkCore" };

    /// <summary>The serialization namespace the outbox message needs.</summary>
    private static readonly string[] OutboxMessageUsings = { "System.Text.Json" };

    /// <summary>
    /// Emits the <c>OutboxMessage</c> entity: an opaque, serialized record of a published integration
    /// event, with a <c>From</c> factory (serialize) and <c>Deserialize</c> (rehydrate by type), plus a
    /// <c>ProcessedOn</c> marker the dispatcher stamps once delivered.
    /// </summary>
    private EmittedFile EmitOutboxMessage(EmitContext emit, string context)
    {
        var sb = new StringBuilder();
        WriteXmlDoc(sb, "A persisted, serialized integration event awaiting dispatch (transactional outbox).", "");
        sb.Append("public sealed class OutboxMessage\n{\n");
        sb.Append(Indent).Append("public Guid Id { get; init; } = Guid.NewGuid();\n");
        sb.Append(Indent).Append("public string Type { get; init; } = default!;\n");
        sb.Append(Indent).Append("public string Payload { get; init; } = default!;\n");
        sb.Append(Indent).Append("public DateTimeOffset OccurredOn { get; init; } = DateTimeOffset.UtcNow;\n");
        sb.Append(Indent).Append("public DateTimeOffset? ProcessedOn { get; set; }\n\n");

        sb.Append(Indent).Append("public static OutboxMessage From(IIntegrationEvent integrationEvent)\n");
        sb.Append(Indent).Append(Indent).Append("=> new()\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("Type = integrationEvent.GetType().AssemblyQualifiedName!,\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("Payload = JsonSerializer.Serialize(integrationEvent, integrationEvent.GetType()),\n");
        sb.Append(Indent).Append(Indent).Append("};\n\n");

        sb.Append(Indent).Append("public IIntegrationEvent? Deserialize()\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("var type = System.Type.GetType(Type);\n");
        sb.Append(Indent).Append(Indent).Append("return type is null ? null : (IIntegrationEvent?)JsonSerializer.Deserialize(Payload, type);\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, "OutboxMessage.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: false, OutboxMessageUsings));
    }

    /// <summary>
    /// Emits the <c>IIntegrationEventHandler</c> delivery seam: the single abstraction the dispatcher
    /// hands each drained event to. The consumer implements it to fan out to their subscribers.
    /// </summary>
    private EmittedFile EmitIntegrationEventHandlerSeam(EmitContext emit, string context)
    {
        var sb = new StringBuilder();
        WriteXmlDoc(sb, "Delivers a drained integration event to its in-process subscribers.", "");
        sb.Append("public interface IIntegrationEventHandler\n{\n");
        sb.Append(Indent).Append("Task HandleAsync(IIntegrationEvent integrationEvent, CancellationToken ct = default);\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(emit, context, KindFolder.Abstractions, "IIntegrationEventHandler.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: false));
    }

    /// <summary>
    /// Emits the <c>IntegrationEventDispatcher</c>: a drainable component that reads unprocessed
    /// <c>OutboxMessage</c> rows in order, rehydrates each event, hands it to the
    /// <c>IIntegrationEventHandler</c>, marks it processed, and persists the marks — the out-of-band
    /// half of the transactional-outbox pattern (enqueue in the unit of work, dispatch here).
    /// </summary>
    private EmittedFile EmitIntegrationEventDispatcher(EmitContext emit, string context)
    {
        var sb = new StringBuilder();
        var dbContext = context + "DbContext";

        WriteXmlDoc(sb, $"Drains the {context} outbox and delivers each integration event in order.", "");
        sb.Append("public sealed class IntegrationEventDispatcher\n{\n");
        sb.Append(Indent).Append("private readonly ").Append(dbContext).Append(" _context;\n");
        sb.Append(Indent).Append("private readonly IIntegrationEventHandler _handler;\n\n");

        sb.Append(Indent).Append("public IntegrationEventDispatcher(").Append(dbContext).Append(" context, IIntegrationEventHandler handler)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("_context = context;\n");
        sb.Append(Indent).Append(Indent).Append("_handler = handler;\n");
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("public async Task DispatchPendingAsync(CancellationToken ct = default)\n");
        sb.Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append("var pending = await _context.Set<OutboxMessage>()\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(".Where(m => m.ProcessedOn == null)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(".OrderBy(m => m.OccurredOn)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(".ToListAsync(ct);\n\n");
        sb.Append(Indent).Append(Indent).Append("foreach (var message in pending)\n");
        sb.Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("var integrationEvent = message.Deserialize();\n");
        // Only mark a message processed once it was actually delivered. A message whose type can no
        // longer be resolved (Deserialize returns null) is LEFT pending rather than silently dropped,
        // so it stays visible for investigation instead of being lost.
        sb.Append(Indent).Append(Indent).Append(Indent).Append("if (integrationEvent is null)\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("{\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append(Indent).Append("continue;\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("await _handler.HandleAsync(integrationEvent, ct);\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("message.ProcessedOn = DateTimeOffset.UtcNow;\n");
        sb.Append(Indent).Append(Indent).Append("}\n\n");
        sb.Append(Indent).Append(Indent).Append("await _context.SaveChangesAsync(ct);\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(emit, context, KindFolder.Infrastructure, "IntegrationEventDispatcher.cs"),
            Assemble(emit, context, sb.ToString(), usesLinq: true, DispatcherUsings));
    }
}
