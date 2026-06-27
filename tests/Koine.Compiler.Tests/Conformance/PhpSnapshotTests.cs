using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Snapshot coverage for the PHP backend. <see cref="Fixture"/> is the Phase-1 domain
/// (value objects + a money quantity + a smart enum + a Range-based value object) and is the
/// SINGLE shared fixture that every later PHP task extends — each construct re-accepts this
/// snapshot as its emitter lands.
/// <para>
/// This task (Task 5) emits only <c>value</c> and <c>quantity</c> declarations; other construct
/// kinds (entity, enum, aggregate, command, event, repository) stay no-ops and emit nothing yet.
/// The fixture uses the same domain as the Python snapshot so the two emitters can be compared.
/// </para>
/// </summary>
public class PhpSnapshotTests
{
    private const string NoToolchainNotice =
        "No usable PHP toolchain (phpstan) available; phpstan --level max type-check not run. " +
        "Install phpstan (or set KOINE_PHPSTAN) — CI runs this for real.";

    /// <summary>The Phase-1 domain fixture, emitted to PHP. Shared by Tasks 5+ (one growing snapshot).</summary>
    internal const string Fixture = """
        context Sales {
          /// A monetary amount in a currency. Never negative.
          value Money {
            amount:   Decimal
            currency: String
            invariant amount >= 0 "an amount cannot be negative"
          }

          /// Currencies, carrying their symbol and minor-unit count.
          enum Currency(symbol: String, decimals: Int) {
            EUR("€", 2)
            USD("$", 2)
          }

          /// The lifecycle of an order.
          enum OrderStatus { Draft, Placed, Cancelled }

          /// The units a weight can be measured in.
          enum MassUnit { Gram, Kilogram }

          /// A measured weight: an amount in a unit. Quantities of different units cannot be combined.
          quantity Weight {
            amount: Decimal
            unit:   MassUnit
          }

          /// A line of an order; its subtotal is derived (unit price scaled by quantity).
          value OrderLine {
            product:   String
            quantity:  Int
            unitPrice: Money
            subtotal:  Money = unitPrice * quantity
            invariant quantity >= 1 "a line needs at least one unit"
          }

          /// A bookable window over time (exercises Range<Instant>).
          value SalePeriod {
            window: Range<Instant>
          }

          aggregate Order root Order {
            event OrderOpened {
              orderId:   OrderId
              customer:  CustomerId
              lineCount: Int
            }

            event OrderPlaced {
              orderId:   OrderId
              lineCount: Int
            }

            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft

              invariant !lines.isEmpty "an order must have at least one line"

              command place {
                requires status == Draft "only a draft order can be placed"
                status -> Placed
                emit OrderPlaced(orderId: id, lineCount: lines.count)
              }

              create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
                requires !lines.isEmpty "cannot open an empty order"
                emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
              }
            }

            repository {
              find byCustomer(customer: CustomerId): List<Order>
              find mostRecent(customer: CustomerId): Order
            }
          }
        }
        """;

    /// <summary>The emitted PHP for the fixture must match its reviewed snapshot.</summary>
    [Fact]
    public async Task Php_fixture_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(Fixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The snapshot is the always-on guarantee — it runs regardless of the PHP toolchain.
        await Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");

        // The phpstan --level max type-check gate (parity with TS/Python, #496) skips (or hard-fails
        // under KOINE_REQUIRE_CONFORMANCE) when no phpstan toolchain is present.
        var typeCheck = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(typeCheck.ToolchainAvailable, NoToolchainNotice);
        typeCheck.Ok.ShouldBeTrue(string.Join("\n", typeCheck.Errors));
    }

    /// <summary>
    /// Dedicated entity fixture: exercises a Guid identity strategy, stored + derived members,
    /// an invariant, and the identity <c>equals()</c> — the scope of Task 7.
    /// Commands and factories are intentionally omitted (those land in a later task).
    /// </summary>
    internal const string EntityFixture = """
        context Inventory {
          enum StockStatus { Available, Reserved, OutOfStock }

          aggregate Product root Product {
            entity Product identified by ProductId {
              name:    String
              stock:   Int
              status:  StockStatus = Available
              hasStock: Bool = stock > 0

              invariant name.length > 0 "a product must have a name"
              invariant stock >= 0 "stock cannot be negative"
            }
          }
        }
        """;

    /// <summary>
    /// Emitted PHP for <see cref="EntityFixture"/> must match its reviewed snapshot.
    /// Covers: Guid identity value object with <c>generate()</c> factory, mutable entity class
    /// with identity <c>equals()</c>, constructor invariants, and a derived getter.
    /// </summary>
    [Fact]
    public async Task Php_entity_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(EntityFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The snapshot is the always-on guarantee — it runs regardless of the PHP toolchain.
        await Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");

        // The phpstan --level max type-check gate (parity with TS/Python, #496) skips (or hard-fails
        // under KOINE_REQUIRE_CONFORMANCE) when no phpstan toolchain is present.
        var typeCheck = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(typeCheck.ToolchainAvailable, NoToolchainNotice);
        typeCheck.Ok.ShouldBeTrue(string.Join("\n", typeCheck.Errors));
    }

    // -----------------------------------------------------------------------
    // Task 8: end-to-end fixture (commands, events, aggregates, repositories)
    // -----------------------------------------------------------------------

    /// <summary>
    /// A six-construct end-to-end fixture: value object, smart enum, entity with a command and
    /// a factory, domain events, and a repository. Exercises Task 8's full dispatch.
    /// </summary>
    internal const string EndToEndFixture = """
        context Billing {
          /// The monetary amount for an invoice line.
          value Amount {
            value: Decimal
            invariant value >= 0 "amount cannot be negative"
          }

          /// Invoice lifecycle states.
          enum InvoiceStatus { Draft, Issued, Paid, Voided }

          aggregate Invoice root Invoice {
            /// Raised when an invoice is created.
            event InvoiceCreated {
              invoiceId: InvoiceId
              customerId: String
            }

            /// Raised when an invoice is issued.
            event InvoiceIssued {
              invoiceId: InvoiceId
            }

            entity Invoice identified by InvoiceId {
              customerId: String
              total:      Amount
              status:     InvoiceStatus = Draft

              invariant customerId.length > 0 "customer id must not be empty"

              command issue {
                requires status == Draft "only a draft invoice can be issued"
                status -> Issued
                emit InvoiceIssued(invoiceId: id)
              }

              create forCustomer(customerId: String, total: Amount) {
                requires customerId.length > 0 "customer id required"
                emit InvoiceCreated(invoiceId: id, customerId: customerId)
              }
            }

            repository {
              find byCustomer(customerId: String): List<Invoice>
              find latest(customerId: String): Invoice
            }
          }
        }
        """;

    /// <summary>
    /// End-to-end snapshot test: value object, enum, entity with command + factory, events,
    /// and repository interface — exercising Task 8's full per-type dispatch in PHP.
    /// </summary>
    [Fact]
    public async Task Php_end_to_end_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(EndToEndFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The snapshot is the always-on guarantee — it runs regardless of the PHP toolchain.
        await Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");

        // The phpstan --level max type-check gate (parity with TS/Python, #496) skips (or hard-fails
        // under KOINE_REQUIRE_CONFORMANCE) when no phpstan toolchain is present.
        var typeCheck = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(typeCheck.ToolchainAvailable, NoToolchainNotice);
        typeCheck.Ok.ShouldBeTrue(string.Join("\n", typeCheck.Errors));
    }

    // -----------------------------------------------------------------------
    // #583: phpstan --level max coverage for the constructs #496's fixtures
    // did NOT reach — event payloads and CQRS read-models/queries. Each carries
    // a collection (`List`/`Set`/`Map`) or a generic (`Range<T>`), so before
    // #583 the emitter produced a bare `array`/`Range` PHPDoc that
    // `phpstan --level max` rejects (`missingType.iterableValue` /
    // `missingType.generics`) — including the query-handler interface, whose
    // `extends QueryHandler` was unbound (`missingType.generics`) because #496
    // shipped no `query` fixture to exercise it. The fixture also carries an
    // event `Map<Sku, Int>` with a non-scalar (value-object) key: that renders
    // `array<Sku, int>`, which phpstan --level max accepts (it does not enforce
    // the int|string array-key constraint inside a generic PHPDoc), so no
    // key-type guard is needed for level-max parity.
    //
    // NOTE — enum associated-data collections are intentionally NOT covered:
    // the semantic validator (KOI0909) restricts an enum associated-data field
    // to String/Int/Decimal/Bool, so a `List`/`Range`-typed enum data field is
    // unreachable through the compile pipeline and cannot be exercised by a
    // fixture. The emitter still routes that accessor through the same
    // `DocType` + `WriteMethodDoc` helper for consistency (a no-op for the only
    // reachable, scalar case). See #583.
    // -----------------------------------------------------------------------

    /// <summary>
    /// A fixture reaching the #583 constructs: a domain event carrying a <c>List</c>, a
    /// <c>Range&lt;Instant&gt;</c>, and a <c>Map</c> with a non-scalar (<c>Sku</c>) key; a read model
    /// projecting a collection field directly; and queries with a collection criterion and a
    /// list-returning handler.
    /// </summary>
    internal const string LevelMaxCoverageFixture = """
        context Catalog {
          /// A stock-keeping unit (a non-scalar map key).
          value Sku {
            code: String
          }

          /// A line of an order.
          value OrderLine {
            product:  String
            quantity: Int
            invariant quantity >= 1 "a line needs at least one unit"
          }

          /// The lifecycle of an order.
          enum OrderStatus { Draft, Placed, Shipped }

          aggregate Sales root Order {
            /// Raised when an order is placed — its payload carries a collection, a range, and a map.
            event OrderPlaced {
              orderId: OrderId
              lines:   List<OrderLine>
              window:  Range<Instant>
              tallies: Map<Sku, Int>
            }

            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft

              invariant !lines.isEmpty "an order must have at least one line"
            }

            repository {
              find byCustomer(customer: CustomerId): List<Order>
            }
          }

          /// A read model exposing a collection field (lines) directly.
          readmodel OrderSummary from Order {
            id
            customer
            lines
            lineCount: Int = lines.count
          }

          /// A query whose criterion is a collection and whose result is a list.
          query OrdersBySkus(skus: List<Sku>): List<OrderSummary>

          /// A query returning a single read model.
          query OrderById(id: OrderId): OrderSummary
        }
        """;

    /// <summary>
    /// Emitted PHP for <see cref="LevelMaxCoverageFixture"/> must match its reviewed snapshot AND
    /// pass <c>phpstan analyse --level max</c> — the #583 gate over event/CQRS collection payloads
    /// and a non-scalar <c>Map</c> key.
    /// </summary>
    [Fact]
    public async Task Php_level_max_collection_coverage_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(LevelMaxCoverageFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The snapshot is the always-on guarantee — it runs regardless of the PHP toolchain.
        await Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");

        // The phpstan --level max type-check gate (parity with TS/Python, #496) skips (or hard-fails
        // under KOINE_REQUIRE_CONFORMANCE) when no phpstan toolchain is present.
        var typeCheck = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(typeCheck.ToolchainAvailable, NoToolchainNotice);
        typeCheck.Ok.ShouldBeTrue(string.Join("\n", typeCheck.Errors));
    }

    // -----------------------------------------------------------------------
    // #588: phpstan --level max coverage one level DEEPER than #583 — a NESTED
    // collection (a collection whose element, or a Map whose value, is itself a
    // collection). Before #588, `DocType` built a nested collection's inner type
    // with `Map(...)` (the native hint) rather than recursing through `DocType`,
    // so `Map<String, List<OrderLine>>` emitted `array<string, array>` and
    // `List<List<Int>>` emitted `list<array>` — the inner `array` is untyped and
    // `phpstan --level max` rejects it (`missingType.iterableValue`). The
    // validator allows a collection as a List/Set/Map element/value, so the shape
    // is reachable; #583's single-level fixtures simply never reached it. The
    // non-scalar `Map` key (`Sku`) still renders `array<Sku, …>`, which phpstan
    // --level max accepts (#583), so the key position is unchanged — only the
    // nested *value/element* recursion is fixed.
    // -----------------------------------------------------------------------

    /// <summary>
    /// A fixture reaching nested-collection fields across all three <c>DocType</c> consumers: a value
    /// object whose getters return a <c>Map&lt;String, List&lt;OrderLine&gt;&gt;</c>, a
    /// <c>List&lt;List&lt;Int&gt;&gt;</c>, and a <c>Map&lt;Sku, List&lt;Int&gt;&gt;</c> (non-scalar key +
    /// nested value); an entity stored field that is a nested collection (<c>@var</c> path); and a
    /// domain event whose payload nests a list inside a map (#583 host).
    /// </summary>
    internal const string NestedCollectionFixture = """
        context Grouping {
          /// A stock-keeping unit (a non-scalar map key).
          value Sku {
            code: String
          }

          /// A line of an order.
          value OrderLine {
            product:  String
            quantity: Int
            invariant quantity >= 1 "a line needs at least one unit"
          }

          /// A grouping value object whose fields nest a collection inside a collection:
          /// a Map whose value is a List, a List of Lists, and a non-scalar-keyed Map
          /// whose value is a List — each exercising DocType recursion one level deeper.
          value OrderGrouping {
            byCustomer: Map<String, List<OrderLine>>
            buckets:    List<List<Int>>
            bySku:      Map<Sku, List<Int>>
          }

          aggregate Sales root Order {
            /// Raised when orders are grouped — its payload nests a List inside a Map.
            event OrdersGrouped {
              orderId:    OrderId
              byCustomer: Map<String, List<OrderLine>>
            }

            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              grouped:  Map<String, List<OrderLine>>
            }
          }
        }
        """;

    /// <summary>
    /// Emitted PHP for <see cref="NestedCollectionFixture"/> must match its reviewed snapshot AND pass
    /// <c>phpstan analyse --level max</c> — the #588 gate over nested collection type arguments. Before
    /// #588 the inner <c>array</c> of <c>array&lt;string, array&gt;</c> / <c>list&lt;array&gt;</c> was
    /// untyped (<c>missingType.iterableValue</c>); after #588 it recurses to
    /// <c>array&lt;string, list&lt;OrderLine&gt;&gt;</c> / <c>list&lt;list&lt;int&gt;&gt;</c>.
    /// </summary>
    [Fact]
    public async Task Php_nested_collection_typing_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(NestedCollectionFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The snapshot is the always-on guarantee — it runs regardless of the PHP toolchain.
        await Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");

        // The phpstan --level max type-check gate (parity with TS/Python, #496) skips (or hard-fails
        // under KOINE_REQUIRE_CONFORMANCE) when no phpstan toolchain is present.
        var typeCheck = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(typeCheck.ToolchainAvailable, NoToolchainNotice);
        typeCheck.Ok.ShouldBeTrue(string.Join("\n", typeCheck.Errors));
    }

    // -----------------------------------------------------------------------
    // #601: a Decimal/value-object collection fold (`.sum`/`.min`/`.max`) lowers
    // to a runtime static call — `\Koine\Runtime\Decimal::sum/min/max(...)`. Those
    // helpers were never defined on the runtime `Decimal` class, so every emitted
    // fold fataled at runtime (`Call to undefined method ...::sum()`) and tripped
    // `phpstan --level max` (`staticMethod.notFound`, plus a `return.type` because
    // an undefined static returns `mixed`). #496's fixtures contained no fold, so
    // the gate never reached this path. This fixture exercises all three folds over
    // a `Decimal` projection so the phpstan gate now covers them.
    // -----------------------------------------------------------------------

    /// <summary>
    /// A value object whose derived members fold a <c>List&lt;Money&gt;</c> down to a
    /// <c>Decimal</c> via <c>.sum</c>/<c>.min</c>/<c>.max</c> — the #601 path, each lowering to a
    /// runtime <c>Decimal::sum/min/max</c> static call.
    /// </summary>
    internal const string DecimalFoldFixture = """
        context Shop {
          /// A monetary amount in a currency. Never negative.
          value Money {
            amount:   Decimal
            currency: String
            invariant amount >= 0 "an amount cannot be negative"
          }

          /// A cart whose totals fold its money lines (the #601 Decimal-fold path).
          value Cart {
            items:    List<Money>
            total:    Decimal = items.sum(m => m.amount)
            cheapest: Decimal = items.min(m => m.amount)
            priciest: Decimal = items.max(m => m.amount)
          }
        }
        """;

    /// <summary>
    /// Emitted PHP for <see cref="DecimalFoldFixture"/> must match its reviewed snapshot AND pass
    /// <c>phpstan analyse --level max</c> — the #601 gate over Decimal collection folds. Before #601
    /// the emitted <c>Decimal::sum/min/max</c> calls resolved to nothing (<c>staticMethod.notFound</c>);
    /// after it, the runtime declares the three static helpers and the folds type-check.
    /// </summary>
    [Fact]
    public async Task Php_decimal_fold_coverage_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(DecimalFoldFixture, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The snapshot is the always-on guarantee — it runs regardless of the PHP toolchain.
        await Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");

        // The phpstan --level max type-check gate (parity with TS/Python, #496) skips (or hard-fails
        // under KOINE_REQUIRE_CONFORMANCE) when no phpstan toolchain is present.
        var typeCheck = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(typeCheck.ToolchainAvailable, NoToolchainNotice);
        typeCheck.Ok.ShouldBeTrue(string.Join("\n", typeCheck.Errors));
    }
}
