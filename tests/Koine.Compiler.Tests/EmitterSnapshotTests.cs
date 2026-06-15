using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Snapshot test over the emitted C#. Changes to generated output must be
/// reviewed deliberately by updating the .verified.txt snapshot.
/// </summary>
public class EmitterSnapshotTests
{
    [Fact]
    public Task Billing_fixture_emits_expected_csharp()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        Assert.True(result.Success);

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// R8.2 AC: a snapshot makes the factory access-modifier change reviewable — the
    /// root's constructor becomes <c>private</c> and creation goes through the emitted
    /// <c>public static</c> factory (with auto-generated identity, preconditions, a
    /// same-named-parameter auto-bind, and a creation event).
    /// </summary>
    [Fact]
    public Task Factory_fixture_emits_expected_csharp()
    {
        const string fixture = """
            context Sales {
              value OrderLine { product: ProductId  quantity: Int }
              enum OrderStatus { Draft, Placed }
              aggregate Order root Order {
                entity Order identified by OrderId {
                  customer: CustomerId
                  lines:    List<OrderLine>
                  status:   OrderStatus = Draft

                  create forCustomer(customer: CustomerId, lines: List<OrderLine>) {
                    requires !lines.isEmpty "cannot open an empty order"
                    emit OrderOpened(orderId: id, customer: customer, lineCount: lines.count)
                  }
                }
                event OrderOpened {
                  orderId:   OrderId
                  customer:  CustomerId
                  lineCount: Int
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// R10: makes the generated specification class, domain-service class, and policy
    /// handler seam reviewable in one snapshot.
    /// </summary>
    [Fact]
    public Task R10_fixture_emits_expected_csharp()
    {
        const string fixture = """
            context Sales {
              value Order { lineCount: Int  total: Int }
              spec IsLarge on Order = lineCount > 10 || total > 1000

              value Money { amount: Decimal }
              service Pricing {
                operation discounted(amount: Money, rate: Decimal): Money = amount * rate
              }

              event OrderPlaced { orderId: OrderId }
              aggregate Inventory root Inventory {
                entity Inventory identified by InventoryId {
                  reserved: Int
                  command reserve(order: OrderId) { reserved -> 1 }
                }
              }
              policy ReserveStock when OrderPlaced then Inventory.reserve(order: orderId)
            }
            """;

        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// R11: makes the selectable identity strategies (guid/sequence/natural), the
    /// versioned root's concurrency token, and the configured repository contract
    /// (restricted operations + finders) reviewable in one snapshot.
    /// </summary>
    [Fact]
    public Task R11_fixture_emits_expected_csharp()
    {
        const string fixture = """
            context Sales {
              value OrderLine { product: ProductId  quantity: Int }
              entity Product identified by Sku       as natural(String) { name: String }
              entity Invoice identified by InvoiceNo as sequence        { amount: Int }
              aggregate Order root Order versioned {
                repository {
                  operations: add, getById
                  find byCustomer(customer: CustomerId): List<Order>
                  find mostRecent(customer: CustomerId): Order
                }
                entity Order identified by OrderId {
                  customer: CustomerId
                  lines:    List<OrderLine>
                }
              }
            }
            """;

        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// R12: makes the per-context unit of work, the application-service interface
    /// (use cases), the read-model record + projection mapper, and the query DTOs +
    /// shared IQueryHandler reviewable in one snapshot.
    /// </summary>
    [Fact]
    public Task R12_fixture_emits_expected_csharp()
    {
        const string fixture = """
            context Sales {
              enum OrderStatus { Draft, Placed, Shipped }
              value OrderLine { product: ProductId  quantity: Int }
              aggregate Order root Order {
                entity Order identified by OrderId {
                  customer: CustomerId
                  lines:    List<OrderLine>
                  status:   OrderStatus = Draft
                }
              }

              service OrderService {
                usecase PlaceOrder(customer: CustomerId, lines: List<OrderLine>): OrderId
                usecase CancelOrder(order: OrderId)
              }

              readmodel OrderSummary from Order {
                id
                customer
                status
                lineCount: Int = lines.count
              }

              query OrdersByStatus(status: OrderStatus): List<OrderSummary>
              query OrderById(id: OrderId): OrderSummary
            }
            """;

        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }

    /// <summary>
    /// R13: makes the module sub-namespaces/folders, precise cross-module and
    /// cross-context (import + qualified) usings reviewable in one snapshot.
    /// </summary>
    [Fact]
    public Task R13_fixture_emits_expected_csharp()
    {
        const string fixture = """
            context Billing {
              enum Currency { EUR, USD }
              module Pricing  { value Money { amount: Decimal  currency: Currency } }
              module Invoicing { entity Invoice identified by InvoiceId { total: Money } }
            }
            context Sales {
              import Billing.{ Money }
              entity Quote identified by QuoteId { price: Money  freight: Billing.Money }
            }
            """;

        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        return Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
