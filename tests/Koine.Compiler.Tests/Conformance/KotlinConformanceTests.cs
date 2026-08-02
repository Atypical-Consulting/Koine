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
    /// #1615: a coalesce (<c>??</c>) whose two operands are nullable but of DIFFERENT numeric types
    /// (<c>Int?</c> vs <c>Decimal?</c>) must reconcile that mismatch before emitting Kotlin's elvis
    /// <c>?:</c> — unreconciled, Kotlin infers the two arms' nearest common supertype (<c>Number? &amp;
    /// Comparable&lt;*&gt;?</c>, not <c>BigDecimal?</c>), a real <c>kotlinc</c> "initializer type mismatch"
    /// error. The narrower <c>Int?</c> left operand must null-safe-map-widen
    /// (<c>?.let { java.math.BigDecimal.valueOf(it) }</c>) before the elvis, mirroring #1548's Java
    /// <c>Optional.or</c>/<c>.orElse</c> fix but via Kotlin's own <c>?.let</c> idiom (elvis has no
    /// <c>Optional</c>-style receiver-fixed-generic constraint, so no <c>.or</c>-vs-<c>.orElse</c> split is
    /// needed).
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_between_nullable_operands()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Int?, b: Decimal?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no kotlinc required): the narrower Int? operand is null-safe-map-widened before
        // the elvis, so both sides agree on BigDecimal?.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a?.let { java.math.BigDecimal.valueOf(it) } ?: b");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1615's symmetric operand order: the LEFT operand is already the wider <c>Decimal?</c> (no widen
    /// needed), while the narrower <c>Int?</c> RIGHT operand must null-safe-map-widen before it's written
    /// after the elvis, since the elvis result must still agree in type with the reconciled left side.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_symmetric_operand_order()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Decimal?, b: Int?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a ?: b?.let { java.math.BigDecimal.valueOf(it) }");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Zero-change regression guard: a coalesce whose two operands are ALREADY the same nullable numeric
    /// type (the common, already-correct case) must keep emitting a bare elvis with no widening wrap,
    /// unaffected by #1615's reconciliation fix.
    /// </summary>
    [Fact]
    public void Coalesce_with_same_typed_nullable_operands_emits_unchanged()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Decimal?, b: Decimal?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a ?: b");
        product.ShouldNotContain("?.let {");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1615 (Task 2): the same numeric-type-mismatch reconciliation must also hold through a
    /// <c>field -&gt; a ?? b</c> STATE TRANSITION (a mutating behavior), not just a factory ctor arg —
    /// <c>WriteTransition</c> applies no numeric reconciliation of its own, so this exercises that the fix
    /// living inside the shared <c>CoalesceExpr</c> case covers this call site for free.
    /// </summary>
    [Fact]
    public void Coalesce_numeric_reconciliation_covers_state_transitions()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    command adjust(a: Int?, b: Decimal?) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a?.let { java.math.BigDecimal.valueOf(it) } ?: b");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1615 (Task 2): the same numeric-type-mismatch reconciliation must also hold through a DERIVED
    /// (computed) member body — <c>WriteEntityDerived</c> applies no reconciliation at all (it returns the
    /// translated body verbatim), so this exercises that the fix living inside the shared
    /// <c>CoalesceExpr</c> case covers this call site for free too.
    /// </summary>
    [Fact]
    public void Coalesce_numeric_reconciliation_covers_derived_members()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    a: Int?\n" +
            "    b: Decimal?\n" +
            "    total: Decimal? = a ?? b\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("this.a?.let { java.math.BigDecimal.valueOf(it) } ?: this.b");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1615 code-review finding: a coalesce's RIGHT operand is written via <c>Write</c> (no parens for a
    /// low-precedence compound), unlike the LEFT operand's <c>WriteAtom</c> — harmless while nothing follows
    /// it, but the numeric-widen suffix (<c>?.let { … }</c>) DOES follow it when the right side needs
    /// <c>NeedsOptionalWiden</c>. A nested coalesce right operand (itself <c>Int?</c>, mismatched against a
    /// <c>Decimal?</c> left) must therefore be parenthesized before the suffix attaches, or Kotlin's
    /// tighter-binding safe-call <c>?.</c> attaches the widen to only the INNERMOST operand
    /// (<c>a ?: x ?: y?.let { … }</c>, parsing as <c>a ?: (x ?: y?.let { … })</c>) instead of the whole
    /// nested coalesce (<c>a ?: (x ?: y)?.let { … }</c>) — reproducing the exact type mismatch this issue
    /// exists to fix.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_against_a_nested_coalesce_right_operand()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(a: Decimal?, x: Int?, y: Int?) {\n" +
            "      total -> a ?? (x ?? y)\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no kotlinc required): the nested coalesce must be parenthesized before the
        // widen suffix attaches to the whole thing, not just its innermost operand.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a ?: (x ?: y)?.let { java.math.BigDecimal.valueOf(it) }");

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

    /// <summary>
    /// Issue #1625 (the Kotlin analogue of #1560/PR #1612's Rust fix, and #1621's Java one):
    /// <c>ModelIndex.Classify</c> is context-blind — its flat, last-write-wins <c>_byName</c> index can resolve a
    /// same-named enum declared in a DIFFERENT context (R13.2 legally permits this), so a qualified enum default
    /// value (<c>status: Status = Status.Open</c>, exercising <c>KotlinExpressionTranslator.WriteMemberAccess</c>'s
    /// qualified-enum-member fast path) risks misclassifying its qualifier depending on registration order
    /// relative to a same-named enum in another context.
    /// <para>
    /// <b>Ordering note:</b> <c>Shipping</c> is declared BEFORE <c>Billing</c> deliberately, mirroring #1621's
    /// Java test — a separate, pre-existing bug (filed as a follow-up) makes <c>ModelIndex.AllTypes()</c>
    /// enumerate only the flat <c>_byName</c> winner for a shared simple name, so the LOSING context's own enum
    /// members are never indexed into <c>EnumsDeclaring</c>/<c>_enumMemberToType</c> at all — the losing
    /// context's own qualified member reference then fails semantic validation (<c>KOI0106 unknown enum
    /// member</c>) before any emitter runs. Declaring <c>Billing</c> second makes it the flat winner, so its own
    /// enum members ARE indexed and the model validates — letting this test reach and pin the
    /// Kotlin-emitter-specific call site instead.
    /// </para>
    /// </summary>
    [Fact]
    public void Same_named_enum_across_two_contexts_resolves_the_correct_context_for_a_qualified_default_value()
    {
        const string src =
            """
            context Shipping {
              enum Status {
                Pending
                Delivered
              }
            }

            context Billing {
              enum Status {
                Open
                Closed
              }
              aggregate Invoicing root Invoice {
                repository {
                  operations: getById, add
                }
                entity Invoice identified by InvoiceId {
                  status: Status = Status.Open
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("billing/Invoice.kt", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("Status.Open");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1531 (audit, Task 1) — the Rust (#1467/PR #1476) and Java (#1480/PR #1521) emitters both
    /// shipped the identical bug in <c>BuildFactoryCtorArgs</c>'s auto-bound branch: a
    /// <c>required</c>-bucket member declared optional but carrying no member-level default
    /// (<c>total: Decimal?</c>), auto-bound to a NON-optional same-named factory parameter
    /// (<c>create make(total: Decimal)</c>), had its bare field passed straight into a constructor slot
    /// typed <c>Option&lt;T&gt;</c>/<c>Optional&lt;T&gt;</c> — a real <c>rustc</c> E0308 / <c>javac</c>
    /// "incompatible types" error, fixed by wrapping in <c>Some(…)</c>/<c>Optional.of(…)</c>.
    /// <para>
    /// Kotlin's <c>BuildFactoryCtorArgs</c> has the textually identical loop shape and likewise passes
    /// the bare field — but Kotlin maps <c>T?</c> to a NULLABLE TYPE
    /// (<c>java.math.BigDecimal?</c>, <c>KotlinTypeMapper</c>), not to a wrapper value, and a non-null
    /// <c>T</c> is directly assignable to a <c>T?</c> slot. There is no wrap construct to apply and none
    /// is needed. This test records that negative audit result and locks it in: it asserts the
    /// nullable-type constructor slot AND the bare, unwrapped argument, then proves with a real
    /// <c>kotlinc</c> compile that the pair is valid Kotlin. Were the Kotlin backend ever to move to a
    /// wrapper-typed optional representation, this test fails and the Rust/Java wrap becomes required.
    /// </para>
    /// </summary>
    [Fact]
    public void Factory_autobound_parameter_binding_to_an_optional_declared_required_member_needs_no_wrap()
    {
        const string src =
            """
            context Shop {
              entity Product identified by ProductId {
                total: Decimal?

                create make(total: Decimal) {
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no kotlinc required): the optional-declared member's constructor slot is a
        // NULLABLE type, so the auto-bound non-optional parameter is passed through bare — no wrapper
        // value is constructed, and in particular no java.util.Optional leaks into Kotlin output.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("shop/Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("total: java.math.BigDecimal?,");
        product.ShouldContain("return Product(id, total)");
        product.ShouldNotContain("java.util.Optional");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(
            "an auto-bound non-optional parameter must be assignable straight into an optional-declared "
            + "member's nullable constructor slot:\n" + string.Join("\n", r.Errors));
    }

    /// <summary>
    /// The explicit-init half of the same #1531 audit — the branch Rust #1452/PR #1464 and Java
    /// #1479/PR #1518 fixed. A <c>total -&gt; 5.0</c> initialization of an optional-declared,
    /// default-less <c>required</c> member yields a non-optional value; Rust/Java must wrap it, Kotlin
    /// must not, for the same nullable-vs-wrapper reason. Since nothing is ever wrapped, the
    /// double-wrap hazard the Rust/Java fixes had to guard against cannot arise here at all.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_member_needs_no_wrap()
    {
        const string src =
            """
            context Shop {
              entity Product identified by ProductId {
                total: Decimal?

                create make() {
                  total -> 5.0
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("shop/Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("total: java.math.BigDecimal?,");
        product.ShouldContain("""return Product(id, java.math.BigDecimal("5.0"))""");
        product.ShouldNotContain("java.util.Optional");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(
            "an explicitly initialized non-optional value must be assignable straight into an "
            + "optional-declared member's nullable constructor slot:\n" + string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1731 (Task 4, the control). The TS/Python/PHP emitters (Tasks 1-3) each matched a
    /// same-named factory parameter to an entity member by NAME ONLY (<c>factoryParams.Contains(m.Name)</c>),
    /// not via the shared, target-agnostic <c>MemberAnalysis.AutoBinds</c> predicate — so an OPTIONAL
    /// parameter could wrongly auto-bind to a NON-optional member. Kotlin's own
    /// <c>BuildFactoryCtorArgs</c> (<see cref="KotlinEmitter"/>) already calls
    /// <c>factory.Parameters.Any(p =&gt; MemberAnalysis.AutoBinds(p, m))</c> and was never wrong.
    /// <para>
    /// <b>This is NOT a red-green regression test — it passes immediately, before and after Tasks
    /// 1-3.</b> It exists purely as a control: it pins Kotlin's already-correct fall-through so that
    /// a future regression in the shared <c>AutoBinds</c> predicate itself (rather than in one
    /// emitter's call site) gets caught here too, not just on the three emitters that needed fixing.
    /// </para>
    /// <para>
    /// The member (<c>total: Decimal</c>) is non-optional and default-less; the factory parameter
    /// (<c>total: Decimal?</c>) is optional. <c>AutoBinds</c> correctly refuses the match (an optional
    /// parameter must never auto-bind to a non-optional member), so <c>BuildFactoryCtorArgs</c> falls
    /// through past the auto-bind branch and the unset-optional branch to the benign type-default
    /// branch, emitting <c>java.math.BigDecimal.ZERO</c> for the member's constructor slot.
    /// </para>
    /// </summary>
    [Fact]
    public void Optional_parameter_does_not_auto_bind_a_non_optional_member()
    {
        const string src =
            """
            context Shop {
              entity Product identified by ProductId {
                total: Decimal

                create make(total: Decimal?) {
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no kotlinc required): the optional parameter must NOT auto-bind into the
        // non-optional member's constructor slot — the ctor arg must fall through to the benign
        // type default instead.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("shop/Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldNotContain("return Product(id, total)");
        product.ShouldContain("return Product(id, java.math.BigDecimal.ZERO)");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(
            "an optional factory parameter must not auto-bind into a non-optional member's "
            + "constructor slot:\n" + string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1732: the explicit-init branch of <c>BuildFactoryCtorArgs</c> never reconciled the
    /// value's inferred type against the member's declared type, so an <c>Int</c> literal initializing a
    /// <c>Decimal</c> member emitted a bare <c>Long</c> where <c>java.math.BigDecimal</c> is required — a
    /// real <c>kotlinc</c> "argument type mismatch" error. Mirrors Java's #1519 fix
    /// (<c>Factory_explicit_init_of_a_decimal_member_from_an_int_literal_is_bigdecimal_coerced</c>).
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_decimal_member_from_an_int_literal_is_bigdecimal_coerced()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no kotlinc required): the Int-typed initializer must be widened to BigDecimal
        // to match the constructor's BigDecimal parameter, not passed through as a bare Long literal.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("shop/Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("return Product(id, java.math.BigDecimal.valueOf(5L))");
        product.ShouldNotContain("return Product(id, 5L)");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Zero-change regression guard: a <c>Decimal</c>-typed value explicit-initializing a
    /// <c>Decimal</c>-declared member must be unaffected by #1732's coercion — no extra
    /// <c>BigDecimal.valueOf(...)</c> wrap added around an already-<c>BigDecimal</c> value.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_decimal_member_from_a_decimal_literal_is_unaffected()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5.0\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("shop/Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("""return Product(id, java.math.BigDecimal("5.0"))""");
        product.ShouldNotContain("BigDecimal.valueOf(java.math.BigDecimal");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1732: an ALREADY-nullable <c>Int?</c> initializing expression (a factory parameter) that is
    /// ALSO numerically mismatched against an optional-declared <c>Decimal?</c> member needs the
    /// null-safe-map widen (<c>?.let { java.math.BigDecimal.valueOf(it) }</c>) — a bare
    /// <c>java.math.BigDecimal.valueOf(...)</c> wrap around a <c>Long?</c> receiver does not compile.
    /// Mirrors Java's #1519 code-review follow-up
    /// (<c>Factory_explicit_init_of_an_optional_decimal_member_from_an_already_optional_int_source_is_map_coerced</c>).
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_decimal_member_from_an_already_optional_int_source_is_null_safe_map_coerced()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(discount: Int?) {\n" +
            "      total -> discount\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no kotlinc required): the already-nullable Long? value must be null-safe-map
        // widened, never bare-wrapped (a real kotlinc "type mismatch" against BigDecimal?).
        var product = result.Files.Single(f => f.RelativePath.EndsWith("shop/Product.kt", StringComparison.Ordinal)).Contents;
        product.ShouldContain("return Product(id, discount?.let { java.math.BigDecimal.valueOf(it) })");
        product.ShouldNotContain("return Product(id, discount)");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1838, the Kotlin half — and the regression its own code review caught. The <c>__result</c>
    /// hoist introduces a TYPED local declaration, the one construct in the port a textual parity
    /// assertion cannot vouch for: annotating it with the command's DECLARED RETURN type made
    /// <c>command maybeStamp: Instant?</c> emit <c>val __result: Instant? = …</c> and then hand it to a
    /// NON-optional <c>Stamped.at</c> — a real <c>kotlinc</c> "argument type mismatch: actual type is
    /// 'Instant?', but 'Instant' was expected" on a model that compiled clean before the hoist existed.
    /// The annotation is the EXPRESSION's own type instead, which both readers accept because Kotlin
    /// nullability is subtyping: a bare <c>Instant</c> flows into an <c>Instant?</c> payload field AND
    /// out of an <c>Instant?</c> return.
    /// <para><c>maybeStamp</c> below is that exact shape, kept in the compiled fixture so the regression
    /// cannot come back. The other two commands cover the rest of the contract: one local serving an
    /// <c>emit</c>, a <c>publish</c> AND the return, and a sibling argument that merely shares the
    /// result's prefix surviving untouched. The <c>kotlinc</c> run is the real assertion; the shape pins
    /// above it only say what it is checking.</para>
    /// </summary>
    [Fact]
    public void Result_hoisted_into_an_emit_and_a_publish_payload_compiles()
    {
        const string src =
            "context Sales {\n" +
            "  publishes Settled\n" +
            "  integration event Settled {\n" +
            "    at: Instant\n" +
            "  }\n" +
            "  aggregate Ordering root Order {\n" +
            "    event Stamped { at: Instant }\n" +
            "    event Quoted { amount: Int  rate: Int }\n" +
            "    entity Order identified by OrderId {\n" +
            "      tax:     Int = 0\n" +
            "      taxRate: Int = 0\n" +
            "      command maybeStamp: Instant? {\n" +
            "        emit Stamped(at: now)\n" +
            "        result now\n" +
            "      }\n" +
            "      command stamp: Instant {\n" +
            "        emit Stamped(at: now)\n" +
            "        publish Settled(at: now)\n" +
            "        result now\n" +
            "      }\n" +
            "      command quote: Int {\n" +
            "        emit Quoted(amount: tax, rate: taxRate)\n" +
            "        result tax\n" +
            "      }\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guards (no kotlinc required): the local carries the EXPRESSION's type, never the
        // optional declared return type, and one binding per command serves every reader.
        var order = result.Files
            .Single(f => f.RelativePath.EndsWith("sales/Order.kt", StringComparison.Ordinal)).Contents;
        order.ShouldContain("val __result: java.time.Instant = java.time.Instant.now()");
        order.ShouldNotContain("val __result: java.time.Instant? =");
        order.ShouldContain("this._domainEvents.add(Stamped(__result))");
        order.ShouldContain("this._integrationEvents.add(Settled(__result))");
        order.ShouldContain("val __result: Long = this.tax");
        order.ShouldContain("Quoted(__result, this.taxRate)");
        order.ShouldNotContain("__resultRate");

        var r = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
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
