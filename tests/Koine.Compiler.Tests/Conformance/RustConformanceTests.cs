using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the Rust backend (issue #24, Task 2). It exercises the
/// <see cref="TestSupport.CompileRust"/> plumbing — write emitted <c>.rs</c> into a temp crate and run
/// <c>cargo check</c> — so it is ready to validate the Rust emitter as it lands. When no usable
/// <c>cargo</c> toolchain is present (absent, or present-but-offline so crate dependencies can't be
/// fetched) the compile is reported as INCONCLUSIVE (a notice on the test output, no assertion) rather
/// than failing — keeping <c>dotnet test</c> green without a networked Rust toolchain. It NEVER
/// silently passes a real error: a real error is only assertable when <c>cargo</c> is usable, and then
/// it IS asserted. CI is expected to provide the toolchain and therefore actually run the check.
/// </summary>
public class RustConformanceTests
{
    private readonly ITestOutputHelper _output;

    public RustConformanceTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no usable Rust toolchain (cargo, networked) available; compile not run. " +
        "Install Rust (or set KOINE_CARGO) — CI runs this for real.";

    /// <summary>A well-formed, dependency-free crate must compile (inconclusive if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_well_formed_rust()
    {
        var files = new[]
        {
            new EmittedFile("src/lib.rs", "pub fn f(x: i64) -> i64 {\n    x + 1\n}\n"),
        };

        var r = TestSupport.CompileRust(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A real compile error must be reported, not silently swallowed — this proves the harness is a
    /// genuine check (the analogue of the Python/TypeScript negative fixtures).
    /// </summary>
    [Fact]
    public void Harness_rejects_ill_formed_rust()
    {
        var files = new[]
        {
            // Returns a &str from a function annotated to return i64 → a real rustc type error.
            new EmittedFile("src/lib.rs", "pub fn f(x: i64) -> i64 {\n    \"nope\"\n}\n"),
        };

        var r = TestSupport.CompileRust(files);
        if (!r.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldNotBeEmpty();
    }

    /// <summary>A missing toolchain yields an inconclusive-shaped result rather than a false pass.</summary>
    [Fact]
    public void Missing_toolchain_is_inconclusive_not_a_false_pass()
    {
        TestSupport.RustCheck skipped = TestSupport.RustCheck.Skipped;
        skipped.ToolchainAvailable.ShouldBeFalse();
        skipped.Ok.ShouldBeFalse();
    }
}
