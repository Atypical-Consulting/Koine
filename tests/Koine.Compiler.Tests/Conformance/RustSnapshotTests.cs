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

    /// <summary>
    /// An expression-heavy fixture exercising the <see cref="RustExpressionTranslator"/>: string ops
    /// (trim/upper/lower/startsWith/endsWith/contains/isBlank/length), collection ops
    /// (isEmpty/all/any/none/count), enum equality, null-coalescing, and a <c>let…in</c> binding.
    /// </summary>
    private const string ExpressionFixture = """
        context Expr {
          enum Status { Open, Closed }
          value Doc {
            title:  String
            tags:   List<String>
            note:   String?
            status: Status
            invariant title.trim.length > 0 "title required"
            invariant title.startsWith("Dr") || title.endsWith(".") "format"
            invariant !tags.isEmpty "tags required"
            invariant tags.all(t => t.trim.length > 0) "no blank tags"
            invariant tags.any(t => t.contains("x")) "needs an x tag"
            invariant tags.none(t => t.isBlank) "no blank"
            invariant tags.count >= 1 "at least one"
            invariant status == Open "must be open"
            invariant (note ?? title).length > 0 "note or title"
            invariant let n = title.trim in n.length < 100 "title too long"
          }
        }
        """;

    [Fact]
    public Task Rust_expressions_emit_expected_rust()
    {
        var result = new KoineCompiler().Compile(ExpressionFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_expressions_compile()
    {
        var result = new KoineCompiler().Compile(ExpressionFixture, new RustEmitter());
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
