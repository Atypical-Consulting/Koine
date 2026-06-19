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
    public Task Php_fixture_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(Fixture, new PhpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on syntax gate: runs php -l when a PHP interpreter is available.
        // Reported as INCONCLUSIVE (no assertion) when no interpreter is present locally.
        _ = TestSupport.SyntaxCheckPhp(result.Files);

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
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
    public Task Php_entity_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(EntityFixture, new PhpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on syntax gate: INCONCLUSIVE when no PHP interpreter is available locally.
        _ = TestSupport.SyntaxCheckPhp(result.Files);

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
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
    public Task Php_end_to_end_emits_expected_php()
    {
        var result = new KoineCompiler().Compile(EndToEndFixture, new PhpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on syntax gate: INCONCLUSIVE when no PHP interpreter is available locally.
        _ = TestSupport.SyntaxCheckPhp(result.Files);

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
