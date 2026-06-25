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
        StringBuilder sb, KoineModel model, IReadOnlyList<CollectedEvent> events, ModelIndex index)
    {
        // The channel keys that actually exist (the bare name, or a context-qualified one under a
        // cross-context name collision), used to resolve each operation's channel $ref.
        var channelKeys = new HashSet<string>(events.Select(e => e.Key), StringComparer.Ordinal);
        var operations = new SortedDictionary<string, Operation>(StringComparer.Ordinal);

        foreach (ContextNode ctx in model.Contexts)
        {
            // Sends — this context publishes its own declared event onto that event's channel. The
            // operation key keeps the bare event name (already context-disambiguated by ctx); the
            // channel $ref uses the event's possibly-qualified key. For a colliding name only the
            // declaring context (Key != Name => qualified) sends onto its own channel; for a unique
            // name there is a single entry, so the owner guard is a no-op and output is unchanged.
            foreach (CollectedEvent ev in events)
            {
                if (!index.PublishesEvent(ctx.Name, ev.Name))
                {
                    continue;
                }

                if (ev.Key != ev.Name && ev.Context != ctx.Name)
                {
                    continue;
                }

                operations[$"{ctx.Name}_send_{ev.Name}"] = new Operation("send", ev.Key, ctx.Name);
            }

            // Receives — this context subscribes to a published event (named "Publisher.Event").
            // Subscriptions are validated before emit (an unauthorized subscribe is a compile error that
            // blocks emission, and a map-less subscribe is permitted), so every surviving subscribe gets
            // a receive op as long as the event actually has a channel. Gating on MaySubscribe here
            // would wrongly drop the valid map-less case, where no relation exists to authorize against.
            // The channel $ref resolves to the bare name when unique, else the publisher's qualified key.
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                string? channel =
                    channelKeys.Contains(sub.EventName) ? sub.EventName
                    : channelKeys.Contains($"{sub.Context}_{sub.EventName}") ? $"{sub.Context}_{sub.EventName}"
                    : null;

                if (channel is not null)
                {
                    operations[$"{ctx.Name}_receive_{sub.EventName}"] = new Operation("receive", channel, ctx.Name);
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
            sb.Append("      - name: ").Append(YamlValue(op.Context)).Append('\n');
        }
    }
}
