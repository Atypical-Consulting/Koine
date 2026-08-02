using Koine.Compiler.Diagnostics;
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

    /// <summary>
    /// A regression fixture for the ordinary-model javac-17 bugs the billing/pizzeria templates don't hit,
    /// each of which produced INVALID or semantically-WRONG Java before the fix:
    /// <list type="bullet">
    ///   <item>plain Decimal <c>/</c> lowered to a bare <c>BigDecimal.divide(x)</c> — a runtime
    ///   <c>ArithmeticException</c> on a non-terminating quotient; now carries
    ///   <c>MathContext.DECIMAL128</c>;</item>
    ///   <item>a negated Decimal literal emitted the ill-typed <c>-new BigDecimal("…")</c> (no unary
    ///   <c>-</c> on <c>BigDecimal</c>) — as an invariant bound, an enum associated value, and an entity
    ///   member default; now folds the sign into the literal string;</item>
    ///   <item>a domain member named <c>count</c> read via member access emitted <c>.size()</c>, a method
    ///   the record lacks; now reads its accessor;</item>
    ///   <item>a Decimal comparison against an int literal above <c>Integer.MAX_VALUE</c> emitted
    ///   <c>valueOf(5000000000)</c> — "integer number too large"; now suffixes <c>L</c>;</item>
    ///   <item>record components named after the record-illegal <c>Object</c> methods (<c>notify</c>,
    ///   <c>wait</c>, <c>hashCode</c>, <c>toString</c>, …) were emitted verbatim — "illegal record
    ///   component name"; now escaped;</item>
    ///   <item>equality on two optional primitives used a raw reference <c>==</c> on two <c>Optional</c>s
    ///   (wrong); now routes through <c>Objects.equals</c>.</item>
    /// </list>
    /// </summary>
    private const string RegressionFixture = """
        context Regression {
          /// Decimal division (MathContext) and a Decimal comparison against a large int literal.
          value Ratio {
            numerator:   Decimal
            denominator: Decimal
            quotient:    Decimal = numerator / denominator
            invariant numerator <= 5000000000 "numerator cap exceeded"
          }

          /// A negated Decimal literal as an invariant bound.
          value Temperature {
            celsius: Decimal
            invariant celsius >= -273.15 "below absolute zero"
          }

          /// A negated Decimal literal as an enum associated value.
          enum Adjustment(delta: Decimal) {
            REFUND(-5.00)
            FEE(5.00)
          }

          /// A domain member named `count` read via member access must resolve to its accessor, not `.size()`.
          value Segment {
            count: Int
            invariant count >= 0 "a segment count cannot be negative"
          }

          value SegmentPair {
            first:  Segment
            second: Segment
            total:  Int = first.count + second.count
          }

          /// Record components named after the record-illegal Object methods must be escaped.
          value Reserved {
            notify:   Bool
            wait:     Int
            hashCode: Int
            toString: String
          }

          /// Equality on two optional primitives must route through Objects.equals, not a raw ==.
          value OptionalMatch {
            left:    Int?
            right:   Int?
            matched: Bool = left == right
          }

          /// A negated Decimal literal as an entity member default.
          entity Account identified by AccountId {
            balance:     Decimal
            creditLimit: Decimal = -100.00
          }
        }
        """;

    /// <summary>
    /// The regression coverage for the ordinary-model javac-17 bugs (Decimal division, negated Decimal
    /// literals, a domain member named <c>count</c>, a large int literal in a Decimal comparison, a
    /// <c>notify</c>/<c>wait</c> record component, and an optional-primitive equality): all must emit Java
    /// that <c>javac --release 17</c> accepts (skipped if no JDK 17+). Before the fixes each was a hard
    /// <c>javac</c> error (or, for Decimal division, a latent runtime throw).
    /// </summary>
    [Fact]
    public void Harness_accepts_ordinary_model_javac_17_regressions()
    {
        var result = new KoineCompiler().Compile(RegressionFixture, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The fixed shapes, asserted directly (independent of whether a JDK is present).
        var ratio = result.Files.Single(f => f.RelativePath.EndsWith("Ratio.java", StringComparison.Ordinal)).Contents;
        ratio.ShouldContain(".divide(this.denominator(), java.math.MathContext.DECIMAL128)"); // Decimal `/`
        ratio.ShouldContain("java.math.BigDecimal.valueOf(5000000000L)");                     // large int literal

        var temperature = result.Files.Single(f => f.RelativePath.EndsWith("Temperature.java", StringComparison.Ordinal)).Contents;
        temperature.ShouldContain("new java.math.BigDecimal(\"-273.15\")");                    // negated literal (invariant)

        var adjustment = result.Files.Single(f => f.RelativePath.EndsWith("Adjustment.java", StringComparison.Ordinal)).Contents;
        adjustment.ShouldContain("REFUND(new java.math.BigDecimal(\"-5.00\"))");               // negated literal (enum)

        var account = result.Files.Single(f => f.RelativePath.EndsWith("Account.java", StringComparison.Ordinal)).Contents;
        account.ShouldContain("this.creditLimit = new java.math.BigDecimal(\"-100.00\")");     // negated literal (entity default)

        var pair = result.Files.Single(f => f.RelativePath.EndsWith("SegmentPair.java", StringComparison.Ordinal)).Contents;
        pair.ShouldContain("this.first().count() + this.second().count()");                    // member-op shadowed by a real field

        var reserved = result.Files.Single(f => f.RelativePath.EndsWith("Reserved.java", StringComparison.Ordinal)).Contents;
        reserved.ShouldContain("boolean notify_, long wait_, long hashCode_, String toString_"); // record-illegal names escaped

        var optionalMatch = result.Files.Single(f => f.RelativePath.EndsWith("OptionalMatch.java", StringComparison.Ordinal)).Contents;
        optionalMatch.ShouldContain("java.util.Objects.equals(this.left(), this.right())");    // optional == optional

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
    /// Issue #1289 cross-target audit: <c>JavaExpressionTranslator.TryWriteValueObjectArithmetic</c> lowers
    /// a value-object scalar <c>*</c>/<c>/</c> to <c>.times</c>/<c>.dividedBy</c> based on the operand's
    /// FULL inferred type (<c>_resolver.Infer</c>), so it already recognized a compound (conditional)
    /// operand as a value object — but the demand-generation walker (the shared
    /// <c>OperatorNeedsAnalyzer.ScalarOpWalker</c>, fixed by #1289's Task 1) only recognized a bare
    /// identifier/literal, so the <c>.times</c> method it called was never actually generated for a
    /// conditional operand — a compile-time "cannot find symbol" analogous to Rust's <c>cargo check</c>
    /// E0369. Fixed for free by the shared analyzer fix; this pins the regression on the Java side too.
    /// </summary>
    [Fact]
    public void Plain_value_object_scalar_multiply_with_conditional_operand_emits_compiling_java()
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): the demand-generated method the call site relies on.
        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("public Money times(long factor)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in numeric
    /// type (a non-optional <c>Int</c> branch against a <c>Decimal</c> sibling) must widen the <c>Int</c>
    /// branch to <c>BigDecimal.valueOf(...)</c> so both ternary arms share a type — Java's <c>?:</c>
    /// (unlike C#'s implicit numeric conversions) rejects a bare <c>long</c>/<c>BigDecimal</c> mismatch
    /// with "incompatible types". Before the fix this emitted an unreconciled
    /// <c>flag ? this.amount() : this.amountDecimal()</c> that does not compile.
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_emits_compiling_java()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    amountDecimal: Decimal\n" +
            "    total: Decimal = if amount > 0 then amount else amountDecimal\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("java.math.BigDecimal.valueOf(");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: a <c>ConditionalExpr</c> derived-member body whose branches disagree ONLY in
    /// optionality (a non-optional branch against an optional sibling of the SAME underlying type) must
    /// render both ternary arms in the same Java type — the non-optional branch <c>Optional.of(...)</c>-
    /// wrapped to match its optional sibling — or <c>javac</c> rejects the mismatch between a bare
    /// <c>long</c> and <c>Optional&lt;Long&gt;</c>.
    /// </summary>
    [Fact]
    public void Conditional_branch_optionality_mismatch_emits_compiling_java()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Int?\n" +
            "    total: Int? = if amount > 0 then amount else bonus\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("java.util.Optional.of(");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344 (the issue's exact repro): a <c>ConditionalExpr</c> derived-member body whose branches
    /// disagree in BOTH numeric type and optionality at once — a non-optional <c>Decimal</c> branch
    /// against an optional <c>Int</c> sibling — must <c>Optional.of(...)</c>-wrap the <c>Decimal</c> branch
    /// and <c>.map(java.math.BigDecimal::valueOf)</c> the optional <c>Int</c> branch so both ternary arms
    /// are <c>Optional&lt;BigDecimal&gt;</c>. Before the fix Java rendered a bare
    /// <c>cond ? this.decimalAmount() : this.intBonus()</c> — a <c>BigDecimal</c> against an
    /// <c>Optional&lt;Long&gt;</c> — which <c>javac</c> rejects outright.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_emits_compiling_java()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    decimalAmount: Decimal\n" +
            "    intBonus: Int?\n" +
            "    total: Decimal? = if decimalAmount > 0 then decimalAmount else intBonus\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("java.util.Optional.of(");
        money.ShouldContain(".map(java.math.BigDecimal::valueOf)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: the <c>needsWiden</c>/<c>needsSomeWrap</c> COMPOSITION — a non-optional <c>Int</c>
    /// branch against an optional <c>Decimal?</c> sibling must both widen AND wrap
    /// (<c>Optional.of(BigDecimal.valueOf(...))</c>, widen inside so the value is a <c>BigDecimal</c>
    /// before it becomes an <c>Optional&lt;BigDecimal&gt;</c>), distinct from either transformation alone.
    /// Mirrors the Rust <c>Cash</c> fixture in
    /// <c>RustConformanceTests.Conditional_branch_optionality_mismatch_emits_compiling_rust</c>.
    /// </summary>
    [Fact]
    public void Conditional_branch_numeric_widen_composes_with_optional_wrap_emits_compiling_java()
    {
        const string src =
            "context Shop {\n" +
            "  value Cash {\n" +
            "    amount: Int\n" +
            "    bonusAmount: Decimal?\n" +
            "    total: Decimal? = if amount > 0 then amount else bonusAmount\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var cash = result.Files.Single(f => f.RelativePath.EndsWith("Cash.java", StringComparison.Ordinal)).Contents;
        cash.ShouldContain("java.util.Optional.of(java.math.BigDecimal.valueOf(");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1344: a nested <c>ConditionalExpr</c> used as one branch of an outer conditional must itself
    /// reconcile its own two arms BEFORE the outer branch is emitted, so the inner ternary's inferred
    /// (joined, #975) type lines up with the outer sibling's type. Here the inner <c>if</c> widens
    /// <c>amount</c> (<c>Int</c>) against <c>bonus</c> (<c>Decimal</c>) to <c>Decimal</c>, which then
    /// already matches the outer <c>else</c> branch <c>fallback: Decimal</c> with no further outer-level
    /// wrapping needed.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_nested_conditional_emits_compiling_java()
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("java.math.BigDecimal.valueOf(");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1479 — <c>BuildFactoryCtorArgs</c>'s <c>required</c> loop's explicit-init branch never
    /// <c>Optional.of(...)</c>-wraps a value for a member whose declared type is optional but has no
    /// member-level default (e.g. <c>total: Decimal?</c>), even though that identical member shape is
    /// already handled correctly by this same loop's <c>unset</c> branch three lines below
    /// (<c>m.Type.IsOptional</c> → <c>"java.util.Optional.empty()"</c>). The constructor signature
    /// correctly declares the parameter <c>Optional&lt;BigDecimal&gt;</c> (an optional-declared,
    /// default-less member still needs <c>Optional&lt;T&gt;</c> since it can be legitimately unset), but
    /// the explicit-init branch passed the bare, un-wrapped value — a real <c>javac</c> "incompatible
    /// types" error. Mirrors the Rust fix for the identical bug shape (#1452/PR #1464).
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_member_is_optional_of_wrapped()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5.0\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): the optional-declared required member's explicit init must
        // be Optional.of(...)-wrapped to match the constructor's Optional<BigDecimal> parameter, not
        // passed through as the bare, un-wrapped value.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("new Product(id, java.util.Optional.of(new java.math.BigDecimal(\"5.0\")))");
        product.ShouldNotContain("new Product(id, new java.math.BigDecimal(\"5.0\"))");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Code-review follow-up shape to #1479 itself (mirroring the Rust precedent, #1452's own follow-up):
    /// the validator legally allows a <c>required</c>-bucket optional-declared member to be explicitly
    /// initialized from an already-<c>Optional</c>-typed source expression (e.g. a same-shaped
    /// <c>T?</c> factory parameter, <c>total -&gt; rate</c>). A naive
    /// <c>m.Type.IsOptional ? Optional.of(value) : value</c> wrap would unconditionally wrap that value,
    /// producing <c>Optional.of(rate)</c> against the constructor's <c>Optional&lt;BigDecimal&gt;</c>
    /// parameter where <c>rate</c> is itself <c>Optional&lt;BigDecimal&gt;</c> — a real <c>javac</c>
    /// "incompatible types" error (<c>Optional&lt;Optional&lt;BigDecimal&gt;&gt;</c>).
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_required_member_from_an_already_optional_source_does_not_double_wrap()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(rate: Decimal?) {\n" +
            "      total -> rate\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): an already-Optional-typed source value must be passed
        // through as-is, never re-wrapped in another Optional.of(...).
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldNotContain("Optional.of(rate");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1480 — <c>BuildFactoryCtorArgs</c>'s <c>required</c> loop's auto-bound branch never
    /// <c>Optional.of(...)</c>-wraps a same-named factory parameter for a member whose declared type is
    /// optional but has no member-level default (e.g. <c>total: Decimal?</c>), when the auto-bound
    /// parameter itself is declared non-optional (e.g. <c>total: Decimal</c>). The constructor signature
    /// correctly declares the parameter <c>Optional&lt;BigDecimal&gt;</c>, but the auto-bound branch
    /// passed the bare, un-wrapped field — a real <c>javac</c> "incompatible types" error. Mirrors the
    /// Rust fix for the identical bug shape (#1467/PR #1476) and this issue's own companion explicit-init
    /// fix (#1479/PR #1518).
    /// </summary>
    [Fact]
    public void Factory_autobound_parameter_binding_to_an_optional_declared_required_member_is_optional_of_wrapped()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(total: Decimal) {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): the auto-bound non-optional parameter must be
        // Optional.of(...)-wrapped to match the constructor's Optional<BigDecimal> parameter, not passed
        // through as the bare, un-wrapped field.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("new Product(id, java.util.Optional.of(total))");
        product.ShouldNotContain("new Product(id, total)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Same-optionality regression guard: an auto-bound parameter that is itself declared optional (e.g.
    /// <c>create make(total: Decimal?)</c>) binding to an optional-declared required member of the same
    /// shape must be passed through unwrapped — it is already <c>Optional&lt;BigDecimal&gt;</c>-typed, so
    /// wrapping it again would double-wrap into <c>Optional&lt;Optional&lt;BigDecimal&gt;&gt;</c>, a real
    /// <c>javac</c> "incompatible types" error.
    /// </summary>
    [Fact]
    public void Factory_autobound_optional_parameter_binding_to_an_optional_declared_required_member_does_not_double_wrap()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(total: Decimal?) {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): an already-Optional-typed auto-bound parameter must be
        // passed through as-is, never re-wrapped in another Optional.of(...).
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("new Product(id, total)");
        product.ShouldNotContain("Optional.of(total)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1519 — <c>BuildFactoryCtorArgs</c>'s <c>required</c> loop's explicit-init branch never
    /// numerically coerced the translated value against the member's declared type — unlike the Rust
    /// emitter's own <c>BuildFactoryCtorArgs</c>, which applies <c>CoerceNumericBody</c> before passing
    /// the value on (#1491). A factory that explicitly initializes a <c>Decimal</c> member from an
    /// <c>Int</c> literal emitted a bare Java <c>long</c> where a <c>BigDecimal</c> is required — a real
    /// <c>javac</c> "incompatible types" error.
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): the Int-typed initializer must be widened to BigDecimal to
        // match the constructor's BigDecimal parameter, not passed through as a bare `long` literal.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("new Product(id, java.math.BigDecimal.valueOf(5L))");
        product.ShouldNotContain("new Product(id, 5L)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1519 composed with #1479: an <c>Int</c> literal explicit-initializing an optional-declared
    /// <c>Decimal?</c> member must be widened to <c>BigDecimal</c> BEFORE the <c>Optional.of(...)</c> wrap
    /// — mirroring the Rust emitter's <c>CoerceNumericBody</c>-then-<c>Some(...)</c> ordering — so the
    /// coercion composes correctly rather than emitting <c>Optional.of(5L)</c> against an
    /// <c>Optional&lt;BigDecimal&gt;</c> parameter.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_decimal_member_from_an_int_literal_widens_inside_the_optional_wrap()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): widen inside, wrap outside.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("new Product(id, java.util.Optional.of(java.math.BigDecimal.valueOf(5L)))");
        product.ShouldNotContain("Optional.of(5L)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Zero-change regression guard: a <c>Decimal</c>-typed value explicit-initializing a
    /// <c>Decimal</c>-declared member must be unaffected by #1519's coercion — no extra
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("new Product(id, new java.math.BigDecimal(\"5.0\"))");
        product.ShouldNotContain("BigDecimal.valueOf(new java.math.BigDecimal");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Code-review follow-up to #1519 itself: an ALREADY-<c>Optional</c>-typed initializing expression
    /// (e.g. an <c>Int?</c> factory parameter) that is ALSO numerically mismatched against an
    /// optional-declared <c>Decimal?</c> member needs a <c>.map(...)</c>-based coercion — a bare
    /// <c>BigDecimal.valueOf(...)</c> wrap around an <c>Optional&lt;Long&gt;</c> value does not compile.
    /// This is the exact edge case the issue's own spec flagged (mirroring the Rust translator's
    /// <c>OptionBodyNumericCoercionMap</c>) and the initial fix missed; caught by code review before ready.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_decimal_member_from_an_already_optional_int_source_is_map_coerced()
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): the already-Optional<Long> value must be mapped to
        // Optional<BigDecimal> via .map(...), never bare-wrapped (which would double-wrap into
        // Optional<Optional<...>>) nor left as Optional<Long> (a real javac "incompatible types" error).
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("new Product(id, discount.map(java.math.BigDecimal::valueOf))");
        product.ShouldNotContain("new Product(id, discount)");
        product.ShouldNotContain("Optional.of(discount");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1520: a coalesce (<c>??</c>) whose right operand is ITSELF <c>Optional</c>-typed (here, another
    /// <c>Decimal?</c> factory parameter) must lower to <c>Optional&lt;T&gt;.or(() -&gt; ...)</c>, which
    /// keeps the result <c>Optional</c>-shaped — not the bare-value <c>Optional&lt;T&gt;.orElse(T)</c>,
    /// which requires a non-<c>Optional</c> argument and is a real <c>javac</c> "incompatible types"
    /// error when handed an <c>Optional&lt;T&gt;</c>. Matches <see cref="TypeResolver.VisitCoalesce"/>'s
    /// own <c>right.IsOptional</c> propagation, which already allows this shape.
    /// </summary>
    [Fact]
    public void Coalesce_with_an_optional_typed_fallback_operand_stays_optional_shaped()
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): pins the exact defect — an Optional-typed fallback must
        // route through `.or(() -> ...)`, never the bare-value `.orElse(...)`.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a.or(() -> b)");
        product.ShouldNotContain("a.orElse(b)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Zero-change regression guard: a coalesce whose right operand is NOT optional-typed (the common,
    /// already-correct case) must keep emitting the bare-value <c>.orElse(...)</c>, unaffected by #1520's
    /// fix.
    /// </summary>
    [Fact]
    public void Coalesce_with_a_non_optional_fallback_operand_still_unwraps_via_orElse()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "\n" +
            "    create make(a: Decimal?, b: Decimal) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a.orElse(b)");
        product.ShouldNotContain("a.or(() -> b)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1548: a coalesce whose two operands are BOTH <c>Optional</c>-typed but of DIFFERENT numeric types
    /// (<c>Int?</c> vs <c>Decimal?</c>) must reconcile that mismatch before emitting <c>.or(() -&gt; ...)</c>
    /// — #1520's fix alone picks the right method (<c>.or</c> vs <c>.orElse</c>) but leaves the two
    /// operands' element types unreconciled, which is a real <c>javac</c> "incompatible types" error:
    /// <c>Optional&lt;Long&gt;.or(Supplier&lt;? extends Optional&lt;? extends Long&gt;&gt;)</c> cannot accept
    /// a lambda returning <c>Optional&lt;BigDecimal&gt;</c>. The narrower <c>Int?</c> receiver must widen via
    /// <c>.map(BigDecimal::valueOf)</c> before <c>.or(...)</c> is called on it.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_between_optional_operands()
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no JDK required): the narrower Int? receiver is widened inside its own Optional
        // before `.or(...)` is called, so both sides agree on Optional<BigDecimal>.
        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a.map(java.math.BigDecimal::valueOf).or(() -> b)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1548's symmetric operand order: the LEFT operand (the <c>.or(...)</c> receiver) is already the
    /// wider <c>Decimal?</c>, so it needs no widening — instead the narrower <c>Int?</c> right operand must
    /// widen INSIDE its own <c>Optional</c> (<c>.map(BigDecimal::valueOf)</c>) before it's returned from the
    /// <c>.or(() -&gt; ...)</c> lambda, since the receiver's <c>Optional&lt;BigDecimal&gt;</c> constrains the
    /// lambda's required return type.
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a.or(() -> b.map(java.math.BigDecimal::valueOf))");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1548: the same numeric-type-mismatch reconciliation must also apply on the bare-value
    /// <c>.orElse(...)</c> path (right operand NOT optional-typed), widening the narrower side with a plain
    /// (non-<c>Optional</c>) <c>BigDecimal.valueOf(...)</c>/<c>.map(...)</c> as appropriate.
    /// </summary>
    [Fact]
    public void Coalesce_reconciles_a_numeric_type_mismatch_on_the_orElse_path()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "\n" +
            "    create make(a: Int?, b: Decimal) {\n" +
            "      total -> a ?? b\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a.map(java.math.BigDecimal::valueOf).orElse(b)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1548 (Task 2): the same numeric-type-mismatch reconciliation must also hold through a
    /// <c>field -&gt; a ?? b</c> STATE TRANSITION (a mutating behavior), not just a factory ctor arg —
    /// <c>WriteTransition</c> applies no numeric reconciliation of its own (only an <c>Optional.of(...)</c>
    /// wrap for a bare value into an optional field), so this exercises that the fix living inside the
    /// shared <c>CoalesceExpr</c> case covers this call site for free.
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("a.map(java.math.BigDecimal::valueOf).or(() -> b)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// #1548 (Task 2): the same numeric-type-mismatch reconciliation must also hold through a DERIVED
    /// (computed) member body — <c>WriteDerivedMethod</c> applies no reconciliation at all (it just returns
    /// the translated body verbatim), so this exercises that the fix living inside the shared
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var product = result.Files.Single(f => f.RelativePath.EndsWith("Product.java", StringComparison.Ordinal)).Contents;
        product.ShouldContain("this.a.map(java.math.BigDecimal::valueOf).or(() -> this.b)");

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

    /// <summary>
    /// Issue #1536 — a nested same-name <c>let</c> shadowing a same-named MEMBER must emit Java that a
    /// real <c>javac</c> accepts: before the fix, both bindings spelled themselves <c>var n</c>, a hard
    /// redeclaration error (JLS §6.4); the inner binding now alpha-renames to <c>n$1</c>. Closes the
    /// verification gap #1497's own regression test could not close (it had no compiling shape to check).
    /// </summary>
    [Fact]
    public void Harness_accepts_a_nested_same_name_let_shadowing_a_member()
    {
        const string src =
            """
            context Shop {
              value Money {
                n:    String
                base: Int
                calc: Int = base + (let n = 10 in (let n = 20 in n) + n)
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("var n$1 = 20L;");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1621 (the Java analogue of #1560/PR #1612's Rust fix): <c>ModelIndex.Classify</c> is
    /// context-blind — its flat, last-write-wins <c>_byName</c> index can resolve a same-named enum
    /// declared in a DIFFERENT context (R13.2 legally permits this), so a qualified enum default value
    /// (<c>status: Status = Status.Open</c>, exercising <c>JavaExpressionTranslator.WriteMemberAccess</c>'s
    /// qualified-enum-member fast path) risks misclassifying its qualifier depending on registration order
    /// relative to a same-named enum in another context.
    /// <para>
    /// <b>Ordering note:</b> <c>Shipping</c> is declared BEFORE <c>Billing</c> deliberately. Issue #1621's
    /// own literal minimal model (Billing first) does not currently validate at all: a separate,
    /// pre-existing bug (filed as a follow-up — see the PR description) makes <c>ModelIndex.AllTypes()</c>
    /// enumerate only the flat <c>_byName</c> winner for a shared simple name, so the LOSING context's own
    /// enum members are never indexed into <c>EnumsDeclaring</c>/<c>_enumMemberToType</c> at all — the
    /// losing context's own qualified member reference then fails semantic validation
    /// (<c>KOI0106 unknown enum member</c>) before any emitter runs, for BOTH the C# and Java targets
    /// alike. Declaring <c>Billing</c> second makes it the flat winner, so its own enum members ARE
    /// indexed and the model validates — letting this test reach and pin the Java-emitter-specific
    /// call site instead.
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("billing/Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("this.status = Status.Open;");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1635 (the value-object analogue of #1621's own entity-based test/fix): a <c>value</c>
    /// object's stored member with a default <c>Initializer</c> must have that default applied, mirroring
    /// how <c>WriteEntityConstructor</c> already applies one for entities. Before the fix,
    /// <c>EmitValueObject</c> only ever routed a member's <c>Initializer</c> through a <c>derived</c>
    /// member's accessor (<c>WriteDerivedAccessor</c>) — a defaulted STORED member became a bare,
    /// always-required record component with the declared default silently dropped.
    /// </summary>
    [Fact]
    public void Value_object_applies_a_stored_member_default_initializer()
    {
        const string src =
            """
            context Billing {
              enum Status {
                Open
                Closed
              }
              value Invoice {
                status: Status = Status.Open
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("public record Invoice(Status status) {"); // canonical constructor unchanged
        invoice.ShouldContain("public Invoice() {");                     // secondary, no-arg (every member defaulted)
        invoice.ShouldContain("this(Status.Open);");                     // delegates, applying the default

        var r2 = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r2.ToolchainAvailable, NoToolchainNotice);

        r2.Ok.ShouldBeTrue(string.Join("\n", r2.Errors));
    }

    /// <summary>
    /// A defaulted stored member is NOT required to be a trailing/independent subset: this pins a
    /// value object whose FIRST stored member is defaulted and whose SECOND is required (interleaved,
    /// the shape the issue's own spec flagged as a possible limitation). The secondary constructor's
    /// delegating <c>this(...)</c> call must still fill each argument by its position in the record's
    /// declared component order — the defaulted member's initializer first, then the required
    /// parameter — never mis-ordered.
    /// </summary>
    [Fact]
    public void Value_object_applies_an_interleaved_stored_member_default_initializer()
    {
        const string src =
            """
            context Billing {
              value Discount {
                percent: Int = 10
                reason:  String
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var discount = result.Files.Single(f => f.RelativePath.EndsWith("Discount.java", StringComparison.Ordinal)).Contents;
        discount.ShouldContain("public record Discount(long percent, String reason) {"); // canonical constructor unchanged
        discount.ShouldContain("public Discount(String reason) {");                      // secondary, over just the required member
        discount.ShouldContain("this(10L, reason);");                                    // default first, required second — matches declaration order

        var r2 = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r2.ToolchainAvailable, NoToolchainNotice);

        r2.Ok.ShouldBeTrue(string.Join("\n", r2.Errors));
    }

    /// <summary>
    /// Every shipped template must emit Java that actually <b>compiles</b>, not merely Java the
    /// compiler was willing to write out. Issue #1763: <c>templates/saas-subscription</c>
    /// (<c>UsageMeter.overage</c>) and <c>templates/library</c> (<c>FinePolicy.fineCents</c>) both
    /// shipped emitted Java containing an invariant over a derived member — a dangling
    /// <c>cannot find symbol</c> — because <see cref="TemplatesValidationTests.Template_compiles_green_in_directory_mode"/>
    /// only proves the MODEL is valid and the Java snapshot suites only proved the emitted text was
    /// STABLE; nothing ran it through <c>javac</c>. Mirrors the C# counterpart added by #1756/PR #1760
    /// (<c>Template_emits_csharp_that_compiles</c>), over every template rather than just the two known
    /// to be affected, so a future template hitting the same or a different Java-only gap is caught here
    /// too.
    /// <para>
    /// <c>saas-subscription</c> and <c>library</c> were skipped here pending issue #1771: fixing #1763's
    /// derived-member bug uncovered that both templates ALSO hit a separate, pre-existing Java-only
    /// defect — a shared enum member (e.g. <c>Active</c>, declared by two
    /// different contexts' enums) resolved against the wrong one — unrelated to #1763's scope
    /// (<c>NameMode.Parameter</c> derived-body substitution). #1771 ported
    /// <c>CSharpExpressionTranslator</c>'s sibling-operand <c>enumHint</c> mechanism into
    /// <c>JavaExpressionTranslator</c>, so both templates now compile and run through this theory like
    /// every other template.
    /// </para>
    /// </summary>
    [Theory]
    [MemberData(nameof(TemplatesValidationTests.TemplateFolders), MemberType = typeof(TemplatesValidationTests))]
    public void Template_emits_java_that_compiles(string folder)
    {
        string name = Path.GetFileName(folder);

        var sources = Directory
            .EnumerateFiles(folder, "*.koi", SearchOption.AllDirectories)
            .OrderBy(p => p, StringComparer.Ordinal)
            .Select(p => new SourceFile(p, File.ReadAllText(p)))
            .ToList();

        var result = new KoineCompiler().Compile(sources, new JavaEmitter());
        var errors = result.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        errors.ShouldBeEmpty(
            $"template '{name}' did not compile cleanly for the java target:\n" +
            string.Join("\n", errors.Select(d => $"{d.File}:{d.Line}:{d.Column}: {d.Code}: {d.Message}")));

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);
        r.Ok.ShouldBeTrue($"template '{name}' emitted Java that does not compile:\n" + string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1838, the Java half. The <c>__result</c> hoist introduces a TYPED local declaration, which
    /// is the one construct in the port that a textual parity assertion cannot vouch for — a declaration
    /// can read perfectly and still be rejected by <c>javac</c>. This runs the three hoisting shapes
    /// through the real compiler: an <c>emit</c>-shared result, an <c>emit</c>+<c>publish</c>-shared one
    /// (ONE local serving both payloads and the return), and a sibling argument that merely shares the
    /// result's prefix and must survive untouched.
    /// <para>The <c>javac</c> run is the real assertion; the shape pins above it only say what it is
    /// checking. Their absence is what let the Kotlin regression in this issue's review ship — the two
    /// typed-declaration targets were the only ones with no compile coverage of the hoist at all.</para>
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
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guards (no javac required): one binding per command, read by both payloads and the
        // return, with the prefix-sharing sibling left verbatim.
        var order = result.Files
            .Single(f => f.RelativePath.EndsWith("sales/Order.java", StringComparison.Ordinal)).Contents;
        order.ShouldContain("java.time.Instant __result = java.time.Instant.now();");
        order.ShouldContain("this.domainEvents.add(new Stamped(__result));");
        order.ShouldContain("this.integrationEvents.add(new Settled(__result));");
        order.ShouldContain("long __result = this.tax;");
        order.ShouldContain("new Quoted(__result, this.taxRate)");
        order.ShouldNotContain("__resultRate");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1838 code review: the hoisted local must be declared with the RESULT EXPRESSION's own type,
    /// never the command's declared return type. <c>command maybeStamp: Instant?</c> emitting a
    /// NON-optional <c>Stamped.at</c> is the shape that separates them — the expression is a bare
    /// <c>Instant</c> while the method returns <c>Optional&lt;Instant&gt;</c> — and declaring the local
    /// <c>Optional&lt;Instant&gt;</c> broke BOTH its own initializer and the payload constructor, two
    /// <c>javac</c> errors the hoist itself introduced.
    /// <para>Asserted textually rather than through <c>javac</c> because this fixture does NOT compile on
    /// either side of the fix: the Java emitter has a separate, PRE-EXISTING gap — it never bridges a
    /// bare value into an <c>Optional</c>-typed return or payload field (already true before any hoist
    /// existed) — which is out of scope here and tracked on its own. What this test pins is that the
    /// hoist adds no error of its own on top of it.</para>
    /// </summary>
    [Fact]
    public void Result_hoist_declares_the_expressions_own_type_not_the_declared_return_type()
    {
        const string src =
            "context Sales {\n" +
            "  aggregate Ordering root Order {\n" +
            "    event Stamped { at: Instant }\n" +
            "    entity Order identified by OrderId {\n" +
            "      command maybeStamp: Instant? {\n" +
            "        emit Stamped(at: now)\n" +
            "        result now\n" +
            "      }\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var order = result.Files
            .Single(f => f.RelativePath.EndsWith("sales/Order.java", StringComparison.Ordinal)).Contents;
        order.ShouldContain("java.time.Instant __result = java.time.Instant.now();");
        order.ShouldNotContain("java.util.Optional<java.time.Instant> __result");
        order.ShouldContain("new Stamped(__result)");
    }

    /// <summary>
    /// Issue #1866 — the #1511 fix (Rust) never ported to Java: a command's <c>result</c> expression never
    /// numerically reconciled against the command's declared return type, unlike the identical decision
    /// already applied at factory ctor args (#1519) and coalesce operands (#1548). An <c>Int</c>-typed
    /// member returned against a <c>: Decimal</c> return type emitted a bare <c>long return</c> where a
    /// <c>BigDecimal</c> is required — a real <c>javac</c> "incompatible types" error.
    /// </summary>
    [Fact]
    public void Result_expression_widens_an_int_member_to_bigdecimal_against_a_decimal_return_type()
    {
        const string src =
            "context Billing {\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    tax: Int\n" +
            "    command chargeC: Decimal {\n" +
            "      result tax\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("public java.math.BigDecimal chargeC() {\n        return java.math.BigDecimal.valueOf(this.tax);\n    }");
        invoice.ShouldNotContain("return java.math.BigDecimal.valueOf(java.math.BigDecimal");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1880 — a member's OWN default initializer (<c>total: Decimal = 5</c>) never numerically
    /// reconciled against its declared type, the seventh call site of the family #1519/#1732 (factory
    /// ctor args), #1548 (coalesce) and #1866 (result/payload) closed one by one. Java renders it in the
    /// entity constructor body (<c>this.total = 5L;</c>) and in a value object's defaulting convenience
    /// constructor (<c>this(7L);</c>) — both a hard <c>javac</c> "incompatible types: long cannot be
    /// converted to BigDecimal". Routed through the same <c>ReconcileAgainstDeclared</c> helper #1866
    /// added. Rust closed the same site at #1319/#1324/#1325.
    /// </summary>
    [Fact]
    public void Member_default_initializer_widens_an_int_to_bigdecimal_against_its_declared_type()
    {
        const string src =
            "context Billing {\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    total: Decimal = 5\n" +
            "\n" +
            "    create make() {\n" +
            "    }\n" +
            "  }\n" +
            "\n" +
            "  value Money {\n" +
            "    amount: Decimal = 7\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("this.total = java.math.BigDecimal.valueOf(5L);");
        invoice.ShouldNotContain("this.total = 5L;");

        var money = result.Files.Single(f => f.RelativePath.EndsWith("Money.java", StringComparison.Ordinal)).Contents;
        money.ShouldContain("this(java.math.BigDecimal.valueOf(7L));");
        money.ShouldNotContain("this(7L);");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1880 — the optional-declared half. Java's optional is a real <c>java.util.Optional&lt;T&gt;</c>
    /// field, so the shared decision's <c>NeedsSomeWrap</c> dimension applies here too and composes with
    /// the widen exactly as <c>BranchReconciliation</c> documents (widen inside, lift outside). That also
    /// closes the non-numeric sibling of the same defect at this one call site — a <c>String? = "hi"</c>
    /// default previously emitted a bare <c>String</c> into an <c>Optional&lt;String&gt;</c> field.
    /// Mirrors #1325's optional-constant-default fix for Rust.
    /// </summary>
    [Fact]
    public void Optional_declared_member_default_initializer_widens_and_lifts_into_optional()
    {
        const string src =
            "context Billing {\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    total: Decimal? = 5\n" +
            "    note: String? = \"hi\"\n" +
            "\n" +
            "    create make() {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("this.total = java.util.Optional.of(java.math.BigDecimal.valueOf(5L));");
        invoice.ShouldContain("this.note = java.util.Optional.of(\"hi\");");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1880's zero-change guard — a matching-type (<c>Decimal</c>) default and a non-numeric
    /// (<c>String</c>/<c>Int</c>) default on a NON-optional member must render byte-identically to
    /// before the reconciliation was wired in. Every sibling fix in this family carries the same guard.
    /// </summary>
    [Fact]
    public void Matching_type_and_non_numeric_member_defaults_render_unchanged()
    {
        const string src =
            "context Billing {\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    exact: Decimal = 2.5\n" +
            "    label: String = \"x\"\n" +
            "    count: Int = 3\n" +
            "\n" +
            "    create make() {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("this.exact = new java.math.BigDecimal(\"2.5\");");
        invoice.ShouldContain("this.label = \"x\";");
        invoice.ShouldContain("this.count = 3L;");
        invoice.ShouldNotContain("java.math.BigDecimal.valueOf");
        invoice.ShouldNotContain("java.util.Optional.of");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>Issue #1866: the same widening applies to an <c>Int</c> literal <c>result</c> expression.</summary>
    [Fact]
    public void Result_expression_widens_an_int_literal_to_bigdecimal_against_a_decimal_return_type()
    {
        const string src =
            "context Billing {\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    tax: Int\n" +
            "    command chargeFlat: Decimal {\n" +
            "      result 5\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("return java.math.BigDecimal.valueOf(5L);");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1866: an <c>emit</c> payload argument never numerically reconciled against the event
    /// member's declared type either — the payload-argument dual of the <c>result</c> gap above, sharing
    /// <c>BuildEventExpression</c> with <c>publish</c>.
    /// </summary>
    [Fact]
    public void Emit_payload_argument_widens_an_int_member_to_bigdecimal_against_a_decimal_declared_field()
    {
        const string src =
            "context Billing {\n" +
            "  event Charged { amount: Decimal }\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    tax: Int\n" +
            "    command raiseCharge {\n" +
            "      emit Charged(amount: tax)\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("new Charged(java.math.BigDecimal.valueOf(this.tax))");
        invoice.ShouldNotContain("new Charged(this.tax)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1866: the <c>publish</c> half of the shared <c>BuildEventExpression</c> gets the same
    /// widening as <c>emit</c> above — a published integration event's <c>Decimal</c>-declared field fed an
    /// <c>Int</c>-typed argument emitted an uncoerced value too.
    /// </summary>
    [Fact]
    public void Publish_payload_argument_widens_an_int_member_to_bigdecimal_against_a_decimal_declared_field()
    {
        const string src =
            "context Billing {\n" +
            "  publishes ChargedOut\n" +
            "  integration event ChargedOut { amount: Decimal }\n" +
            "  aggregate Invoicing root Invoice {\n" +
            "    entity Invoice identified by InvoiceId {\n" +
            "      tax: Int\n" +
            "      command raiseCharge {\n" +
            "        publish ChargedOut(amount: tax)\n" +
            "      }\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("new ChargedOut(java.math.BigDecimal.valueOf(this.tax))");
        invoice.ShouldNotContain("new ChargedOut(this.tax)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1866, the <c>NeedsOptionalWiden</c> composition: an already-<c>Optional</c>-typed
    /// <c>Int?</c> member <c>result</c>-ed into an optional-declared <c>Decimal?</c> return must widen
    /// via <c>.map(BigDecimal::valueOf)</c>, never a bare <c>BigDecimal.valueOf(...)</c> wrap around an
    /// <c>Optional&lt;Long&gt;</c> — the #1335/#1343 bug class the ctor-arg reconciler already guards.
    /// </summary>
    [Fact]
    public void Result_expression_widens_an_optional_int_member_via_map_against_an_optional_decimal_return_type()
    {
        const string src =
            "context Billing {\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    maybeTax: Int?\n" +
            "    command chargeOpt: Decimal? {\n" +
            "      result maybeTax\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("return this.maybeTax.map(java.math.BigDecimal::valueOf);");
        invoice.ShouldNotContain("java.math.BigDecimal.valueOf(this.maybeTax)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1866, the <c>CoalesceExpr</c> double-widen guard (mirrors #1548/#1615 at the ctor-arg site):
    /// a coalesce already widened by <c>WriteCoalesce</c> must not be widened a SECOND time by this new
    /// result-expression reconciliation — a real <c>javac</c> "no suitable method found for
    /// valueOf(BigDecimal)" error.
    /// </summary>
    [Fact]
    public void Result_expression_over_a_coalesce_widens_exactly_once()
    {
        const string src =
            "context Billing {\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    maybeTax: Int?\n" +
            "    command chargeOrZero: Decimal {\n" +
            "      result maybeTax ?? 0\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldNotContain("BigDecimal.valueOf(java.math.BigDecimal");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1866 zero-change regression guard: a matching-type <c>Decimal</c> result and a non-numeric
    /// <c>String</c> payload argument must render byte-identical to before this fix — no reconciliation
    /// wrap where none is needed.
    /// </summary>
    [Fact]
    public void Result_and_payload_of_matching_or_non_numeric_types_are_unaffected()
    {
        const string src =
            "context Billing {\n" +
            "  event Noted { note: String }\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    total: Decimal\n" +
            "    memo:  String\n" +
            "    command grandTotal: Decimal {\n" +
            "      result total\n" +
            "    }\n" +
            "    command annotate {\n" +
            "      emit Noted(note: memo)\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("public java.math.BigDecimal grandTotal() {\n        return this.total;\n    }");
        invoice.ShouldContain("new Noted(this.memo)");
        invoice.ShouldNotContain("BigDecimal.valueOf(this.total)");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1866 code review: a widened <c>result</c> expression that is ALSO hoisted into the
    /// <c>#1838</c> <c>__result</c> local (because it's shared verbatim with an <c>emit</c> payload)
    /// must declare that local with the WIDENED type, not the value's raw pre-widen inferred type. The
    /// initial fix widened <c>resultExpr</c>'s RENDERING but left the hoist-binding type computation
    /// reading the unwidened <c>InferType(hoisted.Value)</c> — producing <c>long __result =
    /// java.math.BigDecimal.valueOf(this.tax);</c>, a real <c>javac</c> "incompatible types" error on
    /// the declaration, the payload argument, AND the return statement (three errors from one bug).
    /// Caught by code review before ready; this pins the fix.
    /// </summary>
    [Fact]
    public void Result_hoisted_into_a_widened_payload_declares_the_local_with_the_widened_type()
    {
        const string src =
            "context Billing {\n" +
            "  event Charged { amount: Decimal }\n" +
            "  entity Invoice identified by InvoiceId {\n" +
            "    tax: Int\n" +
            "    command chargeC: Decimal {\n" +
            "      emit Charged(amount: tax)\n" +
            "      result tax\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var invoice = result.Files.Single(f => f.RelativePath.EndsWith("Invoice.java", StringComparison.Ordinal)).Contents;
        invoice.ShouldContain("java.math.BigDecimal __result = java.math.BigDecimal.valueOf(this.tax);");
        invoice.ShouldNotContain("long __result");
        invoice.ShouldContain("new Charged(__result)");
        invoice.ShouldContain("return __result;");

        var r = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
