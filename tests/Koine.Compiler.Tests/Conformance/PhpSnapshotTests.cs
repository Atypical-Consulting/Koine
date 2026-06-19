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
}
