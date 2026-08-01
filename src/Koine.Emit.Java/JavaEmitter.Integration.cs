using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The integration-subscriber slice of <see cref="JavaEmitter"/> (R14.3, Phase 2 / issue #1090) — the Java
/// counterpart of <c>TypeScriptEmitter.Integration.cs</c>'s <c>IHandle&lt;Event&gt;</c> and the C#
/// emitter's. Each <c>subscribes &lt;Pub&gt;.&lt;Event&gt;</c> emits a <c>Handle&lt;Event&gt;</c> delivery
/// seam into the SUBSCRIBING context, taking the publisher's integration event
/// (package-qualified — the two live in different packages) and returning
/// <c>CompletableFuture&lt;Void&gt;</c>, the stdlib analogue of the C# <c>Task</c> / TS
/// <c>Promise&lt;void&gt;</c>.
/// <para>
/// The interface carries no <c>I</c> prefix: that is a C#/TypeScript convention, and the emitted
/// <c>&lt;Root&gt;Repository</c> already follows the Java one. Publishing an integration event is part of
/// the published-language contract rather than of a wiring layer, so this is emitted unconditionally —
/// unlike the opt-in infrastructure layer (<see cref="JavaEmitter"/>'s <c>Infrastructure</c> partial).
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>
    /// Emits the subscriber handler seam for one <c>subscribes &lt;Pub&gt;.&lt;Event&gt;</c>. When the
    /// subscriber consumes the same event SHORT NAME from two or more publishers (#420), the bare
    /// <c>Handle&lt;Event&gt;</c> name would collide on one file path — so it is qualified by the
    /// publisher context (<c>Handle&lt;Pub&gt;&lt;Event&gt;</c>), mirroring the C#/TS emitters. The
    /// single-publisher case keeps the bare name.
    /// </summary>
    private EmittedFile EmitIntegrationEventHandler(JavaEmitContext emit, string subscriberContext, SubscribeDecl sub)
    {
        var typeMapper = new JavaTypeMapper(emit.Index, subscriberContext, PackageFor);
        var eventName = JavaNaming.Type(sub.EventName);

        // Resolve the event against the PUBLISHER's context, not the subscriber's: a same-named event
        // declared locally must never be substituted for the one being subscribed to.
        var eventType = typeMapper.QualifyTypeName(new TypeRef(sub.EventName, Qualifier: sub.Context));

        var iface = emit.Index.SubscriptionEventNameIsAmbiguous(subscriberContext, sub.EventName)
            ? "Handle" + JavaNaming.Type(sub.Context) + eventName
            : "Handle" + eventName;

        var sb = new StringBuilder();
        WriteJavadoc(
            sb,
            $"Handles the {sub.Context}.{sub.EventName} integration event published by context {sub.Context}.",
            string.Empty);
        sb.Append("public interface ").Append(iface).Append(" {\n");
        sb.Append('\n');
        WriteJavadoc(sb, "Delivers one " + eventName + ", completing when it has been handled.", Indent);
        sb.Append(Indent).Append("java.util.concurrent.CompletableFuture<Void> handle(").Append(eventType)
          .Append(" event);\n");
        sb.Append("}\n");

        return TypeFile(subscriberContext, iface, sb.ToString());
    }
}
