using Koine.Compiler.Emit.Rust;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Snapshot + <c>cargo check</c> coverage for the Rust backend (issue #24), the Rust analogue of
/// <see cref="PythonSnapshotTests"/>. Each milestone fixture is snapshot-tested (the diff is the review
/// of the generated Rust) AND compiled with <see cref="TestSupport.CompileRust"/> when a usable Rust
/// toolchain is present — so a green build proves the emitted crate compiles. When the toolchain is
/// absent/offline the compile is reported INCONCLUSIVE rather than failing.
/// </summary>
public class RustSnapshotTests
{
    private readonly ITestOutputHelper _output;

    public RustSnapshotTests(ITestOutputHelper output) => _output = output;

    private const string NoToolchainNotice =
        "INCONCLUSIVE: no usable Rust toolchain (cargo, networked) available; cargo check not run.";

    /// <summary>Value objects + a smart enum with associated data + a regex-validated value object.</summary>
    private const string ValueObjectFixture = """
        context Billing {
          /// A monetary amount in a currency. Never negative.
          value Money {
            amount:   Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }

          /// Currencies, carrying their symbol and minor-unit count.
          enum Currency(symbol: String, decimals: Int) {
            EUR("€", 2)
            USD("$", 2)
            GBP("£", 2)
          }

          /// An email address, shape-validated.
          value Email {
            raw: String
            invariant raw matches /^[^@]+@[^@]+$/ "invalid email address"
          }
        }
        """;

    [Fact]
    public Task Rust_value_objects_emit_expected_rust()
    {
        var result = new KoineCompiler().Compile(ValueObjectFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The smart constructor returns Result and the failing-invariant path is reachable.
        var billing = result.Files.Single(f => f.RelativePath.EndsWith("billing.rs", StringComparison.Ordinal)).Contents;
        billing.ShouldContain("pub fn new(amount: Decimal, currency: Currency) -> Result<Self, DomainError>");
        billing.ShouldContain("return Err(DomainError::InvariantViolation { type_name: \"Money\"");
        billing.ShouldContain("regex_is_match");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_value_objects_compile()
    {
        var result = new KoineCompiler().Compile(ValueObjectFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
