using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the Kotlin backend (issue #1066, Task 9). It exercises the
/// <see cref="TestSupport.CompileKotlin"/> plumbing — write the emitted <c>.kt</c> tree and compile it with
/// <c>kotlinc</c> — proving a representative model (and the real starter/pizzeria templates) emits Kotlin a
/// real compiler accepts, and that the harness genuinely type-checks (a corrupted file is rejected). When no
/// <c>kotlinc</c> is present the compile is funneled through <see cref="TestSupport.RequireOrSkip"/>, which
/// reports the test as <c>Skipped</c> (not a false Passed) — keeping <c>dotnet test</c> green without a Kotlin
/// toolchain while surfacing the gap. It NEVER silently passes a real error: a real error is only assertable
/// when <c>kotlinc</c> is usable, and then it IS asserted. CI sets <c>KOINE_REQUIRE_CONFORMANCE</c> and
/// installs <c>kotlinc</c>, so a missing toolchain there is a hard <c>Failed</c> rather than a silent skip.
/// </summary>
public class KotlinConformanceTests
{
    private const string NoToolchainNotice =
        "No usable kotlinc toolchain available; kotlinc not run. " +
        "Install kotlinc (or set KOINE_KOTLINC) — CI runs this for real.";

    /// <summary>
    /// A representative bounded context exercising the whole Phase-1 tactical core: value objects with
    /// invariants (a <c>BigDecimal</c> <c>compareTo</c> guard and a regex <c>matches</c> guard), a smart enum
    /// carrying associated data, an entity with a branded identity, an optional field, an invariant-guarded
    /// behavior raising an event, a domain event under the sealed <c>DomainEvent</c>, a foreign identity, and an
    /// aggregate-root repository interface.
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
    /// A two-context model exercising cross-target-sensitive shapes: a cross-context type reference (Sales
    /// references Catalog's <c>Currency</c> enum and <c>Topping</c> value object, which must emit
    /// package-qualified), a <c>Range&lt;Instant&gt;</c> field resolving to <c>koine.runtime.Range</c>, and
    /// value-object arithmetic (<c>unitPrice * quantity</c> and <c>lines.sum(l =&gt; l.subtotal)</c>) lowering to
    /// the demand-driven <c>times</c>/<c>plus</c> operators.
    /// </summary>
    private const string CrossContextArithmeticFixture = """
        contextmap {
          Catalog -> Sales : conformist
        }

        context Catalog {
          value Topping { name: String }
          enum Currency { EUR, USD }
        }

        context Sales {
          import Catalog.{ Topping, Currency }

          value Money {
            amount:   Decimal
            currency: Currency
          }

          value OrderLine {
            quantity:  Int
            unitPrice: Money
            toppings:  List<Topping>
            subtotal:  Money = unitPrice * quantity
          }

          value Basket {
            lines:  List<OrderLine>
            window: Range<Instant>
            total:  Money = lines.sum(l => l.subtotal)
          }
        }
        """;

    /// <summary>A representative model must emit Kotlin that <c>kotlinc</c> accepts (skipped if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_the_billing_tactical_core()
    {
        var result = new KoineCompiler().Compile(BillingFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Cross-context (package-qualified) references, a <c>Range&lt;T&gt;</c> field, and value-object arithmetic
    /// (<c>vo * scalar</c> and a <c>sum</c> of a value object) must all emit Kotlin <c>kotlinc</c> accepts
    /// (skipped if no toolchain). The shapes are asserted directly (independent of whether kotlinc is present).
    /// </summary>
    [Fact]
    public void Harness_accepts_cross_context_arithmetic_and_range()
    {
        var result = new KoineCompiler().Compile(CrossContextArithmeticFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("sales/Money.kt", StringComparison.Ordinal)).Contents;
        money.ShouldContain("val currency: koine.generated.catalog.Currency"); // cross-context qualification
        money.ShouldContain("operator fun times(factor: Long): Money");        // demand-driven scalar op
        money.ShouldContain("operator fun plus(other: Money): Money");         // demand-driven additive op

        var basket = result.Files.Single(f => f.RelativePath.EndsWith("Basket.kt", StringComparison.Ordinal)).Contents;
        basket.ShouldContain("val window: koine.runtime.Range<java.time.Instant>"); // Range<T> field
        basket.ShouldContain(".reduceOrNull { acc, e -> acc.plus(e) }");            // sum folds with plus

        var orderLine = result.Files.Single(f => f.RelativePath.EndsWith("OrderLine.kt", StringComparison.Ordinal)).Contents;
        orderLine.ShouldContain("this.unitPrice.times(this.quantity)");            // vo * scalar lowering
        orderLine.ShouldContain("List<koine.generated.catalog.Topping>");         // cross-context element

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>The billing starter template must emit Kotlin that <c>kotlinc</c> accepts (skipped if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_the_billing_starter_template()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The six-context pizzeria template (the C# demo's end-to-end domain) emits Kotlin that <c>kotlinc</c>
    /// accepts — the real multi-context proof (compile-only for Phase 1, skipped if no toolchain).
    /// </summary>
    [Fact]
    public void Harness_accepts_the_pizzeria_template()
    {
        if (FindTemplateDir("pizzeria") is not { } sources)
        {
            Assert.Skip("Pizzeria template not found from the test assembly; kotlinc not run.");
            return;
        }

        var result = new KoineCompiler().Compile(sources, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A real compile error must be reported, not silently swallowed — this proves the harness is a genuine
    /// <c>kotlinc</c> check. We take a well-formed emit and corrupt one file with a deliberate syntax error;
    /// the compile must FAIL.
    /// </summary>
    [Fact]
    public void Harness_rejects_ill_formed_kotlin()
    {
        var result = new KoineCompiler().Compile(BillingFixture, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var corrupted = result.Files
            .Select(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)
                ? new EmittedFile(f.RelativePath, "package koine.generated.billing\n\nthis is not valid kotlin\n")
                : f)
            .ToList();

        var r = TestSupport.CompileKotlin(corrupted);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldNotBeEmpty();
    }

    /// <summary>
    /// The outcome contract <see cref="TestSupport.RequireOrSkip"/> relies on: a missing toolchain yields a
    /// <see cref="TestSupport.KotlinCheck.Skipped"/> result whose <c>ToolchainAvailable</c> and <c>Ok</c> are
    /// both <c>false</c> — so it can never be mistaken for a real pass.
    /// </summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.KotlinCheck skipped = TestSupport.KotlinCheck.Skipped;
        skipped.ToolchainAvailable.ShouldBeFalse();
        skipped.Ok.ShouldBeFalse();
    }

    /// <summary>Loads every <c>.koi</c> file under a <c>templates/&lt;folder&gt;</c> directory as one model's sources.</summary>
    private static IReadOnlyList<SourceFile>? FindTemplateDir(string folder)
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (!Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                continue;
            }

            var templateDir = Path.Combine(dir.FullName, "templates", folder);
            return Directory.Exists(templateDir)
                ? Directory
                    .EnumerateFiles(templateDir, "*.koi", SearchOption.AllDirectories)
                    .OrderBy(p => p, StringComparer.Ordinal)
                    .Select(p => new SourceFile(p, File.ReadAllText(p)))
                    .ToList()
                : null;
        }

        return null;
    }
}
