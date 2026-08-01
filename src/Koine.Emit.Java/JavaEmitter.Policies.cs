using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The policy slice of <see cref="JavaEmitter"/> (R10.3, Phase 2 / issue #1090) — the Java analogue of
/// <c>PythonEmitter.Policies.cs</c> and the C# emitter's <c>EmitPolicy</c>. A domain event → command
/// reaction emits as a <c>&lt;Name&gt;Policy</c> reactor <b>interface</b> with a single
/// <c>void react(&lt;Event&gt; event)</c> the consumer implements.
/// <para>
/// Like every other backend, Koine does <b>not</b> generate the imperative cross-aggregate call: the
/// intended reaction (the target command plus its arguments, translated from the triggering event's own
/// fields) is recorded in the Javadoc as a sketch, and wiring it is the consumer's job. That keeps
/// imperative orchestration out of the model — a `.koi` file declares *what* should happen, not *how* the
/// call is dispatched.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>
    /// Emits a policy as a reactor seam: <c>public interface &lt;Name&gt;Policy { void react(&lt;Event&gt; event); }</c>.
    /// The trigger event's type is package-qualified when it is owned by another bounded context (R14.3
    /// integration flows routinely react to a foreign event), and the reaction sketch renders the target
    /// command's arguments rooted at the <c>event</c> parameter — so a policy argument written
    /// <c>amount: capturedAmount</c> reads as <c>event.capturedAmount()</c>.
    /// </summary>
    private EmittedFile EmitPolicy(JavaEmitContext emit, string context, PolicyDecl policy)
    {
        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);
        var policyType = JavaNaming.Type(policy.Name) + "Policy";
        var eventRef = new TypeRef(policy.EventName);
        var eventType = typeMapper.QualifyTypeName(eventRef);

        // The event's own members are the identifier scope of the reaction arguments. Prefer the
        // context-scoped lookup so a same-named event in another context can't shadow this one, falling
        // back to the flat index for a genuinely foreign (imported) trigger.
        IReadOnlyList<Member> eventMembers = EventMembers(emit.Index, context, policy.EventName);

        // membersAsAccessors:true — an emitted event is a record, so a field read goes through its
        // accessor (`event.capturedAmount()`).
        var translator = new JavaExpressionTranslator(
            emit.Index, eventMembers, typeMapper, context: context,
            memberReceiver: "event", membersAsAccessors: true);

        PolicyReaction r = policy.Reaction;
        // Java has no named-argument syntax, so the sketch keeps the other backends' `param: value`
        // notation — but every identifier in it is rendered the JAVA way (camelCase, reserved words
        // renamed), so it names the method and parameters the consumer will actually be calling.
        var argText = string.Join(
            ", ",
            r.Args.Select(a => JavaNaming.Member(a.Parameter) + ": "
                + translator.Translate(a.Value, JavaExpressionTranslator.NameMode.Property)));
        var sketch = $"{JavaNaming.Type(r.TargetType)}.{JavaNaming.Member(r.CommandName)}({argText})";

        var sb = new StringBuilder();
        WriteJavadoc(
            sb,
            "Policy seam: when " + eventType + " occurs, the intended reaction is\n"
            + sketch + ". Koine does not generate the cross-aggregate call\n"
            + "(no imperative logic in the model); implement react to wire it.",
            string.Empty);
        sb.Append("public interface ").Append(policyType).Append(" {\n");
        sb.Append('\n');
        WriteJavadoc(sb, "Reacts to a " + eventType + " event. Intended reaction: " + sketch + ".", Indent);
        sb.Append(Indent).Append("void react(").Append(eventType).Append(" event);\n");
        sb.Append("}\n");

        return TypeFile(context, policyType, sb.ToString());
    }

    /// <summary>
    /// The declared members of an event named by a policy/subscription, resolved against
    /// <paramref name="context"/> first (so a same-named event in another context cannot shadow the local
    /// one) and falling back to the flat index for a genuinely foreign, imported trigger. Empty when the
    /// name does not resolve to an event — already a validation error, so the emit degrades to a
    /// field-less sketch rather than throwing.
    /// </summary>
    private static IReadOnlyList<Member> EventMembers(ModelIndex index, string context, string eventName)
    {
        if (!index.TryGetDeclIn(context, eventName, out TypeDecl decl) && !index.TryGetDecl(eventName, out decl))
        {
            return Array.Empty<Member>();
        }

        return decl switch
        {
            EventDecl ev => ev.Members,
            IntegrationEventDecl iev => iev.Members,
            _ => Array.Empty<Member>(),
        };
    }
}
