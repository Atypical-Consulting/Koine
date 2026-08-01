using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Rust sibling of the C# fix in #1756/#1760 (<c>DerivedMemberInvariantTests</c>). A value object's
/// <c>invariant</c> guard runs in <see cref="RustExpressionTranslator.NameMode.Parameter"/>, BEFORE
/// <c>Ok(Self { .. })</c> constructs the instance, so a member reference there renders as the bare
/// constructor parameter of the same name. That is exact for a <b>stored</b> field (it IS a
/// parameter) but wrong for a <b>derived</b> one — a computed accessor with no constructor parameter
/// at all — which used to emit a dangling bare name that binds to nothing (<c>rustc</c> E0425).
/// Fixed by substituting the derived member's defining expression at the reference site (issue
/// #1764). Skipped (not failed) when no Rust toolchain is present; CI installs one and runs for real.
/// </summary>
public class RustDerivedMemberInvariantTests
{
    private const string NoToolchainNotice =
        "No usable Rust toolchain (cargo, networked) available; compile not run. " +
        "Install Rust (or set KOINE_CARGO) — CI runs this for real.";

    // The issue's own minimal repro.
    private const string UsageMeterModel = """
        context Subscription {
          value UsageMeter {
            includedQuota: Int
            consumed:      Int
            overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
            invariant overage >= 0 "overage can never be negative"
          }
        }
        """;

    /// <summary>
    /// Task 1 — Red: an invariant over a derived member must emit Rust that actually compiles. Before
    /// the fix this failed with <c>error[E0425]: cannot find value `overage` in this scope</c>.
    /// </summary>
    [Fact]
    public void Invariant_over_derived_member_emits_compiling_rust()
    {
        var result = new KoineCompiler().Compile(UsageMeterModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
