using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
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
    public void Compute_marks_types_missing_when_nothing_emitted()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        var report = ModelCoverage.Compute(result.Model!, Array.Empty<EmittedFile>(), "csharp");

        report.IsComplete.ShouldBeFalse();
        report.Items.ShouldContain(i => i.State == CoverageState.Missing);
    }
}
