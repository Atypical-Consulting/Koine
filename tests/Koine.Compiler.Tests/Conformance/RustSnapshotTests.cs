using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Snapshot + <c>cargo check</c> coverage for the Rust backend (issue #24), the Rust analogue of
/// <see cref="PythonSnapshotTests"/>. Each milestone fixture is snapshot-tested (the diff is the review
/// of the generated Rust) AND compiled with <see cref="TestSupport.CompileRust"/> when a usable Rust
/// toolchain is present — so a green build proves the emitted crate compiles. When the toolchain is
/// absent/offline the compile is funneled through <see cref="TestSupport.RequireOrSkip"/>, which reports
/// the test as <c>Skipped</c> (not a false Passed) — and a hard <c>Failed</c> in CI, where
/// <c>KOINE_REQUIRE_CONFORMANCE</c> is set and the toolchain installed.
/// </summary>
public class RustSnapshotTests
{
    private const string NoToolchainNotice =
        "No usable Rust toolchain (cargo, networked) available; cargo check not run.";

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
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

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
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// An entity with a defaulted enum field, an invariant, and mutating commands (preconditions +
    /// state transitions). Exercises the identity-equality entity shape and the command behaviors.
    /// </summary>
    private const string EntityFixture = """
        context Shop {
          enum Status { Active, Suspended }
          entity Account identified by AccountId {
            balance: Int
            status:  Status = Active
            invariant balance >= 0 "balance cannot go negative"
            command deposit(amount: Int) {
              requires status == Active "account must be active"
              requires amount > 0 "deposit must be positive"
              balance -> balance + amount
            }
            command withdraw(amount: Int) {
              requires status == Active "account must be active"
              balance -> balance - amount
            }
            command suspend {
              status -> Suspended
            }
          }
        }
        """;

    [Fact]
    public Task Rust_entities_emit_expected_rust()
    {
        var result = new KoineCompiler().Compile(EntityFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("pub fn deposit(&mut self, amount: i64) -> Result<(), DomainError>");
        shop.ShouldContain("impl PartialEq for Account");   // identity equality

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_entities_compile()
    {
        var result = new KoineCompiler().Compile(EntityFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Smart enums (bare + with associated data) and events: each event emits as a public-field data
    /// struct and all events collect into a single <c>DomainEvent</c> enum (the Vec-friendly shape).
    /// </summary>
    private const string EventFixture = """
        context Sales {
          enum Currency(symbol: String, decimals: Int) { EUR("€", 2) USD("$", 2) }
          enum OrderStatus { Draft, Placed, Cancelled }
          value Money {
            amount:   Decimal
            currency: Currency
            invariant amount >= 0 "an amount cannot be negative"
          }
          /// Raised when a draft order is placed.
          event OrderPlaced {
            orderId:   OrderId
            lineCount: Int
            total:     Money
          }
          event OrderCancelled {
            orderId: OrderId
            reason:  String
          }
        }
        """;

    [Fact]
    public Task Rust_events_and_enums_emit_expected_rust()
    {
        var result = new KoineCompiler().Compile(EventFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var sales = result.Files.Single(f => f.RelativePath.EndsWith("sales.rs", StringComparison.Ordinal)).Contents;
        sales.ShouldContain("pub enum DomainEvent {");
        sales.ShouldContain("OrderPlaced(OrderPlaced)");
        // Associated-data accessors and the Match/Switch folds dispatch each variant exhaustively
        // (Rust rejects a non-exhaustive match, so the compile test proves it); only the open-domain
        // from_name/from_value lookups end in a `_ => None` arm.
        sales.ShouldContain("Currency::Eur => \"€\"");
        sales.ShouldContain("_ => None,");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_events_and_enums_compile()
    {
        var result = new KoineCompiler().Compile(EventFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #879 (follow-up to #832, which demand-generated <c>operator /</c> for the C# emitter):
    /// a plain value object divided by a numeric scalar — <c>half: Money = fee / 2</c> — must emit a
    /// real <c>impl std::ops::Div&lt;i64&gt;</c>, mirroring the existing demand-generated
    /// <c>impl std::ops::Mul&lt;i64&gt;</c>. Before the fix
    /// <c>OperatorNeedsAnalyzer.BuildScalarDivisionNeeds</c> was recorded but never consumed by the
    /// Rust emitter, so the derived member referenced a <c>Div</c> impl that was never generated
    /// (a compile error).
    /// </summary>
    [Fact]
    public void Rust_value_object_divided_by_a_scalar_compiles()
    {
        const string model = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0 "an amount cannot be negative"
              }
              entity Order identified by OrderId {
                fee: Money
              }
              readmodel FeeSplit from Order {
                half: Money = fee / 2
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("impl std::ops::Div<i64> for Money");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Regression (#937): an <c>Int</c> field multiplied by a <c>Decimal</c> scalar must be coerced
    /// through <c>Decimal</c>, scaled, and truncated back toward zero to an <c>i64</c> — matching the C#
    /// emitter's checked <c>(int)(decimal)</c> cast. Before the fix the <c>Int</c> field was passed
    /// through un-scaled (<c>steps: self.steps</c>), silently computing a wrong result with no diagnostic.
    /// </summary>
    [Fact]
    public void Rust_int_field_scaled_by_a_decimal_scalar_is_coerced_and_truncated()
    {
        const string model = """
            context Shop {
              value Tally {
                total: Decimal
                steps: Int
                invariant steps >= 0 "steps cannot be negative"
              }
              entity Batch identified by BatchId {
                tally: Tally
              }
              readmodel Scaled from Batch {
                scaled: Tally = tally * 1.5
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("impl std::ops::Mul<Decimal> for Tally");
        // The Int field must be coerced through Decimal, scaled, and truncated back — not passed through.
        shop.ShouldContain("steps: crate::koine_runtime::dec_to_i64(Decimal::from(self.steps) * factor)");
        shop.ShouldNotContain("steps: self.steps,");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Regression (#937), the division dual of the multiply case: an <c>Int</c> field divided by a
    /// <c>Decimal</c> scalar must be coerced through <c>Decimal</c>, divided, and truncated back toward
    /// zero to an <c>i64</c>. Before the fix (#933 mirrored the pre-existing multiply gap) the <c>Int</c>
    /// field was passed through un-divided.
    /// </summary>
    [Fact]
    public void Rust_int_field_divided_by_a_decimal_scalar_is_coerced_and_truncated()
    {
        const string model = """
            context Shop {
              value Tally {
                total: Decimal
                steps: Int
                invariant steps >= 0 "steps cannot be negative"
              }
              entity Batch identified by BatchId {
                tally: Tally
              }
              readmodel Split from Batch {
                halved: Tally = tally / 2.0
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("impl std::ops::Div<Decimal> for Tally");
        shop.ShouldContain("steps: crate::koine_runtime::dec_to_i64(Decimal::from(self.steps) / divisor)");
        shop.ShouldNotContain("steps: self.steps,");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// A value object with two optional numeric fields (<c>Int?</c> + <c>Decimal?</c>) that is
    /// scaled — <c>optional Int/Decimal × ...</c>.
    /// </summary>
    private const string OptionalNumericFixture = """
        context Shop {
          value Tally {
            total: Decimal
            steps: Int?
            ratio: Decimal?
            invariant total >= 0 "total cannot be negative"
          }
          entity Batch identified by BatchId {
            tally: Tally
          }
          readmodel Scaled from Batch {
            scaled: Tally = tally SCALAR
          }
        }
        """;

    /// <summary>
    /// Regression (#960): scaling a value object that has <b>optional</b> numeric fields by a
    /// <c>Decimal</c> scalar must map over each <c>Option</c> so the operator never applies to
    /// <c>Option&lt;T&gt;</c> directly. Covers <c>Int? × Decimal</c> (coerce-and-truncate inside the map)
    /// and <c>Decimal? × Decimal</c>. Before the fix the emitter switched on the field's type name only,
    /// ignoring <c>IsOptional</c>, and emitted <c>Decimal::from(self.steps)</c> — non-compiling Rust.
    /// </summary>
    [Fact]
    public void Rust_optional_numeric_fields_scaled_by_a_decimal_scalar_map_over_the_option()
    {
        var model = OptionalNumericFixture.Replace("SCALAR", "* 1.5", StringComparison.Ordinal);
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("impl std::ops::Mul<Decimal> for Tally");
        // Int? × Decimal: coerce-and-truncate inside the map; the operator never touches Option<i64>.
        shop.ShouldContain("steps: self.steps.map(|v| crate::koine_runtime::dec_to_i64(Decimal::from(v) * factor))");
        // Decimal? × Decimal: multiply inside the map.
        shop.ShouldContain("ratio: self.ratio.map(|v| v * factor)");
        // The broken emission applied the operator (or Decimal::from) directly to the Option.
        shop.ShouldNotContain("Decimal::from(self.steps)");
        shop.ShouldNotContain("ratio: self.ratio * factor");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Regression (#960): scaling a value object with optional numeric fields by an <c>i64</c> scalar.
    /// Covers <c>Int? × i64</c> (plain multiply inside the map) and <c>Decimal? × i64</c> (coerce the
    /// factor to <c>Decimal</c> inside the map).
    /// </summary>
    [Fact]
    public void Rust_optional_numeric_fields_scaled_by_an_int_scalar_map_over_the_option()
    {
        var model = OptionalNumericFixture.Replace("SCALAR", "* 2", StringComparison.Ordinal);
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("impl std::ops::Mul<i64> for Tally");
        // Int? × i64: plain multiply inside the map.
        shop.ShouldContain("steps: self.steps.map(|v| v * factor)");
        // Decimal? × i64: coerce the factor to Decimal inside the map.
        shop.ShouldContain("ratio: self.ratio.map(|v| v * Decimal::from(factor))");
        shop.ShouldNotContain("steps: self.steps * factor");
        shop.ShouldNotContain("ratio: self.ratio * Decimal::from(factor)");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Regression (#960), the division dual: dividing a value object with optional numeric fields by a
    /// <c>Decimal</c> scalar. Covers <c>Int? ÷ Decimal</c> (coerce-and-truncate inside the map) and
    /// <c>Decimal? ÷ Decimal</c>.
    /// </summary>
    [Fact]
    public void Rust_optional_numeric_fields_divided_by_a_decimal_scalar_map_over_the_option()
    {
        var model = OptionalNumericFixture.Replace("SCALAR", "/ 2.0", StringComparison.Ordinal);
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("impl std::ops::Div<Decimal> for Tally");
        shop.ShouldContain("steps: self.steps.map(|v| crate::koine_runtime::dec_to_i64(Decimal::from(v) / divisor))");
        shop.ShouldContain("ratio: self.ratio.map(|v| v / divisor)");
        shop.ShouldNotContain("Decimal::from(self.steps)");
        shop.ShouldNotContain("ratio: self.ratio / divisor");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Regression (#960), the division dual by an <c>i64</c> scalar. Covers <c>Int? ÷ i64</c> (plain
    /// divide inside the map) and <c>Decimal? ÷ i64</c> (coerce the divisor to <c>Decimal</c> inside the
    /// map).
    /// </summary>
    [Fact]
    public void Rust_optional_numeric_fields_divided_by_an_int_scalar_map_over_the_option()
    {
        var model = OptionalNumericFixture.Replace("SCALAR", "/ 2", StringComparison.Ordinal);
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("impl std::ops::Div<i64> for Tally");
        shop.ShouldContain("steps: self.steps.map(|v| v / divisor)");
        shop.ShouldContain("ratio: self.ratio.map(|v| v / Decimal::from(divisor))");
        shop.ShouldNotContain("steps: self.steps / divisor");
        shop.ShouldNotContain("ratio: self.ratio / Decimal::from(divisor)");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Regression: a derived (computed) member is emitted as an accessor method, so a reference to it
    /// from another expression must render as a call <c>self.x()</c>, not a field read <c>self.x</c>.
    /// </summary>
    [Fact]
    public void Rust_derived_member_referencing_another_derived_member_calls_the_accessor()
    {
        const string model = """
            context D {
              value Line {
                unitPrice:  Decimal
                quantity:   Int
                subtotal:   Decimal = unitPrice * quantity
                discounted: Decimal = subtotal * unitPrice
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var d = result.Files.Single(f => f.RelativePath.EndsWith("d.rs", StringComparison.Ordinal)).Contents;
        d.ShouldContain("self.subtotal() * self.unit_price");   // derived ref → method call

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Regression (#961): a derived member whose body infers to <c>Int</c> but is declared <c>Decimal</c>
    /// (<c>total: Decimal = a + b</c> over two <c>Int</c> fields — a widening C# does implicitly) must
    /// wrap the body in <c>Decimal::from(...)</c>. Rust has no implicit numeric widening, so a bare
    /// <c>i64</c> body in a <c>-&gt; Decimal</c> getter is rustc E0308. This is the derived-member dual of
    /// the scalar-operator coercion #937 fixed; before this fix <c>WriteDerived</c> emitted the body as-is.
    /// </summary>
    [Fact]
    public void Rust_int_bodied_derived_member_is_widened_to_its_decimal_declared_type()
    {
        const string model = """
            context Shop {
              value Sums {
                a: Int
                b: Int
                total: Decimal = a + b
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        shop.ShouldContain("pub fn total(&self) -> Decimal {");
        // The Int-typed body must be widened to the declared Decimal, not emitted bare (which is E0308).
        shop.ShouldContain("Decimal::from(self.a + self.b)");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // End-to-end: the real billing starter template (value objects, a smart enum, entities, an
    // aggregate with a nested enum/value/entity, a derived scalar-Mul member, a `when`-guarded
    // invariant, and the default repository trait).
    // ------------------------------------------------------------------

    [Fact]
    public Task Rust_billing_template_emits_expected_rust()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var billing = result.Files.Single(f => f.RelativePath.EndsWith("billing.rs", StringComparison.Ordinal)).Contents;
        billing.ShouldContain("pub trait OrderRepository");
        billing.ShouldContain("impl std::ops::Mul<i64> for Money");   // demand-driven scalar op
        billing.ShouldContain("pub struct ProductId(String);");        // unowned id materialized

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_billing_template_compiles()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>Every starter template emits Rust that compiles (the real cross-construct proof).</summary>
    [Theory]
    [InlineData("starters/values/values.koi")]
    [InlineData("starters/ordering/ordering.koi")]
    [InlineData("starters/contextmap/catalog-sales.koi")]
    public void Rust_starter_templates_compile(string relativePath)
    {
        if (FindTemplate(relativePath) is not { } source)
        {
            Assert.Skip($"Template '{relativePath}' not found from the test assembly; cargo check not run.");
            return;
        }

        var result = new KoineCompiler().Compile(source, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // Cross-context type references (issue #173, Task 1). A type owned by one
    // bounded context but referenced from another must be qualified as
    // `crate::<owner_module>::<Type>` so the flat multi-context crate resolves.
    // ------------------------------------------------------------------

    /// <summary>Two contexts: Sales (a conformist downstream) references Catalog's value object + enum.</summary>
    private const string CrossContextFixture = """
        context Catalog {
          enum Grade(label: String) {
            Premium("P")
            Standard("S")
          }

          value Sku {
            code: String
            invariant code.trim.length > 0   "a sku needs a code"
          }
        }

        context Sales {
          value LineItem {
            sku:      Sku
            grade:    Grade
            quantity: Int
            invariant quantity >= 1   "an order line needs at least one unit"
          }
        }

        contextmap {
          Catalog -> Sales : conformist
        }
        """;

    [Fact]
    public Task Rust_cross_context_type_references_qualify()
    {
        var result = new KoineCompiler().Compile(CrossContextFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var sales = result.Files.Single(f => f.RelativePath.EndsWith("sales.rs", StringComparison.Ordinal)).Contents;
        // The foreign value object and enum are qualified to their owning context's module.
        sales.ShouldContain("sku: crate::catalog::Sku");
        sales.ShouldContain("grade: crate::catalog::Grade");

        // The owning module declares them bare (it never self-qualifies).
        var catalog = result.Files.Single(f => f.RelativePath.EndsWith("catalog.rs", StringComparison.Ordinal)).Contents;
        catalog.ShouldContain("pub struct Sku");
        catalog.ShouldContain("pub enum Grade");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_cross_context_type_references_compile()
    {
        var result = new KoineCompiler().Compile(CrossContextFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The six-context pizzeria template (the C# demo's end-to-end domain) emits a Rust crate that
    /// compiles — the real multi-context proof: Menu's <c>Topping</c> referenced from Kitchen and the
    /// shared-kernel <c>Currency</c> referenced from Ordering resolve to their owning modules.
    /// </summary>
    [Fact]
    public void Rust_pizzeria_template_compiles()
    {
        if (FindTemplateDir("pizzeria") is not { } sources)
        {
            Assert.Skip("Pizzeria template not found from the test assembly; cargo check not run.");
            return;
        }

        var result = new KoineCompiler().Compile(sources, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // Command returns (issue #173, Task 2). A command with a declared return type and
    // a terminal `result` clause returns a value; `result id` hands back the entity's
    // own identity — cloned, since the branded newtype is `Clone` but not `Copy`.
    // ------------------------------------------------------------------

    /// <summary>An entity whose <c>cancel</c> returns its id and <c>bump</c> returns a computed Int.</summary>
    private const string CommandReturnFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }
          entity Order identified by OrderId {
            status: OrderStatus = Draft
            total:  Int = 0

            command cancel(): OrderId {
              requires status != Cancelled "already cancelled"
              status -> Cancelled
              result id
            }

            command bump(by: Int): Int {
              total -> total + by
              result total
            }
          }
        }
        """;

    [Fact]
    public Task Rust_command_returns_emit_expected_rust()
    {
        var result = new KoineCompiler().Compile(CommandReturnFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var sales = result.Files.Single(f => f.RelativePath.EndsWith("sales.rs", StringComparison.Ordinal)).Contents;
        // `result id` returns the entity's own identity, cloned (the branded newtype is not Copy).
        sales.ShouldContain("pub fn cancel(&mut self) -> Result<OrderId, DomainError>");
        sales.ShouldContain("Ok(self.id.clone())");
        // A Copy result (Int) needs no clone and reads post-mutation state.
        sales.ShouldContain("pub fn bump(&mut self, by: i64) -> Result<i64, DomainError>");
        sales.ShouldContain("Ok(self.total)");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_command_returns_compile()
    {
        var result = new KoineCompiler().Compile(CommandReturnFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // Event raising (issue #173, Task 3). An `emit` clause records a domain event: the
    // entity gains an `events: Vec<DomainEvent>` collection (empty in `new`, excluded
    // from identity equality), a slice accessor + drain, and the command pushes
    // `DomainEvent::Ev(Ev::new(...))` with `id`/param refs resolved.
    // ------------------------------------------------------------------

    /// <summary>An entity whose <c>place</c> command raises an <c>OrderPlaced</c> domain event.</summary>
    private const string EmitFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }
          event OrderPlaced { orderId: OrderId  status: OrderStatus }
          entity Order identified by OrderId {
            status: OrderStatus = Draft

            command place() {
              requires status == Draft "must be draft"
              status -> Placed
              emit OrderPlaced(orderId: id, status: status)
            }
          }
        }
        """;

    [Fact]
    public Task Rust_event_emit_raises_into_events_vec()
    {
        var result = new KoineCompiler().Compile(EmitFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var sales = result.Files.Single(f => f.RelativePath.EndsWith("sales.rs", StringComparison.Ordinal)).Contents;
        sales.ShouldContain("events: Vec<DomainEvent>,");                                  // collection field
        sales.ShouldContain("events: Vec::new(),");                                        // empty in `new`
        sales.ShouldContain("pub fn events(&self) -> &[DomainEvent]");                      // accessor
        sales.ShouldContain("pub fn drain_events(&mut self) -> Vec<DomainEvent>");          // drain
        // `id`/param refs resolve; the event's `new` is wrapped in the context DomainEvent enum.
        sales.ShouldContain("self.events.push(DomainEvent::OrderPlaced(OrderPlaced::new(self.id.clone(), self.status)));");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_event_emit_compiles()
    {
        var result = new KoineCompiler().Compile(EmitFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // Member/synthetic-field collision (issue #314). A user member literally named `events`
    // must not collide with the synthetic `Vec<DomainEvent>` collector: the user's field is
    // emitted faithfully and the synthetic collector takes a distinct, non-colliding name
    // (`domain_events`), applied consistently across the struct, ctor, accessors, and `push`.
    // ------------------------------------------------------------------

    /// <summary>An aggregate whose entity has a user member named <c>events</c> and also raises an event.</summary>
    private const string EventsMemberCollisionFixture = """
        context Reservations {
          event TableReserved { bookingId: BookingId }
          aggregate Bookings root Booking {
            entity Booking identified by BookingId {
              events: List<String>
              command reserve {
                emit TableReserved(bookingId: id)
              }
            }
          }
        }
        """;

    [Fact]
    public Task Rust_member_named_events_does_not_collide_with_synthetic_collector()
    {
        var result = new KoineCompiler().Compile(EventsMemberCollisionFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var reservations = result.Files.Single(f => f.RelativePath.EndsWith("reservations.rs", StringComparison.Ordinal)).Contents;
        // The user's `events` member is emitted faithfully...
        reservations.ShouldContain("events: Vec<String>,");
        reservations.ShouldContain("pub fn events(&self) -> &Vec<String>");
        // ...and the synthetic collector yields the colliding name, becoming `domain_events` —
        // consistently in the struct, the smart constructor, the accessor/drain, and the `push`.
        reservations.ShouldContain("domain_events: Vec<DomainEvent>,");
        reservations.ShouldContain("domain_events: Vec::new(),");
        reservations.ShouldContain("pub fn domain_events(&self) -> &[DomainEvent]");
        reservations.ShouldContain("pub fn drain_domain_events(&mut self) -> Vec<DomainEvent>");
        reservations.ShouldContain("self.domain_events.push(DomainEvent::TableReserved(");
        // The bug: a second struct field literally named `events` holding the collector (E0124). Anchor
        // on the field indentation so this doesn't false-match the renamed `domain_events` field.
        reservations.ShouldNotContain("\n    events: Vec<DomainEvent>");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_member_named_events_compiles()
    {
        var result = new KoineCompiler().Compile(EventsMemberCollisionFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Edge case (#314): a model with members named *both* <c>events</c> and (snake-cased) <c>domain_events</c>
    /// takes the first fallback too, so the synthetic collector must keep searching — landing on a
    /// numbered, unique, compiling name. The two user members are emitted untouched.
    /// </summary>
    [Fact]
    public void Rust_members_named_events_and_domain_events_resolve_to_a_numbered_collector()
    {
        const string model = """
            context Reservations {
              event TableReserved { bookingId: BookingId }
              aggregate Bookings root Booking {
                entity Booking identified by BookingId {
                  events:       List<String>
                  domainEvents: List<String>
                  command reserve {
                    emit TableReserved(bookingId: id)
                  }
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var reservations = result.Files.Single(f => f.RelativePath.EndsWith("reservations.rs", StringComparison.Ordinal)).Contents;
        // Both user members survive...
        reservations.ShouldContain("\n    events: Vec<String>,");
        reservations.ShouldContain("\n    domain_events: Vec<String>,");
        // ...and the synthetic collector falls through to a numbered, unique name.
        reservations.ShouldContain("\n    domain_events_2: Vec<DomainEvent>,");
        reservations.ShouldContain("self.domain_events_2.push(DomainEvent::TableReserved(");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Edge case (#314): an entity with a member named <c>events</c> that raises *no* event emits the
    /// member untouched and grows no synthetic collector at all (the existing common shape is unchanged).
    /// </summary>
    [Fact]
    public void Rust_member_named_events_without_emits_stays_untouched()
    {
        const string model = """
            context Audit {
              entity Log identified by LogId {
                events: List<String>
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var audit = result.Files.Single(f => f.RelativePath.EndsWith("audit.rs", StringComparison.Ordinal)).Contents;
        audit.ShouldContain("\n    events: Vec<String>,");   // user member, faithful
        audit.ShouldNotContain("Vec<DomainEvent>");           // no events declared → no collector
        audit.ShouldNotContain("domain_events");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // Factories (issue #173, Task 4). A `create` factory emits an associated constructor
    // that mints a v4-UUID identity, checks preconditions, builds via the smart constructor,
    // and records creation events. The `uuid` crate is added to Cargo.toml only when a model
    // actually uses a factory.
    // ------------------------------------------------------------------

    /// <summary>An aggregate whose <c>open</c> factory mints an id, checks a precondition, and emits.</summary>
    private const string FactoryFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }
          event OrderOpened { orderId: OrderId  lineCount: Int }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              lines:  Int
              status: OrderStatus = Draft

              create open(lines: Int) {
                requires lines >= 1   "an order needs at least one line"
                emit OrderOpened(orderId: id, lineCount: lines)
              }
            }
          }
        }
        """;

    [Fact]
    public Task Rust_factory_emits_identity_generating_constructor()
    {
        var result = new KoineCompiler().Compile(FactoryFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var sales = result.Files.Single(f => f.RelativePath.EndsWith("sales.rs", StringComparison.Ordinal)).Contents;
        sales.ShouldContain("pub fn generate() -> Self { OrderId(uuid::Uuid::new_v4().to_string()) }");
        sales.ShouldContain("pub fn open(lines: i64) -> Result<Self, DomainError>");
        sales.ShouldContain("let id = OrderId::generate();");
        sales.ShouldContain("DomainEvent::OrderOpened(OrderOpened::new(id.clone(), lines))");
        sales.ShouldContain("let mut instance = Self::new(id, lines)?;");

        // The uuid crate is pulled in only because the model uses a factory.
        var cargo = result.Files.Single(f => f.RelativePath == "Cargo.toml").Contents;
        cargo.ShouldContain("uuid = { version = \"1\", features = [\"v4\"] }");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_factory_model_compiles()
    {
        var result = new KoineCompiler().Compile(FactoryFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Rust_factory_free_model_omits_uuid_dependency()
    {
        // A model with no factory keeps the dependency-light two-crate manifest.
        var result = new KoineCompiler().Compile(CommandReturnFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var cargo = result.Files.Single(f => f.RelativePath == "Cargo.toml").Contents;
        cargo.ShouldContain("rust_decimal = \"1\"");
        cargo.ShouldContain("regex = \"1\"");
        cargo.ShouldNotContain("uuid");
    }

    // ------------------------------------------------------------------
    // Factory event-collector local vs. a factory parameter (issue #325, a #314 follow-up).
    // The factory builds its creation events into a `let <collector>: Vec<DomainEvent> = …` local
    // and assigns it after `Self::new`. `<collector>` is the entity-wide synthetic field name —
    // which dodges member/command/factory *names* but NOT a factory *parameter* whose snake_case
    // equals it. When a member named `events` forces the collector to `domain_events` AND a factory
    // parameter also snake_cases to `domain_events`, the `let domain_events` binding shadows the
    // parameter for the rest of the body: `Self::new(…)` then sees the Vec, not the param (rustc
    // E0308). The collector *local* must take a name no factory parameter can shadow.
    // ------------------------------------------------------------------

    /// <summary>
    /// A member named <c>events</c> forces the collector to <c>domain_events</c>; the factory's
    /// <c>domainEvents</c> parameter snake_cases to the same — and is used both in the emit payload
    /// and a field initialization (so it must survive into <c>Self::new(…)</c>).
    /// </summary>
    private const string FactoryParamShadowsCollectorFixture = """
        context Reservations {
          event OrderOpened { bookingId: BookingId  count: Int }
          aggregate Bookings root Booking {
            entity Booking identified by BookingId {
              events: List<String>?
              count:  Int
              create open(domainEvents: Int) {
                count -> domainEvents
                emit OrderOpened(bookingId: id, count: domainEvents)
              }
            }
          }
        }
        """;

    [Fact]
    public Task Rust_factory_event_collector_local_does_not_shadow_a_factory_parameter()
    {
        var result = new KoineCompiler().Compile(FactoryParamShadowsCollectorFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var reservations = result.Files.Single(f => f.RelativePath.EndsWith("reservations.rs", StringComparison.Ordinal)).Contents;
        // The public field/accessors keep the entity-wide synthetic name (`domain_events`) — the fix
        // does not churn the struct shape, only the factory's local.
        reservations.ShouldContain("\n    domain_events: Vec<DomainEvent>,");
        reservations.ShouldContain("pub fn domain_events(&self) -> &[DomainEvent]");
        reservations.ShouldContain("pub fn drain_domain_events(&mut self) -> Vec<DomainEvent>");
        // The factory parameter snake_cases to `domain_events`...
        reservations.ShouldContain("pub fn open(domain_events: i64) -> Result<Self, DomainError>");
        // ...so the collector *local* must be disambiguated away from it (else the `let` shadows the
        // param). It lands on a numbered, unique name — and the field is assigned from THAT local.
        // These two are the discriminating assertions: pre-fix the local is `domain_events`, so both
        // go red (as does the verified snapshot).
        reservations.ShouldContain("let domain_events_2: Vec<DomainEvent> = vec![");
        reservations.ShouldContain("instance.domain_events = domain_events_2;");
        // The factory body still references the `domain_events` parameter in the emit payload and the
        // ctor call. NB: this text is byte-identical with and without the fix — what changes is which
        // binding `domain_events` resolves to (the i64 param vs. the Vec local). That the param is the
        // one that survives — i.e. it is genuinely unshadowed — is proved by the rustc compile gate in
        // Rust_factory_event_collector_local_shadow_model_compiles, not by these string matches.
        reservations.ShouldContain("OrderOpened::new(id.clone(), domain_events))");
        reservations.ShouldContain("let mut instance = Self::new(id, None, domain_events)?;");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_factory_event_collector_local_shadow_model_compiles()
    {
        var result = new KoineCompiler().Compile(FactoryParamShadowsCollectorFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        // With the shadow bug, `Self::new(id, None, domain_events)` passes the `Vec<DomainEvent>` local
        // where an `i64` is expected — a rustc E0308 the compile gate catches when a toolchain is present.
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // Smart-enum API (issue #173, Task 5). Every Koine enum gains the Rust analogue of the
    // C# TryFromName/TryFromValue + Match/Switch: non-throwing `from_name`/`from_value`
    // lookups returning `Option`, and exhaustive `match_`/`switch` folds dispatched by a
    // wildcard-free `match` (adding a variant becomes a compile error at every call site).
    // ------------------------------------------------------------------

    /// <summary>A plain smart enum whose generated API exercises the Match/Switch/Try* forms.</summary>
    private const string SmartEnumFixture = """
        context Shop {
          enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }
        }
        """;

    [Fact]
    public Task Rust_smart_enum_api_emits_match_switch_and_lookups()
    {
        var result = new KoineCompiler().Compile(SmartEnumFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var shop = result.Files.Single(f => f.RelativePath.EndsWith("shop.rs", StringComparison.Ordinal)).Contents;
        // Try* lowered to Option-returning lookups.
        shop.ShouldContain("pub fn from_name(name: &str) -> Option<Self>");
        shop.ShouldContain("\"Paid\" => Some(OrderStatus::Paid)");
        shop.ShouldContain("pub fn from_value(value: i64) -> Option<Self>");
        shop.ShouldContain("2 => Some(OrderStatus::Paid)");
        // Match/Switch lowered to exhaustive, wildcard-free dispatch.
        shop.ShouldContain("pub fn match_<R>(");
        shop.ShouldContain("pub fn switch(");
        shop.ShouldContain("OrderStatus::Cancelled => cancelled(),");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_smart_enum_api_compiles()
    {
        var result = new KoineCompiler().Compile(SmartEnumFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    // ------------------------------------------------------------------
    // Queries & read models (issue #173, Task 6 — the CQRS read side). A `readmodel`
    // emits a flat projection struct + a `from_<source>` projection fn (direct fields
    // copy the like-named source member through its accessor, owned; derived fields
    // project an expression). A `query` emits a criteria DTO struct + `new`.
    // ------------------------------------------------------------------

    /// <summary>An aggregate with a read model (direct + derived fields) and a query over it.</summary>
    private const string CqrsFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              customer: String
              lines:    Int
              status:   OrderStatus = Draft
            }
          }

          readmodel OrderRow from Order {
            id
            customer
            status
            busy: Bool = lines > 0
          }

          query OrdersByStatus(status: OrderStatus): List<OrderRow>
        }
        """;

    [Fact]
    public Task Rust_read_models_and_queries_emit_expected_rust()
    {
        var result = new KoineCompiler().Compile(CqrsFixture, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var sales = result.Files.Single(f => f.RelativePath.EndsWith("sales.rs", StringComparison.Ordinal)).Contents;
        // The read-model projection struct + its from_<source> fn.
        sales.ShouldContain("pub struct OrderRow {");
        sales.ShouldContain("pub fn from_order(src: &Order) -> Self");
        sales.ShouldContain("id: src.id().clone(),");          // a non-Copy id is cloned
        sales.ShouldContain("customer: src.customer().to_string(),"); // a String is owned via to_string
        sales.ShouldContain("status: src.status(),");          // a Copy enum is taken verbatim
        sales.ShouldContain("busy: src.lines() > 0,");         // a derived field projects its expression
        // The query criteria DTO.
        sales.ShouldContain("pub struct OrdersByStatus {");
        sales.ShouldContain("pub status: OrderStatus,");
        sales.ShouldContain("pub fn new(status: OrderStatus) -> Self");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_read_models_and_queries_compile()
    {
        var result = new KoineCompiler().Compile(CqrsFixture, new RustEmitter());
        result.Success.ShouldBeTrue();

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);

        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>Reads a template under <c>templates/</c> by walking up to the repo root (the <c>.git</c> dir).</summary>
    private static string? FindTemplate(string relativePath)
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (!Directory.Exists(Path.Combine(dir.FullName, ".git")) && !File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                continue;
            }

            var candidate = Path.Combine(dir.FullName, "templates", relativePath.Replace('/', Path.DirectorySeparatorChar));
            return File.Exists(candidate) ? File.ReadAllText(candidate) : null;
        }

        return null;
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

    /// <summary>
    /// The pre-existing default-name case the issue calls out: an entity with NO member named
    /// <c>events</c>, so the synthetic collector keeps its idiomatic default name <c>events</c> — and a
    /// factory parameter literally named <c>events</c> that the <c>let events</c> binding would shadow.
    /// (This shadow predates #314: a factory param named <c>events</c> shadowed the default local on
    /// <c>main</c> already.) The collector local must disambiguate to <c>events_2</c> while the struct
    /// field / accessor / <c>drain_</c> keep the default <c>events</c>, and the parameter survives into
    /// <c>Self::new(…)</c>. This exercises <see cref="RustNaming.FactoryEventsLocal"/>'s default branch,
    /// which the <c>domain_events</c> fixture (which forces the fallback name) routes around.
    /// </summary>
    [Fact]
    public void Rust_factory_event_collector_local_does_not_shadow_a_default_named_parameter()
    {
        const string model = """
            context Audit {
              event Logged { entryId: EntryId  count: Int }
              aggregate Logs root Entry {
                entity Entry identified by EntryId {
                  count: Int
                  create record(events: Int) {
                    count -> events
                    emit Logged(entryId: id, count: events)
                  }
                }
              }
            }
            """;
        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var audit = result.Files.Single(f => f.RelativePath.EndsWith("audit.rs", StringComparison.Ordinal)).Contents;
        // The collector keeps its default name on the struct field, accessor, and drain.
        audit.ShouldContain("\n    events: Vec<DomainEvent>,");
        audit.ShouldContain("pub fn events(&self) -> &[DomainEvent]");
        audit.ShouldContain("pub fn drain_events(&mut self) -> Vec<DomainEvent>");
        // The factory parameter is named `events`...
        audit.ShouldContain("pub fn record(events: i64) -> Result<Self, DomainError>");
        // ...so the collector *local* disambiguates to `events_2` (else the `let events` shadows it),
        // and the field is assigned from that local — the discriminating, toolchain-independent pin.
        audit.ShouldContain("let events_2: Vec<DomainEvent> = vec![");
        audit.ShouldContain("instance.events = events_2;");
        // The unshadowed parameter reaches `Self::new(…)` (semantic proof is the compile gate below).
        audit.ShouldContain("let mut instance = Self::new(id, events)?;");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, NoToolchainNotice);
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
