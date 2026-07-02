using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The integration-event subscriber slice of <see cref="PhpEmitter"/> (R14.3), the PHP analogue of the
/// C# <c>IHandle&lt;Event&gt;</c> seam and <c>TypeScriptEmitter.Integration.cs</c>. The published
/// <c>integration event</c> itself already emits through the regular event path; this slice adds, for
/// each <c>subscribes &lt;Pub&gt;.&lt;Event&gt;</c>, a <c>Handle&lt;Event&gt;</c> handler
/// <c>interface</c> into the subscriber context's <c>Abstractions/</c> folder, with a single
/// <c>handle(&lt;Event&gt; $event): void</c> seam. The subscribed event type resolves to a qualified
/// <c>use</c> import from the publisher context through the shared type catalog.
/// </summary>
public sealed partial class PhpEmitter
{
    /// <summary>
    /// Emits the subscriber handler seam for one <c>subscribes &lt;Pub&gt;.&lt;Event&gt;</c>: an
    /// <c>interface Handle&lt;Event&gt;</c> in <paramref name="subscriberContext"/>'s
    /// <c>Abstractions/</c> folder, with a single <c>handle(&lt;Event&gt; $event): void</c> method. The
    /// event type is imported from the publisher context's generated integration-event class (resolved
    /// through the shared type catalog by <see cref="CollectUses"/>).
    /// </summary>
    private EmittedFile EmitIntegrationSubscriber(PhpEmitContext emit, SubscribeDecl sub, string subscriberContext)
    {
        var eventType = PhpNaming.ClassName(sub.EventName);

        // When the subscriber consumes the same event short name from two or more publishers (#420),
        // the bare Handle<Event> interface + file would collide on one path — qualify it by the
        // publisher context (Handle<Pub><Event>), mirroring the C#/TS emitters. The single-publisher
        // case keeps the bare name, byte-identical to before.
        var iface = emit.Index.SubscriptionEventNameIsAmbiguous(subscriberContext, sub.EventName)
            ? "Handle" + PhpNaming.ClassName(sub.Context) + eventType
            : "Handle" + eventType;

        // The subscribed event resolves to the publisher the subscription names — not whichever
        // same-named copy a different context's declaration sorts first in the catalog. One hint per
        // file is unambiguous: even when a subscriber consumes two same-named events from different
        // publishers (#420), each gets its own publisher-qualified file with its own single hint.
        var symbolContext = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [eventType] = sub.Context,
        };

        var sb = new StringBuilder();
        sb.Append("/** Handles the ").Append(EscapeDoc(sub.Context)).Append('.').Append(EscapeDoc(sub.EventName))
          .Append(" integration event published by context ").Append(EscapeDoc(sub.Context)).Append(". */\n");
        sb.Append("interface ").Append(iface).Append('\n');
        sb.Append("{\n");
        sb.Append(Indent).Append("public function handle(").Append(eventType).Append(" $event): void;\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(subscriberContext, KindFolder.Abstractions, iface),
            Assemble(subscriberContext, KindFolder.Abstractions, sb.ToString(), iface, symbolContext));
    }
}
