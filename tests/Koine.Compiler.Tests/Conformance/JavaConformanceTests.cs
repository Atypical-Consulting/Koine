using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the Java backend (issue #858, Task 8). It exercises the
/// <see cref="TestSupport.CompileJava"/> plumbing — write the emitted <c>.java</c> tree and run
/// <c>javac --release 17</c> — proving a representative model emits Java that a real compiler accepts,
/// and that the harness genuinely type-checks (a corrupted file is rejected). The emitted code targets
/// Java 17 (records, sealed types), so when no JDK 17+ <c>javac</c> is present the compile is funneled
/// through <see cref="TestSupport.RequireOrSkip"/>, which reports the test as <c>Skipped</c> (not a false
/// Passed) — keeping <c>dotnet test</c> green without a modern JDK while surfacing the gap. It NEVER
/// silently passes a real error: a real error is only assertable when <c>javac</c> is usable, and then it
/// IS asserted. CI sets <c>KOINE_REQUIRE_CONFORMANCE</c> and installs a JDK 17+, so a missing/old
/// toolchain there is a hard <c>Failed</c> rather than a silent skip.
/// </summary>
public class JavaConformanceTests
{
    private const string NoToolchainNotice =
        "No usable JDK 17+ toolchain (javac >= 17) available; javac not run. " +
        "Install a JDK 17+ (or set KOINE_JAVAC to a javac >= 17) — CI runs this for real.";

    /// <summary>
    /// A representative bounded context that exercises the whole Phase-1 tactical core: value objects
    /// with invariants (records + validating compact constructors, a <c>BigDecimal</c> <c>compareTo</c>
    /// guard and a regex <c>matches</c> guard), a smart enum carrying associated data, an entity with a
    /// branded identity, an optional field, and an invariant-guarded behavior that raises an event, a
    /// domain event (a record implementing the sealed <c>DomainEvent</c> interface), a foreign identity,
    /// and an aggregate-root repository interface.
    /// </summary>
    private const string BillingFixture = """
        context Billing {
          /// A monetary amount in a currency. Never negative.
          value Money {
            amount:   Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }

          /// Currencies with their ISO code and minor-unit count.
          enum Currency(code: String, decimals: Int) {
            EUR("EUR", 2)
            USD("USD", 2)
          }

          /// An email address, shape-validated.
          value Email {
            raw: String
            invariant raw matches /^[^@]+@[^@]+$/ "invalid email address"
          }

          aggregate Invoicing root Invoice {
            repository {
              operations: getById, add, update
              find byCustomer(customer: CustomerId): List<Invoice>
            }

            event InvoiceIssued {
              invoiceId: InvoiceId
              total:     Money
            }

            enum InvoiceStatus { Draft, Issued, Paid }

            entity Invoice identified by InvoiceId {
              total:  Money
              status: InvoiceStatus = Draft
              note:   String?
              command issue {
                requires status == Draft "only a draft invoice can be issued"
                status -> Issued
                emit InvoiceIssued(invoiceId: id, total: total)
              }
            }
          }
        }
        """;

    /// <summary>A representative model must emit Java that <c>javac --release 17</c> accepts (skipped if no JDK 17+).</summary>
    [Fact]
    public void Harness_accepts_well_formed_java()
    {
        var result = new KoineCompiler().Compile(BillingFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A real compile error must be reported, not silently swallowed — this proves the harness is a
    /// genuine <c>javac</c> check (the analogue of the Rust/Python negative fixtures). We take the same
    /// well-formed emit and corrupt one file's contents with a deliberate syntax error; the compile must
    /// FAIL. (This asserts the harness type-checks, not that the emitter is wrong.)
    /// </summary>
    [Fact]
    public void Harness_rejects_ill_formed_java()
    {
        var result = new KoineCompiler().Compile(BillingFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Replace one emitted type with syntactically invalid Java (a stray statement where a type
        // declaration is expected) — everything else stays byte-identical to the accepted emit.
        var corrupted = result.Files
            .Select(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)
                ? new EmittedFile(f.RelativePath, "package koine.generated.billing;\n\nthis is not valid java;\n")
                : f)
            .ToList();

        var r = TestSupport.CompileJava(corrupted);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldNotBeEmpty();
    }

    /// <summary>
    /// The outcome contract <see cref="TestSupport.RequireOrSkip"/> relies on: a missing/old toolchain
    /// yields a <see cref="TestSupport.JavaCheck.Skipped"/> result whose <c>ToolchainAvailable</c> and
    /// <c>Ok</c> are both <c>false</c> — so it can never be mistaken for a real pass.
    /// </summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.JavaCheck skipped = TestSupport.JavaCheck.Skipped;
        skipped.ToolchainAvailable.ShouldBeFalse();
        skipped.Ok.ShouldBeFalse();
    }
}
