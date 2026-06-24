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
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
        // Smart-enum accessors are exhaustive matches with no `_` catch-all.
        sales.ShouldContain("Currency::Eur => \"€\"");
        sales.ShouldNotContain("_ =>");

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Rust_events_and_enums_compile()
    {
        var result = new KoineCompiler().Compile(EventFixture, new RustEmitter());
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
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }
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
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
            _output.WriteLine($"INCONCLUSIVE: template '{relativePath}' not found from the test assembly.");
            return;
        }

        var result = new KoineCompiler().Compile(source, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
            _output.WriteLine("INCONCLUSIVE: pizzeria template not found from the test assembly.");
            return;
        }

        var result = new KoineCompiler().Compile(sources, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileRust(result.Files);
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
        if (!check.ToolchainAvailable)
        {
            _output.WriteLine(NoToolchainNotice);
            return;
        }

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
}
