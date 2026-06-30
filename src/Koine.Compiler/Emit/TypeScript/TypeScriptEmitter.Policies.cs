using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// The R10.3 policy slice of <see cref="TypeScriptEmitter"/>, the TypeScript counterpart of
/// <see cref="CSharp.CSharpEmitter"/>'s <c>EmitPolicy</c>. A <c>policy</c> is a cross-aggregate
/// reaction — "when &lt;Event&gt; occurs, run &lt;Target&gt;.&lt;command&gt;(args…)" — but Koine
/// never generates the imperative dispatch (no imperative logic in the model). So, exactly like the
/// C# emitter, the TypeScript backend emits a <b>handler seam</b>:
/// <list type="bullet">
/// <item>an <c>export interface I&lt;Name&gt;Policy</c> with a single <c>handle(event): Promise&lt;void&gt;</c>
/// method (the TS analogue of the C# <c>Task</c>-returning interface);</item>
/// <item>an <c>export abstract class &lt;Name&gt;Policy implements I&lt;Name&gt;Policy</c> whose
/// <c>handle</c> the consumer overrides to wire the reaction. The intended reaction sketch is recorded
/// in a doc comment, never generated.</item>
/// </list>
/// The class also exposes a pure <c>reactionArgs(event)</c> helper that maps the triggering event's
/// fields to the target command's named arguments (each <see cref="PolicyArg.Value"/> translated and
/// rooted at the <c>event</c> parameter via the translator's <c>memberReceiver</c>). This is data
/// mapping only — it builds the argument shape, it does not perform the dispatch — so it keeps the
/// "no imperative call" stance while making the arg mapping a concrete, testable artifact.
/// </summary>
public sealed partial class TypeScriptEmitter
{
    /// <summary>
    /// Emits a policy (R10.3) as a handler seam plus a pure argument-mapping helper. Mirrors the
    /// intent of the C# emitter's <c>EmitPolicy</c> in idiomatic TypeScript.
    /// </summary>
    private EmittedFile EmitPolicy(TsEmitContext emit, PolicyDecl policy, string ns, TypeScriptTypeMapper typeMapper)
    {
        ModelIndex index = emit.Index;
        var context = ContextOf(ns);
        var policyType = TypeScriptNaming.ToPascalCase(policy.Name) + "Policy";
        var iface = "I" + policyType;
        var eventType = TypeScriptNaming.ToPascalCase(policy.EventName);

        // The triggering event's fields are in scope for the reaction args, rooted at `event`.
        IReadOnlyList<Member> eventMembers =
            index.TryGetDeclIn(context, policy.EventName, out TypeDecl ed) && ed is EventDecl ev
                ? ev.Members
                : index.TryGetDecl(policy.EventName, out TypeDecl ed2) && ed2 is EventDecl ev2
                    ? ev2.Members
                    : Array.Empty<Member>();

        var translator = new TypeScriptExpressionTranslator(
            index, eventMembers, emit.EnumMemberToType, typeMapper, context, memberReceiver: "event",
            regexMatchTimeoutMs: _options.RegexMatchTimeoutMs);

        PolicyReaction r = policy.Reaction;
        // Reference-only emit must not leak business logic: the translated argument expressions are
        // elided to `…` (the doc sketch keeps only the parameter-name contract) and the reactionArgs
        // body becomes the standard stub below.
        var mapped = r.Args
            .Select(a => (Param: TypeScriptNaming.ToCamelCase(a.Parameter),
                          Value: RefOnly
                              ? "…"
                              : translator.Translate(a.Value, TypeScriptExpressionTranslator.NameMode.Property)))
            .ToList();

        var argSketch = string.Join(", ", mapped.Select(m => $"{m.Param}: {m.Value}"));
        var sketch = $"{TypeScriptNaming.ToPascalCase(r.TargetType)}.{TypeScriptNaming.ToCamelCase(r.CommandName)}({argSketch})";

        var sb = new StringBuilder();

        WriteDoc(sb, policy.Doc ?? $"Reacts to {policy.EventName} via {policy.Name}.", "");
        sb.Append("export interface ").Append(iface).Append(" {\n");
        sb.Append(Indent).Append("handle(event: ").Append(eventType).Append("): Promise<void>;\n");
        sb.Append("}\n\n");

        // The abstract seam: when the event occurs, the intended reaction is the sketch below; Koine
        // does not generate the cross-aggregate call (no imperative logic in the model), so `handle`
        // is left abstract for the consumer to implement.
        sb.Append("/**\n");
        sb.Append(" * Policy seam: when ").Append(policy.EventName).Append(" occurs, the intended reaction is\n");
        sb.Append(" * `").Append(sketch).Append("`. Koine does not generate the cross-aggregate call\n");
        sb.Append(" * (no imperative logic in the model); override `handle` to wire it.\n");
        sb.Append(" */\n");
        sb.Append("export abstract class ").Append(policyType).Append(" implements ").Append(iface).Append(" {\n");

        // Pure argument mapping: build the target command's named-argument shape from the event's
        // fields. Data mapping only — it does not perform the dispatch.
        sb.Append(Indent).Append("/** The ").Append(TypeScriptNaming.ToCamelCase(r.CommandName))
          .Append(" arguments mapped from the triggering ").Append(policy.EventName).Append(". */\n");
        sb.Append(Indent).Append("protected reactionArgs(event: ").Append(eventType).Append(") {\n");
        if (RefOnly)
        {
            sb.Append(Indent).Append(Indent).Append(RefStubStatement).Append('\n');
        }
        else if (mapped.Count == 0)
        {
            sb.Append(Indent).Append(Indent).Append("return {};\n");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append("return {\n");
            foreach ((var param, var value) in mapped)
            {
                sb.Append(Indent).Append(Indent).Append(Indent).Append(param).Append(": ").Append(value).Append(",\n");
            }
            sb.Append(Indent).Append(Indent).Append("};\n");
        }
        sb.Append(Indent).Append("}\n\n");

        sb.Append(Indent).Append("/** Intended reaction: `").Append(sketch).Append("`. */\n");
        sb.Append(Indent).Append("abstract handle(event: ").Append(eventType).Append("): Promise<void>;\n");
        sb.Append("}\n");

        return new EmittedFile(
            PathFor(ns, KindFolder.Policies, policyType),
            Assemble(emit, ns, KindFolder.Policies, sb.ToString(), policyType, policy.Span));
    }
}
