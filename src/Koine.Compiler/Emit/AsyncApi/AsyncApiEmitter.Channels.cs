using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.AsyncApi;

/// <summary>
/// Channels-and-messages slice of the AsyncAPI emitter: turns each integration event into a
/// channel (addressed by the event name) carrying one message, and into a reusable
/// <c>components/messages</c> entry the channel and operations reference by <c>$ref</c>.
/// </summary>
public sealed partial class AsyncApiEmitter
{
    /// <summary>
    /// Emits the <c>channels</c> map — one channel per integration event, addressed by the event
    /// name and referencing the message of the same name. An empty event set emits <c>{}</c> so
    /// the document stays valid.
    /// </summary>
    private static void EmitChannels(StringBuilder sb, IReadOnlyList<IntegrationEventDecl> events)
    {
        if (events.Count == 0)
        {
            sb.Append("channels: {}\n");
            return;
        }

        sb.Append("channels:\n");
        foreach (IntegrationEventDecl ie in events)
        {
            sb.Append("  ").Append(ie.Name).Append(":\n");
            sb.Append("    address: ").Append(ie.Name).Append('\n');
            sb.Append("    messages:\n");
            sb.Append("      ").Append(ie.Name).Append(":\n");
            sb.Append("        $ref: '#/components/messages/").Append(ie.Name).Append("'\n");
        }
    }

    /// <summary>
    /// Emits the <c>components/messages</c> map — one message per integration event, carrying its
    /// name, (when present) the declaration doc as a summary, and a reference to its payload schema
    /// (rendered by the schemas slice).
    /// </summary>
    private static void EmitMessages(StringBuilder sb, IReadOnlyList<IntegrationEventDecl> events)
    {
        sb.Append("  messages:\n");
        foreach (IntegrationEventDecl ie in events)
        {
            sb.Append("    ").Append(ie.Name).Append(":\n");
            sb.Append("      name: ").Append(ie.Name).Append('\n');
            if (!string.IsNullOrEmpty(ie.Doc))
            {
                sb.Append("      summary: ").Append(YamlScalar(ie.Doc!)).Append('\n');
            }

            sb.Append("      payload:\n");
            sb.Append("        $ref: '#/components/schemas/").Append(ie.Name).Append("Payload'\n");
        }
    }
}
