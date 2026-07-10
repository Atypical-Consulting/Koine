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
    /// Issue #1289 cross-target audit: <c>KotlinExpressionTranslator</c>'s value-object arithmetic lowering
    /// picks <c>.times</c>/<c>.div</c> based on the operand's FULL inferred type (<c>_resolver.Infer</c>),
    /// so it already recognized a compound (conditional) operand as a value object — but the
    /// demand-generation walker (the shared <c>OperatorNeedsAnalyzer.ScalarOpWalker</c>, fixed by #1289's
    /// Task 1) only recognized a bare identifier/literal, so the <c>times</c> operator it called was never
    /// actually generated for a conditional operand — a compile-time "unresolved reference" analogous to
    /// Rust's <c>cargo check</c> E0369. Fixed for free by the shared analyzer fix; this pins the
    /// regression on the Kotlin side too.
    /// </summary>
    [Fact]
    public void Plain_value_object_scalar_multiply_with_conditional_operand_emits_compiling_kotlin()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "  }\n" +
            "  value Bag {\n" +
            "    a: Money\n" +
            "    b: Money\n" +
            "    flag: Bool\n" +
            "    scaledConditional: Money = (if flag then a else b) * 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no toolchain required): the demand-generated operator the call site relies on.
        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)).Contents;
        money.ShouldContain("operator fun times(factor: Long): Money");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in numeric
    /// type (a non-optional <c>Int</c> branch against a <c>Decimal</c> sibling) must widen the <c>Int</c>
    /// branch to <c>java.math.BigDecimal.valueOf(...)</c> so both <c>if</c>/<c>else</c> arms share a type —
    /// Kotlin's <c>if</c>-expression (like Java's ternary) infers a least-upper-bound type across both arms
    /// that a bare <c>Long</c>/<c>BigDecimal</c> mismatch does not resolve to something assignable to the
    /// target <c>BigDecimal</c> member. Before the fix this emitted an unreconciled
    /// <c>if (flag) this.amount else this.amountDecimal</c> that <c>kotlinc</c> rejects.
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_emits_compiling_kotlin()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    amountDecimal: Decimal\n" +
            "    total: Decimal = if amount > 0 then amount else amountDecimal\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)).Contents;
        money.ShouldContain("java.math.BigDecimal.valueOf(");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in
    /// optionality (a non-optional branch against an optional sibling of the SAME underlying type) is
    /// already <c>kotlinc</c>-clean with no emitter change: Kotlin's <c>if</c>-expression infers <c>T?</c>
    /// as the least-upper-bound of a <c>T</c> arm and a <c>T?</c> arm, and a plain non-nullable <c>T</c> is
    /// directly assignable wherever <c>T?</c> is expected — unlike Rust's <c>Option&lt;T&gt;</c> or Java's
    /// <c>Optional&lt;T&gt;</c>, which are distinct nominal types that need an explicit wrap. This guards
    /// that Kotlin keeps taking the no-op path (no wrap emitted) for this shape.
    /// </summary>
    [Fact]
    public void Conditional_branch_optionality_only_mismatch_emits_compiling_kotlin()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Int?\n" +
            "    total: Int? = if amount > 0 then amount else bonus\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344 (the issue's exact repro): a <c>ConditionalExpr</c> derived-member body whose branches
    /// disagree in BOTH numeric type and optionality at once — a non-optional <c>Decimal</c> branch against
    /// an optional <c>Int</c> sibling — must null-safe-map-widen the optional <c>Int</c> branch
    /// (<c>?.let { java.math.BigDecimal.valueOf(it) }</c>) so both <c>if</c>/<c>else</c> arms are
    /// <c>BigDecimal?</c>-compatible; the non-optional <c>Decimal</c> branch needs no wrap since Kotlin's
    /// <c>if</c>-expression LUB already widens <c>BigDecimal</c>/<c>BigDecimal?</c> to <c>BigDecimal?</c>.
    /// Before the fix Kotlin rendered a bare <c>if (cond) this.decimalAmount else this.intBonus</c> — a
    /// <c>BigDecimal</c> against a bare <c>Long?</c> — which <c>kotlinc</c> rejects.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_emits_compiling_kotlin()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    decimalAmount: Decimal\n" +
            "    intBonus: Int?\n" +
            "    total: Decimal? = if decimalAmount > 0 then decimalAmount else intBonus\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)).Contents;
        money.ShouldContain("?.let { java.math.BigDecimal.valueOf(it) }");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: the <c>needsWiden</c> widen must apply against an OPTIONAL <c>Decimal?</c> sibling too
    /// (not just a non-optional one) — a non-optional <c>Int</c> branch against a <c>Decimal?</c> sibling
    /// must still widen to <c>java.math.BigDecimal.valueOf(...)</c>; no further wrap is needed on either
    /// arm since Kotlin's <c>if</c>-expression LUB already widens a bare <c>BigDecimal</c> next to a
    /// <c>BigDecimal?</c> sibling to <c>BigDecimal?</c>. Mirrors the Rust/Java <c>Cash</c> fixture's
    /// widen+wrap composition case (Kotlin, like TypeScript, never needs the wrap half — see
    /// <see cref="Conditional_branch_optionality_only_mismatch_emits_compiling_kotlin"/>).
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_against_optional_sibling_emits_compiling_kotlin()
    {
        const string src =
            "context Shop {\n" +
            "  value Cash {\n" +
            "    amount: Int\n" +
            "    bonusAmount: Decimal?\n" +
            "    total: Decimal? = if amount > 0 then amount else bonusAmount\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var cash = result.Files.Single(f => f.RelativePath.EndsWith("Cash.kt", StringComparison.Ordinal)).Contents;
        cash.ShouldContain("java.math.BigDecimal.valueOf(");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: a nested <c>ConditionalExpr</c> used as one branch of an outer conditional must itself
    /// reconcile its own two arms BEFORE the outer branch is emitted, so the inner <c>if</c>-expression's
    /// inferred (joined, #975) type lines up with the outer sibling's type. Here the inner <c>if</c> widens
    /// <c>amount</c> (<c>Int</c>) against <c>bonus</c> (<c>Decimal</c>) to <c>Decimal</c>, which then
    /// already matches the outer <c>else</c> branch <c>fallback: Decimal</c> with no further outer-level
    /// reconciliation needed.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_nested_conditional_emits_compiling_kotlin()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Decimal\n" +
            "    fallback: Decimal\n" +
            "    total: Decimal = if amount > 0 then (if amount > 10 then amount else bonus) else fallback\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.kt", StringComparison.Ordinal)).Contents;
        money.ShouldContain("java.math.BigDecimal.valueOf(");

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
