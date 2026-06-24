using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.AsyncApi;

/// <summary>
/// Operations slice of the AsyncAPI emitter: turns the context map's pub/sub graph into
/// <c>operations</c>. A context that <c>publishes</c> an event gets a <c>send</c> operation; a
/// context whose <c>subscribes</c> the map authorizes gets a <c>receive</c> operation. Both bind to
/// the event's channel. Operation names are context-disambiguated and the set is emitted in a stable
/// order, so re-running is byte-identical.
/// </summary>
public sealed partial class AsyncApiEmitter
{
    private readonly record struct Operation(string Action, string Channel, string Context);

    /// <summary>
    /// Emits the <c>operations</c> map from the pub/sub graph. An empty graph emits <c>{}</c> so the
    /// document stays valid even when no context publishes or subscribes.
    /// </summary>
    private static void EmitOperations(
        StringBuilder sb, KoineModel model, IReadOnlyList<IntegrationEventDecl> events, ModelIndex index)
    {
        var channels = new HashSet<string>(events.Select(e => e.Name), StringComparer.Ordinal);
        var operations = new SortedDictionary<string, Operation>(StringComparer.Ordinal);

        foreach (ContextNode ctx in model.Contexts)
        {
            // Sends — this context publishes the event (its channel must exist).
            foreach (IntegrationEventDecl ev in events)
            {
                if (index.PublishesEvent(ctx.Name, ev.Name))
                {
                    operations[$"{ctx.Name}_send_{ev.Name}"] = new Operation("send", ev.Name, ctx.Name);
                }
            }

            // Receives — this context subscribes to a published event the context map authorizes.
            // Subscriptions are validated at compile time, so MaySubscribe is a belt-and-braces guard.
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                if (channels.Contains(sub.EventName) && index.MaySubscribe(sub.Context, ctx.Name))
                {
                    operations[$"{ctx.Name}_receive_{sub.EventName}"] = new Operation("receive", sub.EventName, ctx.Name);
                }
            }
        }

        if (operations.Count == 0)
        {
            sb.Append("operations: {}\n");
            return;
        }

        sb.Append("operations:\n");
        foreach (var (name, op) in operations)
        {
            sb.Append("  ").Append(name).Append(":\n");
            sb.Append("    action: ").Append(op.Action).Append('\n');
            sb.Append("    channel:\n");
            sb.Append("      $ref: '#/channels/").Append(op.Channel).Append("'\n");
            sb.Append("    tags:\n");
            sb.Append("      - name: ").Append(op.Context).Append('\n');
        }
    }
}
