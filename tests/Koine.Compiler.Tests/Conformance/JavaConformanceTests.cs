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
