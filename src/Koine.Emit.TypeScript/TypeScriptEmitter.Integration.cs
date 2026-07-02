using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The integration-event slice of <see cref="TypeScriptEmitter"/> (R14.3, TS parity): mirrors the
/// C# emitter's published-language contract and its subscriber handler seam.
/// <list type="bullet">
/// <item>An <c>integration event</c> emits as an immutable readonly class with occurrence metadata —
/// the published-language contract the publisher context exposes, the TS counterpart of the C#
/// <c>record … : IIntegrationEvent</c>.</item>
/// <item>Each <c>subscribes &lt;Pub&gt;.&lt;Event&gt;</c> emits an <c>IHandle&lt;Event&gt;</c> handler
/// interface into the subscriber context, with a single <c>handle(event): Promise&lt;void&gt;</c>
/// seam — the TS counterpart of the C# <c>IHandle&lt;Event&gt;</c> with its
/// <c>Task Handle(event, CancellationToken)</c> (TS has no <c>CancellationToken</c> analogue, so the
/// method takes only the event and returns <c>Promise&lt;void&gt;</c>).</item>
/// </list>
/// The subscribed event type is imported from the module it actually emits into, resolved through the
/// same <see cref="TsTypeLocation"/> table the rest of the emitter uses, exactly as the C# emitter
/// references it by fully-qualified name.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    /// <summary>
    /// Emits an integration event (R14.3): an immutable readonly class with the declared primitive
    /// fields plus an <c>occurredOn</c> occurrence timestamp, mirroring the C# emitter's
    /// <c>record … : IIntegrationEvent</c>. Lives in the publisher context's <c>integration-events/</c>
    /// folder so subscriber handlers in other contexts can import it.
    /// </summary>
    private EmittedFile EmitIntegrationEvent(TsEmitContext emit, IntegrationEventDecl ev, string ns, TypeScriptTypeMapper typeMapper)
    {
        var name = TypeScriptNaming.ToPascalCase(ev.Name);
        var memberNames = new HashSet<string>(ev.Members.Select(m => m.Name), StringComparer.Ordinal);
        var ctorMembers = ev.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var sb = new StringBuilder();
        WriteDoc(sb, ev.Doc, "");
        sb.Append("export class ").Append(name).Append(" {\n");

        foreach (Member m in ctorMembers)
        {
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("readonly ").Append(TypeScriptNaming.ToCamelCase(m.Name)).Append(FieldBang).Append(": ")
              .Append(typeMapper.Map(m.Type)).Append(";\n");
        }
        sb.Append(Indent).Append("readonly occurredOn").Append(FieldBang).Append(": Instant;\n\n");

        var ordered = OrderCtorParams(ctorMembers).ToList();
        sb.Append(Indent).Append("constructor(");
        sb.Append(string.Join(", ", ordered.Select(m => $"{TypeScriptNaming.ToCamelCase(m.Name)}: {typeMapper.Map(m.Type)}")));
        sb.Append(ordered.Count > 0 ? ", " : "").Append("occurredOn: Instant = Instant.now()) {\n");
        if (RefOnly)
        {
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
        }
        else
        {
            foreach (Member m in ctorMembers)
            {
                WriteAssignment(sb, m);
            }
            sb.Append(Indent).Append(Indent).Append("this.occurredOn = occurredOn;\n");
        }

        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.IntegrationEvents, name),
            Assemble(emit, ns, KindFolder.IntegrationEvents, sb.ToString(), name, ev.Span));
    }

    /// <summary>
    /// Emits the subscriber handler seam for one <c>subscribes &lt;Pub&gt;.&lt;Event&gt;</c> (R14.3):
    /// an <c>export interface IHandle&lt;Event&gt;</c> in the subscriber context's
    /// <c>abstractions/</c> folder, with a single <c>handle(event: &lt;EventType&gt;): Promise&lt;void&gt;</c>
    /// method. The event type is imported from the publisher context's generated integration-event
    /// module — resolved via the shared <see cref="TsTypeLocation"/> table, preferring the publisher
    /// context (mirroring the C# emitter's fully-qualified reference to the publisher's namespace, so it
    /// never binds to a same-named event the subscriber might declare locally).
    /// </summary>
    private EmittedFile EmitIntegrationEventHandler(TsEmitContext emit, SubscribeDecl sub, string subscriberContext)
    {
        var eventType = TypeScriptNaming.ToPascalCase(sub.EventName);

        // When the subscriber consumes the same event short name from two or more publishers (#420),
        // the bare IHandle<Event> seam would collide on one path — qualify it by the publisher context
        // (IHandle<Pub><Event>), mirroring the C# emitter. The single-publisher case keeps the bare
        // name, byte-identical to before.
        var iface = emit.Index.SubscriptionEventNameIsAmbiguous(subscriberContext, sub.EventName)
            ? "IHandle" + TypeScriptNaming.ToPascalCase(sub.Context) + eventType
            : "IHandle" + eventType;
        var folder = FolderFor(subscriberContext) + "/" + KindFolder.Abstractions;

        // Resolve the import module for the event as declared in the publisher context, preferring a
        // location in that context (mirrors Assemble's per-context preference and the C# emitter's
        // publisher-namespace qualification).
        string? eventModule = null;
        foreach (TsTypeLocation loc in emit.TypeLocations)
        {
            if (loc.ExportName == eventType && loc.Context == sub.Context)
            {
                eventModule = loc.ModulePath;
                break;
            }

            if (loc.ExportName == eventType)
            {
                eventModule ??= loc.ModulePath;
            }
        }

        var sb = new StringBuilder();
        sb.Append("// <auto-generated/>\n");
        if (eventModule is not null)
        {
            sb.Append("import { ").Append(eventType).Append(" } from '")
              .Append(ImportSpecifier(folder, eventModule)).Append("';\n\n");
        }

        WriteDoc(sb, $"Handles the {sub.Context}.{sub.EventName} integration event published by context {sub.Context}.", "");
        sb.Append("export interface ").Append(iface).Append(" {\n");
        sb.Append(Indent).Append("handle(event: ").Append(eventType).Append("): Promise<void>;\n");
        sb.Append("}\n");

        return new EmittedFile(PathFor(subscriberContext, KindFolder.Abstractions, iface), sb.ToString());
    }
}
