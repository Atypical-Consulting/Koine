using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R16.2 snapshot coverage for the TypeScript backend, mirroring <c>EmitterSnapshotTests</c>
/// (Verify). The fixture is representative of the spec's semantics — a value object with an
/// invariant, an entity with a command + invariant + factory, a smart enum (string-literal union +
/// const member object + Match/Switch/TryFrom*), and a <c>Range</c> — so the reviewed
/// <c>.verified.txt</c> locks in the emitted TypeScript exactly as the C# snapshots do. The
/// <c>place</c> command both returns a <c>result</c> and <c>emit</c>s an event reusing the same
/// <c>id</c>, so the snapshot also locks the C#-parity <c>const __result</c> hoist (issue #60).
/// </summary>
public class TypeScriptSnapshotTests
{
    /// <summary>A representative cross-section of the domain DSL, emitted to TypeScript.</summary>
    internal const string Fixture = """
        context Sales {
          /// A monetary amount in a currency. Never negative.
          value Money {
            amount:   Decimal
            currency: Currency
            invariant amount >= 0 "an amount cannot be negative"
          }

          /// Currencies, carrying their symbol and minor-unit count.
          enum Currency(symbol: String, decimals: Int) {
            EUR("€", 2)
            USD("$", 2)
          }

          /// The lifecycle of an order.
          enum OrderStatus { Draft, Placed, Cancelled }

          /// A line of an order; its subtotal is derived (Money scaled by quantity).
          value OrderLine {
            product:   ProductId
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

              command place(): OrderId {
                requires status == Draft "only a draft order can be placed"
                status -> Placed
                emit OrderPlaced(orderId: id, lineCount: lines.count)
                result id
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

    /// <summary>The emitted TypeScript for the fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task TypeScript_fixture_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// An <c>Int</c>-field value object with a demand-generated scalar <c>multiply</c>/<c>divide</c>
    /// (issue #938). No existing snapshot exercises this path — every prior TS fixture scales a
    /// <c>Decimal</c> field, so the <c>Math.round</c>-vs-<c>Math.trunc</c> choice was invisible to the
    /// snapshot suite. This pins the emitted <c>Math.trunc(...)</c> so a future regression back to
    /// <c>Math.round</c> (or drift to <c>Math.floor</c>) fails the snapshot.
    /// </summary>
    internal const string IntFieldScalarFixture = """
        context Shop {
          value Weight {
            grams: Int
          }
          entity Parcel identified by ParcelId {
            total: Weight
          }
          readmodel Split from Parcel {
            half: Weight = total / 2
            tenth: Weight = total * 1.5
          }
        }
        """;

    /// <summary>The emitted <c>Int</c>-field <c>multiply</c>/<c>divide</c> must match its reviewed snapshot.</summary>
    [Fact]
    public Task Int_field_scalar_multiply_and_divide_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(IntFieldScalarFixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
