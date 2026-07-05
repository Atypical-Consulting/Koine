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

    /// <summary>
    /// A two-context model exercising the three javac-17 gaps closed after the initial Java backend
    /// landed (verification against a real JDK 17): (1) a <b>cross-context type reference</b> — <c>Sales</c>
    /// references <c>Catalog</c>'s <c>Currency</c> enum and <c>Topping</c> value object, which must emit
    /// package-qualified (<c>koine.generated.catalog.…</c>) since they live in another package; (2) a
    /// <c>Range&lt;Instant&gt;</c> field, which must resolve to the emitted <c>koine.runtime.Range</c>; and
    /// (3) <b>value-object arithmetic</b> — <c>unitPrice * quantity</c> (a <c>value-object * scalar</c>) and
    /// <c>lines.sum(l =&gt; l.subtotal)</c> (a <c>sum</c> fold over a value object), which must lower to the
    /// demand-generated <c>times</c>/<c>plus</c> methods (Java reference types carry no operators).
    /// </summary>
    private const string CrossContextArithmeticFixture = """
        contextmap {
          Catalog -> Sales : conformist
        }

        context Catalog {
          /// A pizza topping — owned by Catalog, referenced cross-context by Sales.
          value Topping {
            name: String
          }

          /// A currency — owned by Catalog, referenced cross-context by Sales.
          enum Currency { EUR, USD }
        }

        context Sales {
          import Catalog.{ Topping, Currency }

          /// A monetary amount. `Currency` is owned by Catalog (a cross-context reference).
          value Money {
            amount:   Decimal
            currency: Currency
          }

          /// One order line: value-object arithmetic (`unitPrice * quantity`) and a
          /// cross-context `Topping` collection.
          value OrderLine {
            quantity:  Int
            unitPrice: Money
            toppings:  List<Topping>
            subtotal:  Money = unitPrice * quantity
          }

          /// A basket: a `sum` fold over a value object and a `Range<Instant>` field.
          value Basket {
            lines:  List<OrderLine>
            window: Range<Instant>
            total:  Money = lines.sum(l => l.subtotal)
          }
        }
        """;

    /// <summary>
    /// The regression coverage for the three javac-17 gaps: a cross-context (package-qualified) type
    /// reference, a <c>Range&lt;T&gt;</c> field, and value-object arithmetic (<c>vo * scalar</c> plus a
    /// <c>sum</c> of a value object) must all emit Java that <c>javac --release 17</c> accepts (skipped if
    /// no JDK 17+). Before the fix each of these was a hard <c>javac</c> error.
    /// </summary>
    [Fact]
    public void Harness_accepts_cross_context_arithmetic_and_range()
    {
        var result = new KoineCompiler().Compile(CrossContextArithmeticFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The three fixed shapes, asserted directly (independent of whether a JDK is present).
        var money = result.Files.Single(f => f.RelativePath.EndsWith("sales/Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("koine.generated.catalog.Currency currency"); // (1) cross-context qualification
        money.ShouldContain("public Money times(long factor)");           // (3) demand-driven scalar op
        money.ShouldContain("public Money plus(Money other)");            // (3) demand-driven additive op

        var basket = result.Files.Single(f => f.RelativePath.EndsWith("Basket.java", StringComparison.Ordinal)).Contents;
        basket.ShouldContain("koine.runtime.Range<java.time.Instant> window"); // (2) Range<T> field
        basket.ShouldContain(".reduce(Money::plus)");                          // (3) sum folds with plus

        var orderLine = result.Files.Single(f => f.RelativePath.EndsWith("OrderLine.java", StringComparison.Ordinal)).Contents;
        orderLine.ShouldContain("this.unitPrice().times(this.quantity())");     // (3) vo * scalar lowering
        orderLine.ShouldContain("java.util.List<koine.generated.catalog.Topping>"); // (1) cross-context element

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

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
