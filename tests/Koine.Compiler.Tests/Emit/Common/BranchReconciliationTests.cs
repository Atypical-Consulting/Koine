using Koine.Compiler.Ast;

namespace Koine.Compiler.Tests;

/// <summary>
/// The shared conditional-branch reconciliation classifier (#1368): the one place that decides which
/// of the three reconciliation dimensions — numeric widen, optional map-widen, <c>Some</c>-wrap — a
/// <c>ConditionalExpr</c> branch needs to agree with its SIBLING branch, given the two inferred
/// <see cref="TypeRef"/>s. Five emitters (Rust, Java, Kotlin, TypeScript, Python) each used to derive
/// these three booleans inline in their own <c>WriteReconciledBranch</c>, byte-for-byte identically —
/// so a change to the widening rule needed five synchronized hand-edits with nothing to catch a missed
/// one (the drift class #1343 already showed once). The DECISION is shared here; each emitter keeps
/// only its own target-syntax RENDERING (<c>Some(...)</c> / <c>Optional.of(...)</c> / <c>?.let</c> /
/// walrus / IIFE), which genuinely differs per target.
/// <para>
/// These cases are the boolean table the five inline copies encoded, exercised once instead of five
/// times — including the null (unresolved-type) degradation each inline <c>is { … }</c> pattern got
/// for free and which no per-target suite covered explicitly.
/// </para>
/// </summary>
public class BranchReconciliationTests
{
    private static TypeRef Type(string name, bool optional = false) => new(name, IsOptional: optional);

    [Fact]
    public void NonOptionalIntBranchAgainstDecimalSibling_NeedsWiden()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Int"), Type("Decimal"));

        r.NeedsWiden.ShouldBeTrue();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void OptionalIntBranchAgainstDecimalSibling_NeedsOptionalWiden()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Int", optional: true), Type("Decimal"));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeTrue();
        // The branch is already optional, so it never also needs the Some(...) wrap.
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void NonOptionalBranchAgainstOptionalSibling_NeedsSomeWrap()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("String"), Type("String", optional: true));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeTrue();
    }

    [Fact]
    public void NonOptionalIntBranchAgainstOptionalDecimalSibling_ComposesWidenWithSomeWrap()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Int"), Type("Decimal", optional: true));

        // Widen inside, wrap outside: the value must be a Decimal before it becomes an optional Decimal.
        r.NeedsWiden.ShouldBeTrue();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeTrue();
    }

    [Fact]
    public void OptionalIntBranchAgainstOptionalDecimalSibling_MapWidensWithoutSomeWrap()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Int", optional: true), Type("Decimal", optional: true));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeTrue();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void MatchingTypes_NeedNoReconciliation()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Decimal"), Type("Decimal"));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void DecimalBranchAgainstIntSibling_NeedsNothing_TheSiblingWidensInstead()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Decimal"), Type("Int"));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void OptionalBranchAgainstNonOptionalSibling_NeedsNothing_TheSiblingWrapsInstead()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("String", optional: true), Type("String"));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void NullBranchType_DegradesToNoReconciliation()
    {
        BranchReconciliation r = BranchReconciliation.Classify(null, Type("Decimal", optional: true));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void NullSiblingType_DegradesToNoReconciliation()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Int"), null);

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void BothTypesNull_DegradesToNoReconciliation()
    {
        BranchReconciliation r = BranchReconciliation.Classify(null, null);

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }

    [Fact]
    public void IntBranchAgainstNonNumericSibling_NeedsNoWiden()
    {
        BranchReconciliation r = BranchReconciliation.Classify(Type("Int"), Type("Money"));

        r.NeedsWiden.ShouldBeFalse();
        r.NeedsOptionalWiden.ShouldBeFalse();
        r.NeedsSomeWrap.ShouldBeFalse();
    }
}
