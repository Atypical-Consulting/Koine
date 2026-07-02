using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// R12 (CQRS application layer) snapshot coverage for the TypeScript backend, the TS counterpart of
/// the C# emitter's application-service/read-model/query slice. The fixture carries a <c>service</c>
/// with use cases (one returning a result, one fire-and-forget), a <c>readmodel … from</c> with both
/// direct and derived fields (so the projection mapper has real runtime behavior), and a
/// <c>query</c> — so the reviewed <c>.verified.txt</c> locks in the emitted application-service
/// interface, the read-model DTO + projection function, and the query DTO exactly.
/// </summary>
public class TypeScriptCqrsSnapshotTests
{
    /// <summary>A focused CQRS cross-section (service + use cases, read model, query), emitted to TypeScript.</summary>
    internal const string Fixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }

          value OrderLine {
            sku:      String
            quantity: Int
            invariant quantity >= 1 "a line needs at least one unit"
          }

          aggregate Order root Order {
            entity Order identified by OrderId {
              customer: CustomerId
              lines:    List<OrderLine>
              status:   OrderStatus = Draft
            }
          }

          /// R12.2 — the application-service boundary (IOrderingService).
          service OrderingService {
            /// Places a new order, returning its identity.
            usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
            /// Cancels an order (fire-and-forget).
            usecase CancelOrder(order: OrderId)
          }

          /// R12.3 — a flat read model + projection mapper for an order board.
          readmodel OrderSummary from Order {
            id
            customer
            status
            lineCount: Int = lines.count
          }

          /// R12.4 — a query DTO over the read model.
          query OrdersByStatus(status: OrderStatus): List<OrderSummary>
        }
        """;

    /// <summary>The emitted TypeScript for the CQRS fixture must match its reviewed snapshot.</summary>
    [Fact]
    public Task TypeScript_cqrs_fixture_emits_expected_typescript()
    {
        var result = new KoineCompiler().Compile(Fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
