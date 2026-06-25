using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

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
        var iface = "Handle" + eventType;

        var sb = new StringBuilder();
        sb.Append("/** Handles the ").Append(EscapeDoc(sub.Context)).Append('.').Append(EscapeDoc(sub.EventName))
          .Append(" integration event published by context ").Append(EscapeDoc(sub.Context)).Append(". */\n");
        sb.Append("interface ").Append(iface).Append('\n');
        sb.Append("{\n");
        sb.Append(Indent).Append("public function handle(").Append(eventType).Append(" $event): void;\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(subscriberContext, KindFolder.Abstractions, iface),
            Assemble(subscriberContext, KindFolder.Abstractions, sb.ToString(), iface));
    }
}
