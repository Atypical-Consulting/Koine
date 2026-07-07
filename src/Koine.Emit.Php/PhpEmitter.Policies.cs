using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The policy slice of <see cref="PhpEmitter"/> (R10.3), the PHP analogue of
/// <c>PythonEmitter.Policies.cs</c> and the C# emitter's <c>EmitPolicy</c>: a domain event → command
/// reaction emitted as a reactor <c>interface</c> seam the consumer implements. Like every other
/// backend, Koine does NOT generate the imperative cross-aggregate call — the intended reaction
/// (target command + its arguments, translated from the triggering event's fields rooted at
/// <c>$event</c>) is recorded in the docblock sketch, and the consumer wires the call in
/// <c>react</c>. Dependency-free PHP 8.1, <c>declare(strict_types=1)</c>.
/// </summary>
public sealed partial class PhpEmitter
{
    /// <summary>
    /// Emits a policy as a reactor seam: a <c>&lt;Name&gt;Policy</c> interface with
    /// <c>public function react(&lt;Event&gt; $event): void;</c>. The intended reaction
    /// (<c>&lt;Target&gt;::&lt;command&gt;(param: …)</c>, its arguments translated from the event's
    /// fields rooted at the <c>$event</c> parameter) is documented in the docblock, never generated —
    /// mirroring the C#/Python/TS "no imperative logic in the model" stance.
    /// </summary>
    private EmittedFile EmitPolicy(PhpEmitContext emit, PolicyDecl policy, string contextName, PhpTypeMapper typeMapper)
    {
        var policyType = PhpNaming.ClassName(policy.Name + "Policy");
        var eventName = PhpNaming.ClassName(policy.EventName);

        // The reaction sketch renders the target command's args rooted at the handler parameter
        // `$event`, so a value like `capturedAmount` reads as `$event->capturedAmount`.
        IReadOnlyList<Member> eventMembers =
            emit.Index.TryGetDecl(policy.EventName, out TypeDecl ed) && ed is EventDecl ev
                ? ev.Members
                : Array.Empty<Member>();
        var translator = new PhpExpressionTranslator(
            emit.Index, eventMembers, emit.EnumMemberToType, context: contextName, memberReceiver: "event",
            regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        PolicyReaction r = policy.Reaction;
        var argText = string.Join(", ", r.Args.Select(a =>
            PhpNaming.PropertyName(a.Parameter) + ": "
            + translator.Translate(a.Value, PhpExpressionTranslator.NameMode.Property)));
        var targetType = PhpNaming.ClassName(r.TargetType);
        var command = PhpNaming.MethodName(r.CommandName);
        var sketch = $"{targetType}::{command}({argText})";

        // The sketch and event name are interpolated into the docblock, so escape them the same way
        // WriteDoc does (a `*/` run in a translated arg can't break the comment).
        var docSketch = EscapeDoc(sketch);
        var docEvent = EscapeDoc(eventName);

        var sb = new StringBuilder();
        sb.Append("/**\n");
        sb.Append(" * Policy seam: when ").Append(docEvent).Append(" occurs, the intended reaction is\n");
        sb.Append(" * ").Append(docSketch).Append(". Koine does not generate the cross-aggregate call\n");
        sb.Append(" * (no imperative logic in the model); implement react() to wire it.\n");
        sb.Append(" */\n");
        sb.Append("interface ").Append(policyType).Append('\n');
        sb.Append("{\n");
        sb.Append(Indent).Append("/** React to a ").Append(docEvent)
          .Append(" event. Intended reaction: ").Append(docSketch).Append(". */\n");
        sb.Append(Indent).Append("public function react(").Append(eventName).Append(" $event): void;\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(contextName, KindFolder.Policies, policy.Name + "Policy"),
            Assemble(contextName, KindFolder.Policies, sb.ToString(), policyType),
            Kind: KindForFolder(KindFolder.Policies));
    }
}
