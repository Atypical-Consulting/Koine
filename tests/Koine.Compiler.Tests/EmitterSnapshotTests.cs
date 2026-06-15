using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;
using VerifyXunit;

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

        return Verifier.Verify(TestSupport.Render(result.Files))
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

        return Verifier.Verify(TestSupport.Render(result.Files))
            .UseDirectory("Snapshots");
    }
}
