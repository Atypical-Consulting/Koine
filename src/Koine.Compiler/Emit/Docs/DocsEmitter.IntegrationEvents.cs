using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Docs;

/// <summary>
/// Integration-event slice of <see cref="DocsEmitter"/>: a Mermaid <c>flowchart LR</c> of the
/// cross-context published-language flow — <c>Publisher --publishes--&gt; Event --consumed by--&gt; Subscriber</c>
/// — derived from each context's <c>publishes</c>/<c>subscribes</c> declarations, plus the event schemas.
/// Emits nothing when the model declares no integration events.
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>Emits <c>integration-events.md</c>, or nothing when there are no integration events.</summary>
    private static IReadOnlyList<EmittedFile> EmitIntegrationEvents(KoineModel model)
    {
        // Collect every integration event, keyed by its fully-qualified Context.Event name.
        var byKey = new SortedDictionary<string, (ContextNode Ctx, IntegrationEventDecl Event)>(StringComparer.Ordinal);
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (IntegrationEventDecl ie in ctx.AllTypeDecls().OfType<IntegrationEventDecl>())
            {
                byKey[$"{ctx.Name}.{ie.Name}"] = (ctx, ie);
            }
        }

        if (byKey.Count == 0)
        {
            return Array.Empty<EmittedFile>();
        }

        var sb = new StringBuilder();
        sb.Append("# Integration Events\n");
        sb.Append("\nThe cross-context published-language flows: who emits each integration event and who consumes it.\n");

        EmitIntegrationFlowchart(sb, model, byKey);

        sb.Append("\n## Event Schemas\n");
        foreach (var (key, value) in byKey)
        {
            sb.Append("\n### ").Append(key).Append(Tag(value.Event)).Append('\n');
            if (!string.IsNullOrEmpty(value.Event.Doc))
            {
                sb.Append('\n').Append(Prose(value.Event.Doc)).Append('\n');
            }

            WriteFields(sb, value.Event.Members);
        }

        return new[] { new EmittedFile("docs/integration-events.md", sb.ToString()) };
    }

    /// <summary>Emits the publisher -> event -> subscriber flowchart.</summary>
    private static void EmitIntegrationFlowchart(
        StringBuilder sb,
        KoineModel model,
        SortedDictionary<string, (ContextNode Ctx, IntegrationEventDecl Event)> byKey)
    {
        sb.Append("\n```mermaid\nflowchart LR\n");

        // event-key -> contexts that subscribe to it. A subscription names "subscribes Publisher.Event".
        var subscribers = new SortedDictionary<string, SortedSet<string>>(StringComparer.Ordinal);
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                var key = $"{sub.Context}.{sub.EventName}";
                if (!subscribers.TryGetValue(key, out var set))
                {
                    set = new SortedSet<string>(StringComparer.Ordinal);
                    subscribers[key] = set;
                }

                set.Add(ctx.Name);
            }
        }

        EmitIntegrationFlowchartBody(sb, model, byKey, subscribers);

        sb.Append("```\n");
    }

    /// <summary>
    /// Emits just the flowchart body (no fences) — shared between the Markdown emitter and the
    /// structured-graph builder so both render byte-identical Mermaid.
    /// </summary>
    private static void EmitIntegrationFlowchartBody(
        StringBuilder sb,
        KoineModel model,
        SortedDictionary<string, (ContextNode Ctx, IntegrationEventDecl Event)> byKey,
        SortedDictionary<string, SortedSet<string>> subscribers)
    {
        foreach (var (key, value) in byKey)
        {
            var publisher = value.Ctx.Name;
            var eventNode = NodeId(key);

            // Publisher -> event (only when the context actually declares it publishes).
            if (value.Ctx.Publishes.Any(p => p.EventName == value.Event.Name))
            {
                sb.Append("    ").Append(publisher).Append(" -->|publishes| ").Append(eventNode)
                  .Append("([\"").Append(key).Append("\"])\n");
            }
            else
            {
                // Declared but not published: still show the event node so it is not orphaned silently.
                sb.Append("    ").Append(eventNode).Append("([\"").Append(key).Append("\"])\n");
            }

            if (subscribers.TryGetValue(key, out var subs))
            {
                foreach (string sub in subs)
                {
                    sb.Append("    ").Append(eventNode).Append(" -->|consumed by| ").Append(sub).Append('\n');
                }
            }
        }
    }

    /// <summary>A Mermaid-safe node id for an event key (dots are not valid in a bare id).</summary>
    private static string NodeId(string key) => "evt_" + key.Replace('.', '_');
}
