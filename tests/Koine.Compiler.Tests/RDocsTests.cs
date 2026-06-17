using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Living-documentation emitter (R-Docs): snapshots the Mermaid-in-Markdown output for a state
/// machine, the strategic context map, an aggregate class diagram, and the integration-event flow,
/// plus the simple billing baseline. Changes to docs output must be reviewed via the .verified.txt.
/// </summary>
public class RDocsTests
{
    /// <summary>The Ordering fixture exercises the state machine, aggregate, repository, and events.</summary>
    private const string OrderingFixture = """
        /// Ordering bounded context — placing and pricing customer orders.
        context Ordering version 1 {
          enum Currency { EUR, USD, GBP }
          enum RefundStatus { None, Pending, Cancelled }
          enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

          value Money {
            amount: Decimal
            currency: Currency
            invariant amount >= 0 "an amount cannot be negative"
          }

          integration event OrderPlaced {
            orderId: OrderId
            customer: CustomerId
            total: Decimal
            placedAt: Instant
          }

          publishes OrderPlaced

          aggregate Order root Order versioned {
            repository {
              operations: getById, add, update
              find byCustomer(customer: CustomerId): List<Order>
              find mostRecent(customer: CustomerId): Order
            }

            event OrderOpened { orderId: OrderId  customer: CustomerId  lineCount: Int }
            event OrderSubmitted { orderId: OrderId  lineCount: Int }

            value OrderLine {
              product: ProductId
              quantity: Int
              unitPrice: Money
              lineTotal: Money = unitPrice * quantity
              payable: Money = if quantity >= 10 then lineTotal * 0.9 else lineTotal
              invariant quantity >= 1 "an order line needs at least one unit"
            }

            entity Order identified by OrderId {
              customer: CustomerId
              lines: List<OrderLine>
              status: OrderStatus = Draft
              refund: RefundStatus = None
              submittedAt: Instant?

              total: Money = lines.sum(l => l.payable)
              lineCount: Int = lines.count

              isPlaced: Bool = submittedAt.isPresent
              isCancelled: Bool = status == Cancelled

              invariant lines.all(l => l.quantity >= 1) "every line needs a positive quantity"
              invariant status == Draft when lines.isEmpty

              states status {
                Draft -> Submitted, Cancelled
                Submitted -> Paid, Cancelled
                Paid -> Shipped, Cancelled
                Shipped
                Cancelled
              }

              command submit {
                requires status == Draft "only a draft order can be submitted"
                requires !lines.isEmpty "cannot submit an empty order"
                status -> Submitted
                submittedAt -> now
                emit OrderSubmitted(orderId: id, lineCount: lines.count)
              }

              command cancel {
                requires status != Shipped "a shipped order cannot be cancelled"
                status -> Cancelled
              }

              create open(customer: CustomerId, lines: List<OrderLine>) {
                requires !lines.isEmpty "cannot open an empty order"
                emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
              }
            }
          }

          service OrderingService {
            usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
            usecase CancelOrder(order: OrderId)
          }
        }
        """;

    /// <summary>A self-contained strategic map: every named context is also declared here.</summary>
    private const string ContextMapFixture = """
        context Catalog   { enum Currency { EUR, USD }  value Sku { code: String } }
        context Ordering  { enum Currency { EUR, USD }  value Order { sku: Sku } }
        context Shipping  { value Parcel { n: Int } }
        context Customers { value Account { ref: String } }
        context Payments  { value Receipt { n: Int } }
        context Legacy    { value GatewayResult { code: String } }

        contextmap {
          Catalog   <-> Ordering : shared-kernel { Currency }
          Catalog    -> Shipping : conformist
          Customers  -> Shipping : customer-supplier
          Ordering   -> Shipping : open-host
          Ordering   -> Payments : open-host
          Shipping  <-> Payments : partnership
          Legacy     -> Payments : anti-corruption-layer
            acl { Legacy.GatewayResult -> Payments.Receipt }
        }
        """;

    /// <summary>
    /// A guarded state machine: the transition guard carries comparison/logical operators
    /// (<c>&gt;</c>, <c>&lt;=</c>, <c>&amp;&amp;</c>) that must be HTML-escaped in the Mermaid
    /// stateDiagram-v2 label or the diagram is corrupted.
    /// </summary>
    private const string GuardedStateMachineFixture = """
        context Ordering {
          enum OrderStatus { Draft, Submitted, Done }

          aggregate Order root Order {
            entity Order identified by OrderId {
              total: Decimal
              status: OrderStatus = Draft

              states status {
                Draft -> Submitted when total > 0 && total <= 100
                Submitted -> Done
                Done
              }

              command submit {
                requires status == Draft "only a draft can be submitted"
                status -> Submitted
              }
            }
          }
        }
        """;

    /// <summary>A minimal three-context integration-event flow: one publisher, two subscribers.</summary>
    private const string IntegrationEventFixture = """
        context Ordering {
          publishes OrderPlaced
          integration event OrderPlaced { orderId: OrderId  total: Decimal }
        }
        context Shipping {
          subscribes Ordering.OrderPlaced
        }
        context Payments {
          subscribes Ordering.OrderPlaced
        }
        """;

    [Fact]
    public Task State_machine_emits_mermaid_state_diagram()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("ordering.koi", OrderingFixture) }, new DocsEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public Task Guarded_state_machine_escapes_operators_in_mermaid_label()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("guarded.koi", GuardedStateMachineFixture) }, new DocsEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public Task Context_map_emits_mermaid_flowchart()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("map.koi", ContextMapFixture) }, new DocsEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public Task Integration_event_flow_emits_mermaid_flowchart()
    {
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("events.koi", IntegrationEventFixture) }, new DocsEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }

    [Fact]
    public void Empty_context_renders_a_placeholder_note()
    {
        // A context that declares no types or behavior must not emit a bare heading-only page.
        const string src = "context Empty { }\n";
        var result = new KoineCompiler().Compile(
            new[] { new SourceFile("empty.koi", src) }, new DocsEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var page = result.Files.Single(f => f.RelativePath == "docs/Empty.md").Contents;
        Assert.Contains("_This bounded context has no declared types yet._", page);
    }

    [Fact]
    public Task Billing_fixture_emits_baseline_docs()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new DocsEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files)).UseDirectory("Snapshots");
    }
}
