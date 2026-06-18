using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The TypeScript emitter must mirror the C# emitter's <c>result</c>/<c>emit</c> sub-expression
/// hoisting (<see cref="CommandReturnTests"/>): when a command's <c>result</c> expression also
/// appears in an <c>emit</c> payload it is bound once to a <c>const __result</c> local and
/// referenced from both the event construction and the return path, rather than re-translated.
/// This locks the cross-emitter parity called for in issue #60.
/// </summary>
public class TypeScriptCommandReturnTests
{
    // The result (`id`) is also carried by the emitted event, so it must be hoisted once — the
    // TypeScript analogue of CommandReturnTests.IdResultFixture.
    private const string IdResultFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }
          event OrderCancelled { orderId: OrderId }
          aggregate Order root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft

              command cancel(): OrderId {
                requires status != Cancelled "already cancelled"
                status -> Cancelled
                emit OrderCancelled(orderId: id)
                result id
              }
            }
          }
        }
        """;

    // A command whose result is computed over post-mutation state and is NOT referenced by any
    // event: the simple inline `return <expr>;` path with no hoisting.
    private const string ComputedResultFixture = """
        context Sales {
          enum OrderStatus { Draft, Placed }
          aggregate Order root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft
              total: Int = 0

              command bump(by: Int): Int {
                total -> total + by
                result total
              }
            }
          }
        }
        """;

    // A result whose rendered form (`this.tax`) is a PREFIX of a sibling emit argument's rendering
    // (`this.taxRate`): hoisting must substitute ONLY the argument that is the SAME expression, never
    // splice the substring out of the unrelated sibling (a substring-replace bug found reviewing #60).
    private const string PrefixCollisionFixture = """
        context Sales {
          event Quoted { amount: Int  rate: Int }
          aggregate Order root Order {
            entity Order identified by OrderId {
              tax:     Int = 0
              taxRate: Int = 0
              command quote(): Int {
                emit Quoted(amount: tax, rate: taxRate)
                result tax
              }
            }
          }
        }
        """;

    private static string CompileOrderTs(string fixture)
    {
        var result = new KoineCompiler().Compile(fixture, new TypeScriptEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath == "Sales/Order.ts").Contents;
    }

    [Fact]
    public void Result_referenced_by_an_emit_payload_is_hoisted_once()
    {
        var orderTs = CompileOrderTs(IdResultFixture);
        // Computed once, before the event references it, then returned.
        Assert.Contains("const __result = this.id;", orderTs);
        Assert.Contains("this._domainEvents.push(new OrderCancelled(__result));", orderTs);
        Assert.Contains("return __result;", orderTs);
    }

    [Fact]
    public void Computed_result_not_referenced_by_an_event_is_returned_inline()
    {
        var orderTs = CompileOrderTs(ComputedResultFixture);
        Assert.Contains("return this.total;", orderTs); // post-mutation state, no hoist
        Assert.DoesNotContain("const __result = this.total", orderTs); // `total` is not hoisted
    }

    [Fact]
    public void Result_that_is_a_prefix_of_a_sibling_emit_arg_does_not_splice_the_sibling()
    {
        var orderTs = CompileOrderTs(PrefixCollisionFixture);
        // Only the `tax` arg (the same expression as the result) is hoisted; the sibling `taxRate`
        // arg is left intact — NOT mangled into `__resultRate` by a blind substring replace.
        Assert.Contains("const __result = this.tax;", orderTs);
        Assert.Contains("this._domainEvents.push(new Quoted(__result, this.taxRate));", orderTs);
        Assert.DoesNotContain("__resultRate", orderTs);
        Assert.Contains("return __result;", orderTs);
    }
}
