namespace Koine.Compiler;

/// <summary>
/// The target-agnostic DECISION half of the shared-result hoist every code emitter's
/// <c>WriteCommand</c> performs (#1838): when a command's <c>result</c> expression is ALSO a whole
/// <c>emit</c>/<c>publish</c> payload argument, the expression must be bound to one local and read
/// from it, instead of being rendered a second time at the <c>return</c>.
///
/// <para><b>Why this is correctness, not style.</b> Koine expressions are not all pure —
/// <c>now</c> reads the clock. Rendering it twice produces two reads at two different instants, so
/// the payload the event RECORDS and the value the command RETURNS can disagree; with an
/// <c>emit</c> and a <c>publish</c> of the same expression, the domain event and the integration
/// event that is supposed to mirror it disagree too. Evaluating once is the only rendering that
/// makes the recorded history and the caller's answer the same fact.</para>
///
/// <para><b>Why the match must be per WHOLE argument.</b> The comparison happens on the RENDERED
/// target string, so a substring test would splice the local into an unrelated identifier: a
/// <c>taxRate</c> sibling argument next to a <c>tax</c> result renders as <c>TaxRate</c> around the
/// result's own <c>Tax</c>, and a substring replace would produce <c>__resultRate</c> — code that
/// does not compile. <see cref="ShouldSubstitute"/> is therefore an EQUALITY test, and the caller
/// must apply it to each argument's own rendering rather than to the assembled statement.</para>
///
/// <para><b>Why only the decision is shared.</b> The rendering is genuinely per-target — the local's
/// binding syntax differs (<c>var __result =</c>, <c>const __result =</c>, <c>$__result =</c>,
/// <c>let __result =</c>, a bare <c>__result =</c>), and so does what a "whole argument" even is
/// (positional for C#/TypeScript/PHP, a <c>field=value</c> keyword pair for Python, where only the
/// VALUE half participates). So the policy lives here and the syntax stays in
/// <c>Koine.Emit.&lt;Target&gt;</c>, the same split already used by
/// <see cref="FactoryIdBinding"/>, <see cref="RouteDerivation"/> and <c>BranchReconciliation</c>.</para>
/// </summary>
/// <remarks>
/// The emitter contract this helper serves has three parts, and all three are needed for the hoist
/// to be correct:
/// <list type="number">
///   <item>translate the <c>result</c> expression FIRST, in the same scope as the payloads (command
///   parameters still pushed as locals) — otherwise the two renderings would not be comparable in
///   the first place;</item>
///   <item>pass that rendering down to every emit/publish statement builder, each of which reports
///   back whether it substituted, and OR the flags together — ONE local serves every clause;</item>
///   <item>bind the local AFTER the post-mutation invariant re-check and BEFORE the first event
///   statement, so an invalid post-state still throws before anything is computed or recorded, and
///   return the local instead of re-rendering the expression.</item>
/// </list>
/// </remarks>
public static class ResultHoist
{
    /// <summary>
    /// The name of the hoisted local, shared by every target so the emitted shape reads the same
    /// across backends. The double underscore keeps it out of the way of model-derived identifiers,
    /// which in practice never start with one.
    /// <para>Python note: an identifier of this form occurring textually inside a <c>class</c> body is
    /// subject to CPython private-name mangling — but mangling rewrites the binding and every read
    /// alike (both become <c>_&lt;Class&gt;__result</c>), so a method-local under this name binds and
    /// reads correctly. Verified against CPython 3.14; no target needs a different name.</para>
    /// </summary>
    public const string LocalName = "__result";

    /// <summary>
    /// Whether one rendered payload argument IS the rendered result expression, and so must be
    /// replaced by <see cref="LocalName"/>.
    /// </summary>
    /// <param name="renderedArgument">
    /// The argument as the target's translator rendered it. For a keyword-argument target (Python)
    /// this must be the VALUE half alone — passing the <c>field=value</c> composite would never
    /// match, silently disabling the hoist.
    /// </param>
    /// <param name="renderedResultExpr">
    /// The command's <c>result</c> expression as rendered in the SAME scope, or <see langword="null"/>
    /// when the command has no <c>result</c> — in which case nothing is ever substituted, which is
    /// what keeps an effect-only command free of a spurious local.
    /// </param>
    /// <returns><see langword="true"/> only on an exact, whole-argument, Ordinal match.</returns>
    /// <remarks>
    /// Ordinal — never culture-aware: these are source-code fragments, so <c>I</c>/<c>ı</c>-style
    /// linguistic equivalence would be actively wrong, and two identifiers are the same identifier
    /// only when they are the same bytes.
    /// </remarks>
    public static bool ShouldSubstitute(string renderedArgument, string? renderedResultExpr) =>
        renderedResultExpr is not null
        && string.Equals(renderedArgument, renderedResultExpr, StringComparison.Ordinal);
}
