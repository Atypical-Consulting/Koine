using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// The policy slice of <see cref="PythonEmitter"/> (R10.3), the Python analogue of the C# emitter's
/// <c>EmitPolicy</c>: a domain event → command reaction emitted as a structural <c>Protocol</c> seam
/// the consumer implements. Like the C# backend, Koine does NOT generate the imperative
/// cross-aggregate call — the intended reaction (target command + its arguments, translated from the
/// triggering event's fields) is recorded in the docstring sketch, and the consumer wires the call in
/// <c>react</c>. Self-contained, stdlib-only, <c>mypy --strict</c>-clean output.
/// </summary>
public sealed partial class PythonEmitter
{
    /// <summary>
    /// Emits a policy as a reactor seam: a <c>&lt;Name&gt;Policy(Protocol)</c> with
    /// <c>def react(self, event: &lt;Event&gt;) -&gt; None: ...</c>. The intended reaction
    /// (<c>Target.command(arg=…)</c>, its arguments translated from the event's fields rooted at the
    /// <c>event</c> parameter) is documented in the docstring, never generated — mirroring the C#
    /// emitter's "no imperative logic in the model" stance.
    /// </summary>
    private EmittedFile EmitPolicy(PyEmitContext emit, PolicyDecl policy, string ctxName, PythonTypeMapper typeMapper)
    {
        var policyType = PythonNaming.ToPascalCase(policy.Name) + "Policy";
        var ns = ctxName;
        var eventName = PythonNaming.ToPascalCase(policy.EventName);

        // The reaction sketch renders the target command's args rooted at the handler parameter
        // `event`, so a value like `orderId` reads as `event.order_id`.
        IReadOnlyList<Member> eventMembers =
            emit.Index.TryGetDecl(policy.EventName, out TypeDecl ed) && ed is EventDecl ev
                ? ev.Members
                : Array.Empty<Member>();
        var translator = new PythonExpressionTranslator(
            emit.Index, eventMembers, emit.EnumMemberToType, typeMapper, ContextOf(ns), memberReceiver: "event");

        PolicyReaction r = policy.Reaction;
        var argText = string.Join(", ", r.Args.Select(a =>
            $"{PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(a.Parameter))}="
            + translator.Translate(a.Value, PythonExpressionTranslator.NameMode.Property)));
        var targetType = PythonNaming.ToPascalCase(r.TargetType);
        var command = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(r.CommandName));
        var sketch = $"{targetType}.{command}({argText})";

        // The sketch and event name are interpolated into docstrings, so escape them the same way
        // WriteDoc does (a backslash or `"""` run in a translated arg can't break the docstring).
        var docSketch = EscapeDoc(sketch);
        var docEvent = EscapeDoc(eventName);

        var sb = new StringBuilder();
        sb.Append("class ").Append(policyType).Append("(Protocol):\n");
        sb.Append(Indent).Append("\"\"\"Policy seam: when ").Append(docEvent).Append(" occurs, the intended reaction is\n");
        sb.Append(Indent).Append(docSketch).Append(". Koine does not generate the cross-aggregate call\n");
        sb.Append(Indent).Append("(no imperative logic in the model); implement `react` to wire it.\"\"\"\n");
        sb.Append('\n');
        sb.Append(Indent).Append("def react(self, event: ").Append(eventName).Append(") -> None:\n");
        sb.Append(Indent).Append(Indent).Append("\"\"\"React to a ").Append(docEvent)
          .Append(" event. Intended reaction: ").Append(docSketch).Append(".\"\"\"\n");
        sb.Append(Indent).Append(Indent).Append("...\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.Policies, policy.Name),
            Assemble(emit, ns, KindFolder.Policies, sb.ToString(), policyType));
    }
}
