using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Snapshot coverage for the Python backend, the Python analogue of
/// <see cref="TypeScriptSnapshotTests"/>. <see cref="Fixture"/> is the full Phase-1 domain
/// (value objects + a quantity + a Range value object + smart enums + an entity with a command and
/// a factory + events + a repository) and is the SINGLE shared fixture every later Python task
/// extends — each construct re-accepts this snapshot as its emitter lands.
/// <para>
/// <b>Dependency-ordering rule (load-bearing):</b> the regular value objects that emit in this task
/// reference ONLY primitives, <c>Decimal</c>, <c>Instant</c>, <c>Range</c>, and OTHER non-quantity
/// value objects — never an enum, a quantity, or an entity. Enum references live on the ENTITY
/// (<c>Order.status: OrderStatus</c>). So while only regular value objects emit (Task 5), the emitted
/// tree has no dangling imports and is <c>mypy --strict</c> clean; as later tasks emit
/// quantities/enums/entities/events the same fixture stays coherent.
/// </para>
/// <para>
/// The <c>quantity Weight</c> and its unit <c>enum MassUnit</c> stay in the fixture but are NOT
/// emitted yet: a quantity's unit member is required to be enum-typed (R9.2 / <c>KOI0904</c>), which
/// is the one unavoidable value-object → enum edge, so a quantity must emit alongside its unit enum
/// in the next task to keep this task's tree dangling-import-free and strict-clean.
/// </para>
/// </summary>
public class PythonSnapshotTests
{
    /// <summary>The full Phase-1 domain, emitted to Python. Shared by Tasks 5–9 (one growing snapshot).</summary>
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
          /// (A quantity's unit must be enum-typed per R9.2, so this lands with its enum in a later task.)
          quantity Weight {
            amount: Decimal
            unit:   MassUnit
          }

          /// A line of an order; its subtotal is derived (unit price scaled by quantity).
          /// `product` is a plain String (not a *Id) so this VO references only leaves and other
          /// value objects — no edge to an enum, a quantity, or an entity (keeps Task-5 mypy-clean).
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
            /// Raised when an order is opened by the factory (R6/R8).
            event OrderOpened {
              orderId:   OrderId
              customer:  CustomerId
              lineCount: Int
            }

            /// Raised when a draft order is placed (R6).
            event OrderPlaced {
              orderId:   OrderId
              lineCount: Int
            }

            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft
              total:    Money = lines.sum(l => l.subtotal)

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

          /// A flat projection of an order for a summary board (R12.3): direct fields copy the
          /// source, the derived `lineCount` translates its projection rooted at the source.
          readmodel OrderSummary from Order {
            id
            customer
            status
            total
            lineCount: Int = lines.count
          }
        }
        """;

    /// <summary>The emitted Python for the fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task Python_fixture_emits_expected_python()
    {
        var result = new KoineCompiler().Compile(Fixture, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
