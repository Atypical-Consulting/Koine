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

    // A result (`tax`) whose rendered form is a PREFIX of a sibling emit argument (`taxRate`), and
    // also appears as a sub-expression of a compound argument (`taxRate + tax`) and as a SECOND
    // whole argument (`doubled`): hoisting must substitute `__result` for EVERY whole-argument match
    // and leave the prefix sibling and the compound's inner `tax` untouched — never splice the
    // substring out (a substring-replace bug found reviewing #60).
    private const string PrefixCollisionFixture = """
        context Sales {
          event Quoted { amount: Int  rate: Int  doubled: Int }
          aggregate Order root Order {
            entity Order identified by OrderId {
              tax:     Int = 0
              taxRate: Int = 0
              command quote(): Int {
                emit Quoted(amount: tax, rate: taxRate + tax, doubled: tax)
                result tax
              }
            }
          }
        }
        """;

    private static string CompileOrderTs(string fixture)
    {
        var result = new KoineCompiler().Compile(fixture, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath == "Sales/Order.ts").Contents;
    }

    [Fact]
    public void Result_referenced_by_an_emit_payload_is_hoisted_once()
    {
        var orderTs = CompileOrderTs(IdResultFixture);
        // Computed once, before the event references it, then returned.
        orderTs.ShouldContain("const __result = this.id;");
        orderTs.ShouldContain("this._domainEvents.push(new OrderCancelled(__result));");
        orderTs.ShouldContain("return __result;");
    }

    [Fact]
    public void Computed_result_not_referenced_by_an_event_is_returned_inline()
    {
        var orderTs = CompileOrderTs(ComputedResultFixture);
        orderTs.ShouldContain("return this.total;"); // post-mutation state, no hoist
        orderTs.ShouldNotContain("__result");     // parity with the C# sibling; no stray hoist
    }

    [Fact]
    public void Result_that_is_a_prefix_of_a_sibling_emit_arg_does_not_splice_the_sibling()
    {
        var orderTs = CompileOrderTs(PrefixCollisionFixture);
        // Every WHOLE-argument reuse of the result (`amount`, `doubled`) becomes `__result`; the
        // sibling `rate: taxRate + tax` is left intact — neither mangled into `__resultRate` by a
        // substring replace, nor its inner `tax` spliced (only whole arguments are substituted).
        orderTs.ShouldContain("const __result = this.tax;");
        orderTs.ShouldContain("this._domainEvents.push(new Quoted(__result, (this.taxRate + this.tax), __result));");
        orderTs.ShouldNotContain("__resultRate");
        orderTs.ShouldContain("return __result;");
    }
}
