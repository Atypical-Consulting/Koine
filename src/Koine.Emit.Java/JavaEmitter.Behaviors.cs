using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The state-machine slice of <see cref="JavaEmitter"/> (R7, Phase 2 / issue #1090) — the Java port of the
/// C# emitter's <c>WriteStateMachineGuard</c> and its Python analogue
/// (<c>PythonEmitter.Behaviors.cs</c>). Phase 1 emitted a Koine <c>command</c> as an invariant-guarded
/// mutating method, but ignored the entity's <c>states</c> block: an illegal lifecycle move emitted as a
/// bare assignment, silently dropping the rule the model declares.
/// <para>
/// A transition to a <em>literal</em> target state now emits a <b>reachability guard</b> first: the
/// current state must be one of the declared legal sources (each optionally narrowed by its own
/// <c>when</c> guard), else <c>DomainException</c>. The test is written as the De Morgan negation — "the
/// current state is none of these" — matching the other backends line for line, and a single-source guard
/// that would merely restate one of the behavior's own <c>requires</c> preconditions is suppressed so the
/// modeller's better-worded message is the one that fires.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>One legal source of a transition: its positive reachability check and that check negated.</summary>
    private readonly record struct JavaStateSource(string Positive, string Negated);

    /// <summary>
    /// Writes the state-machine reachability guard preceding one transition, when the transition's field is
    /// governed by a <c>states</c> block and its target is a literal state. A no-op otherwise — and also
    /// when the guard would carry a SINGLE source condition that one of the behavior's own
    /// <c>requires</c> preconditions already states verbatim, since that precondition has already been
    /// emitted (with the modeller's own message) immediately above.
    /// </summary>
    private static void WriteTransitionGuard(
        StringBuilder sb, JavaEmitContext emit, EntityDecl entity, CommandDecl cmd, Transition tr,
        JavaExpressionTranslator translator, JavaTypeMapper typeMapper, ISet<string> requiresConds)
    {
        Member? field = entity.Members.FirstOrDefault(m => m.Name == tr.Field);
        if (field is null
            || emit.Index.Classify(field.Type.Qualifier ?? translator.Context, field.Type.Name) != TypeKind.Enum)
        {
            return;
        }

        List<JavaStateSource>? conditions = BuildStateMachineConditions(
            entity, tr, field.Type, translator, typeMapper, emit.Index, cmd.Parameters);
        if (conditions is null || (conditions.Count == 1 && requiresConds.Contains(conditions[0].Positive)))
        {
            return;
        }

        WriteStateMachineGuard(sb, conditions, tr.Field, ((IdentifierExpr)tr.Value).Name);
    }

    /// <summary>
    /// Builds the reachability conditions for a state-machine-governed transition with a literal target:
    /// the legal source states the current state must be one of. Returns <c>null</c> when the field has no
    /// state machine, the target is dynamic (a non-literal expression), or the target is unreachable —
    /// the last already a semantic error (KOI0703), so the emit stays silent rather than inventing a guard.
    /// <para>
    /// Command parameters are popped while a per-rule <c>when</c> guard is translated: a guard reads
    /// PERSISTED entity state, so a same-named command parameter must not shadow the member it names.
    /// </para>
    /// </summary>
    private static List<JavaStateSource>? BuildStateMachineConditions(
        EntityDecl entity, Transition tr, TypeRef fieldType, JavaExpressionTranslator translator,
        JavaTypeMapper typeMapper, ModelIndex index, IReadOnlyList<Param> commandParams)
    {
        StatesDecl? states = entity.States.FirstOrDefault(s => s.Field == tr.Field);
        if (states is null || tr.Value is not IdentifierExpr stateRef
            || !index.EnumsDeclaring(stateRef.Name).Contains(fieldType.Name))
        {
            return null; // no state machine, or a dynamic (non-literal) target
        }

        var sources = states.Rules.Where(r => r.To.Contains(stateRef.Name)).ToList();
        if (sources.Count == 0)
        {
            return null; // unreachable target — already a semantic error (KOI0703)
        }

        // The lifecycle field is a STORED member, so it reads as a direct field access (the entity
        // translator's `membersAsAccessors: false` convention), and the enum type is package-qualified
        // when it is owned by another bounded context.
        var field = "this." + JavaNaming.Member(tr.Field);
        var enumName = typeMapper.QualifyTypeName(fieldType);

        foreach (Param p in commandParams)
        {
            translator.PopLocal(p.Name);
        }

        var conditions = sources.Select(r =>
        {
            // Objects.equals — NOT a bare `==`. Java enum constants are singletons, so `==` would also be
            // correct here, but the translator renders `status == Draft` in a `requires` as
            // `Objects.equals(...)`, and the two forms have to be textually identical for the
            // restates-a-precondition suppression below to recognize them as the same check.
            var srcEq = $"java.util.Objects.equals({field}, {enumName}.{JavaNaming.EscapeIdentifier(r.From)})";
            if (r.Guard is null)
            {
                return new JavaStateSource(srcEq, "!" + srcEq);
            }

            // A guarded source: keep the guard parenthesized so an `||` guard binds below the `&&`
            // joining it to the source check.
            var guard = translator.Translate(r.Guard, JavaExpressionTranslator.NameMode.Property);
            var positive = $"{srcEq} && ({guard})";
            return new JavaStateSource(positive, $"!({positive})");
        }).ToList();

        foreach (Param p in commandParams)
        {
            translator.PushLocal(p.Name, p.Type);
        }

        return conditions;
    }

    /// <summary>
    /// Writes the reachability guard from prebuilt source conditions: the transition is illegal unless the
    /// current state is one of the legal sources, so the test is the De Morgan negation
    /// (<c>!a &amp;&amp; !b</c>) and the failure throws <c>DomainException</c>. Placed before the
    /// assignment, so an illegal move never mutates the entity.
    /// </summary>
    private static void WriteStateMachineGuard(
        StringBuilder sb, IReadOnlyList<JavaStateSource> conditions, string field, string targetState)
    {
        var test = string.Join(" && ", conditions.Select(c => c.Negated));
        sb.Append(Indent).Append(Indent).Append("if (").Append(test).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append(Indent).Append("throw new koine.runtime.DomainException(")
          .Append(JavaStringLiteral($"illegal transition of {field} to {targetState}")).Append(");\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Removes one balanced outer parenthesis pair when the whole string is wrapped in it
    /// (<c>(a == b)</c> → <c>a == b</c>), leaving a string with unbalanced or no outer parens untouched
    /// (<c>(a) &amp;&amp; (b)</c> stays as-is). Used to compare a translator-rendered, possibly
    /// top-level-parenthesized precondition against a bare-built source condition — the Java port of the
    /// C#/Python <c>StripOuterParens</c>.
    /// </summary>
    private static string StripOuterParens(string s)
    {
        if (s.Length < 2 || s[0] != '(' || s[^1] != ')')
        {
            return s;
        }

        var depth = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '(')
            {
                depth++;
            }
            else if (s[i] == ')')
            {
                depth--;
                // The opening paren closes before the end → the outer pair isn't a single wrapper.
                if (depth == 0 && i != s.Length - 1)
                {
                    return s;
                }
            }
        }

        return s[1..^1];
    }
}
