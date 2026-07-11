using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Which reconciliation dimensions one <c>ConditionalExpr</c> branch needs to agree in type with its
/// SIBLING branch — the target-agnostic DECISION half of every emitter's <c>WriteReconciledBranch</c>
/// (#1368). <see cref="TypeResolver"/> legitimately lets a conditional's two branches differ in numeric
/// type (<c>Int</c>/<c>Decimal</c>) and/or optionality, widening the conditional's own joined type
/// accordingly (#975) — but most targets require both arms of the emitted conditional to share a type,
/// so each branch must be reconciled against the other where they disagree (Rust <c>if</c>/<c>else</c>
/// #1311/#1331/#1335, Java/Kotlin/TypeScript/Python's ternary equivalents #1344).
///
/// <para><b>Shared across the five code emitters that reconcile branches</b> (Rust, Java, Kotlin,
/// TypeScript, Python): each derived these three booleans inline, byte-for-byte identically, so a change
/// to the widening rule (a third numeric primitive, say) needed five synchronized hand-edits with
/// nothing — no compiler error, no shared test — to catch a missed one. That drift class already bit
/// once (#1343). The decision lives here; the RENDERING stays emitter-local, because it genuinely
/// differs per target (<c>Some(...)</c> / <c>java.util.Optional.of(...)</c> / <c>?.let { }</c> /
/// a walrus binding / an IIFE). Mirrors the precedent <see cref="OperatorNeedsAnalyzer"/> set in
/// <c>Koine.Emit.Common</c>: computed once, consumed by every target.</para>
///
/// <para>Pure: derived from the two <see cref="TypeRef"/>s alone, so the boolean table is unit-tested
/// once rather than five times.</para>
/// </summary>
/// <param name="NeedsWiden">
/// The branch is a non-optional <c>Int</c> while the sibling is <c>Decimal</c> — the branch's value must
/// be widened to the target's decimal type (Rust <c>Decimal::from(...)</c>, Java
/// <c>BigDecimal.valueOf(...)</c>, TypeScript <c>Decimal.fromInt(...)</c>, Python <c>Decimal(...)</c>).
/// </param>
/// <param name="NeedsOptionalWiden">
/// The branch is an OPTIONAL <c>Int</c> while the sibling is <c>Decimal</c> — the branch already renders
/// as an optional-shaped value, so a bare widen wrapped around it does not compile; the widening must
/// happen INSIDE the optional (Rust <c>.map(Decimal::from)</c>, Java
/// <c>.map(BigDecimal::valueOf)</c>, Kotlin <c>?.let { }</c>, and TypeScript/Python's own
/// none-preserving idioms) (#1335).
/// </param>
/// <param name="NeedsSomeWrap">
/// The branch is non-optional while the sibling is optional — the branch's value must be lifted into the
/// target's optional shape (Rust <c>Some(...)</c>, Java <c>Optional.of(...)</c>). Targets whose optional
/// is a plain nullable union (TypeScript, Kotlin, Python) need no lift and simply ignore this dimension.
/// </param>
/// <remarks>
/// <para><see cref="NeedsWiden"/> and <see cref="NeedsOptionalWiden"/> are mutually exclusive: they key
/// off the same branch's own optionality (the former requires it non-optional, the latter optional).</para>
/// <para><see cref="NeedsWiden"/> COMPOSES with <see cref="NeedsSomeWrap"/> — widen inside, wrap outside
/// (<c>Some(Decimal::from(...))</c>): the value must be a decimal before it becomes an optional decimal.
/// <see cref="NeedsOptionalWiden"/> never composes with <see cref="NeedsSomeWrap"/>, because
/// <see cref="NeedsSomeWrap"/> also requires the branch to be non-optional — a branch that is already
/// optional-shaped never needs the extra lift.</para>
/// <para>An unresolved type (a <see langword="null"/> <see cref="TypeRef"/> on either side) degrades to
/// "no reconciliation needed" on every dimension — the emitter renders the branch as-is rather than
/// guessing.</para>
/// </remarks>
internal readonly record struct BranchReconciliation(
    bool NeedsWiden,
    bool NeedsOptionalWiden,
    bool NeedsSomeWrap)
{
    /// <summary>
    /// Classifies one conditional branch against its sibling. <paramref name="branch"/> and
    /// <paramref name="sibling"/> are the two branches' INFERRED types (a <see langword="null"/> means
    /// the type did not resolve — see the remarks on <see cref="BranchReconciliation"/>).
    /// </summary>
    public static BranchReconciliation Classify(TypeRef? branch, TypeRef? sibling) => new(
        NeedsWiden: branch is { Name: "Int", IsOptional: false } && sibling?.Name == "Decimal",
        NeedsOptionalWiden: branch is { Name: "Int", IsOptional: true } && sibling?.Name == "Decimal",
        NeedsSomeWrap: branch is { IsOptional: false } && sibling is { IsOptional: true });
}
