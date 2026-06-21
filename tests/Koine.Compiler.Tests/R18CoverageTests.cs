using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R18 — target-agnostic model coverage: which declared types a target actually emitted.
/// </summary>
public class R18CoverageTests
{
    [Fact]
    public void Compute_marks_declared_types_emitted_in_csharp_as_covered()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        var report = ModelCoverage.Compute(result.Model!, result.Files, "csharp");

        report.Target.ShouldBe("csharp");
        report.Items.ShouldContain(i => i.Kind == "value" && i.Name == "Money" && i.State == CoverageState.Covered);
        report.IsComplete.ShouldBeTrue();
    }

    [Fact]
    public void Aggregate_with_a_distinct_boundary_name_is_covered_via_its_root()
    {
        // An aggregate boundary is never emitted as a C# type (it has no sub-namespace); it is
        // realized when its ROOT entity is emitted. So coverage must match an aggregate on its root,
        // not on the boundary name — otherwise the recommended distinct-boundary shape (e.g.
        // `aggregate Sales root Order`) would always read as "missing".
        const string src =
            "context C {\n  aggregate Sales root Order {\n    entity Order identified by OrderId { x: Int }\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());

        var report = ModelCoverage.Compute(result.Model!, result.Files, "csharp");

        CoverageItem aggregate = report.Items.Single(i => i.Kind == "aggregate");
        aggregate.Name.ShouldBe("Sales");
        aggregate.State.ShouldBe(CoverageState.Covered);
        report.IsComplete.ShouldBeTrue();
    }

    [Fact]
    public void Compute_marks_types_missing_when_nothing_emitted()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        var report = ModelCoverage.Compute(result.Model!, Array.Empty<EmittedFile>(), "csharp");

        report.IsComplete.ShouldBeFalse();
        report.Items.ShouldContain(i => i.State == CoverageState.Missing);
    }

    /// <summary>
    /// The stable JSON the <c>koine coverage --json</c> command prints: every billing construct
    /// with its <c>State</c>, plus the <c>Target</c>/<c>Total</c>/<c>Covered</c>/<c>IsComplete</c>
    /// rollups. Reviewing this snapshot is the review of what the CLI reports.
    /// </summary>
    [Fact]
    public Task ToJson_renders_a_stable_coverage_report_for_billing()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        var report = ModelCoverage.Compute(result.Model!, result.Files, "csharp");

        return Verify(ModelCoverage.ToJson(report)).UseDirectory("Snapshots");
    }

    /// <summary>
    /// The exit-code contract the <c>coverage</c> command maps onto: a complete report exits 0,
    /// while a report with any <see cref="CoverageState.Missing"/> type (here: nothing emitted)
    /// exits 1. This is process-free — it asserts the same expression the command returns.
    /// </summary>
    [Fact]
    public void IsComplete_maps_to_the_command_exit_code()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());

        var full = ModelCoverage.Compute(result.Model!, result.Files, "csharp");
        (full.IsComplete ? 0 : 1).ShouldBe(0);

        var empty = ModelCoverage.Compute(result.Model!, Array.Empty<EmittedFile>(), "csharp");
        (empty.IsComplete ? 0 : 1).ShouldBe(1);
    }

    /// <summary>
    /// The docs target appends a "## Coverage" section per context — a per-kind covered/total table
    /// reusing the analyzer. Snapshotting the Billing docs output keeps that rendered shape reviewed.
    /// </summary>
    [Fact]
    public Task Docs_target_appends_a_coverage_section_for_billing()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new DocsEmitter());

        result.Files.ShouldContain(f => f.Contents.Contains("## Coverage", StringComparison.Ordinal));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }
}
