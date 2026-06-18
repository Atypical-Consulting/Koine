using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Command bodies can return a value — opt-in via a declared return type plus a
/// terminal <c>result</c> clause. Existing void commands stay unchanged.
/// </summary>
public class CommandReturnTests
{
    // A command that creates/cancels and hands the created/affected id back: the
    // canonical "a command returns the id of what it created" DDD idiom. The result
    // (`id`) is also carried by the emitted event, so it is hoisted once.
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

    // A command whose result is computed over post-mutation state and is NOT referenced
    // by any event: the simple inline `return <expr>;` path.
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

    // A result whose rendered form (`Tax`) is a PREFIX of a sibling emit argument's rendering
    // (`TaxRate`): hoisting must substitute ONLY the argument that is the SAME expression, never
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

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, string OrderCs) CompileFixture(string fixture)
    {
        var result = new KoineCompiler().Compile(fixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        var orderCs = result.Files.Single(f => f.RelativePath == "Sales/Order.cs").Contents;
        return (asm!, orderCs);
    }

    // ---- parsing -----------------------------------------------------------

    [Fact]
    public void Command_return_type_and_result_clause_parse_and_validate()
    {
        Assert.Empty(Diagnose(IdResultFixture));
        Assert.Empty(Diagnose(ComputedResultFixture));
    }

    [Fact]
    public void Void_command_is_still_valid_with_no_return_type_or_result()
    {
        const string src = """
            context C {
              enum S { A, B }
              entity E identified by EId {
                s: S = A
                command go { s -> B }
              }
            }
            """;
        Assert.Empty(Diagnose(src));
    }

    [Fact]
    public void Result_is_usable_as_an_ordinary_member_name()
    {
        // `result` is a soft keyword: it must still work as a plain field name.
        const string src = """
            context C {
              value V { a: Int  result: Int = a + 1 }
            }
            """;
        Assert.Empty(Diagnose(src));
    }

    // ---- emit (text shape) -------------------------------------------------

    [Fact]
    public void Declared_return_type_renders_a_typed_method_signature()
    {
        var (_, orderCs) = CompileFixture(IdResultFixture);
        Assert.Contains("public OrderId Cancel()", orderCs);
    }

    [Fact]
    public void Result_referenced_by_an_emit_payload_is_hoisted_once()
    {
        var (_, orderCs) = CompileFixture(IdResultFixture);
        // Computed once, before the event references it, then returned.
        Assert.Contains("var __result = Id;", orderCs);
        Assert.Contains("_domainEvents.Add(new OrderCancelled(__result));", orderCs);
        Assert.Contains("return __result;", orderCs);
    }

    [Fact]
    public void Computed_result_not_referenced_by_an_event_is_returned_inline()
    {
        var (_, orderCs) = CompileFixture(ComputedResultFixture);
        Assert.Contains("public int Bump(int by)", orderCs);
        Assert.Contains("return Total;", orderCs); // post-mutation state, no hoist
        Assert.DoesNotContain("__result", orderCs);
    }

    [Fact]
    public void Result_that_is_a_prefix_of_a_sibling_emit_arg_does_not_splice_the_sibling()
    {
        var (_, orderCs) = CompileFixture(PrefixCollisionFixture);
        // Only the `tax` arg (the same expression as the result) is hoisted; the sibling `taxRate`
        // arg is left intact — NOT mangled into `__resultRate` by a blind substring replace.
        Assert.Contains("var __result = Tax;", orderCs);
        Assert.Contains("_domainEvents.Add(new Quoted(__result, TaxRate));", orderCs);
        Assert.DoesNotContain("__resultRate", orderCs);
        Assert.Contains("return __result;", orderCs);
    }

    // ---- emit (Roslyn behaviour) -------------------------------------------

    [Fact]
    public void A_command_returns_the_id_of_what_it_created()
    {
        var (asm, _) = CompileFixture(IdResultFixture);
        var order = asm.GetType("Sales.Order")!;
        var orderId = asm.GetType("Sales.OrderId")!;

        var id = orderId.GetMethod("New")!.Invoke(null, null);
        var o = Activator.CreateInstance(order, id, null)!; // (OrderId id, OrderStatus? status = null)

        var returned = order.GetMethod("Cancel")!.Invoke(o, null);

        // The command hands back the aggregate's own id (the same one the event carries).
        Assert.Equal(o.GetType().GetProperty("Id")!.GetValue(o), returned);
        Assert.Equal(id, returned);
    }

    [Fact]
    public void Returned_value_is_computed_over_post_mutation_state()
    {
        var (asm, _) = CompileFixture(ComputedResultFixture);
        var order = asm.GetType("Sales.Order")!;
        var orderId = asm.GetType("Sales.OrderId")!;

        // ctor: (OrderId id, OrderStatus? status = null, int total = 0)
        var o = Activator.CreateInstance(order, orderId.GetMethod("New")!.Invoke(null, null), null, 0)!;
        var returned = order.GetMethod("Bump")!.Invoke(o, new object?[] { 7 });

        Assert.Equal(7, returned);                                       // 0 + 7, the post-mutation total
        Assert.Equal(7, order.GetProperty("Total")!.GetValue(o));
    }

    [Fact]
    public void A_returning_command_still_records_its_event_after_the_guard()
    {
        var (asm, _) = CompileFixture(IdResultFixture);
        var order = asm.GetType("Sales.Order")!;
        var orderId = asm.GetType("Sales.OrderId")!;

        var o = Activator.CreateInstance(order, orderId.GetMethod("New")!.Invoke(null, null), null)!;
        order.GetMethod("Cancel")!.Invoke(o, null);

        var events = (System.Collections.IEnumerable)order.GetProperty("DomainEvents")!.GetValue(o)!;
        Assert.Single(events.Cast<object>());
    }

    // ---- diagnostics -------------------------------------------------------

    [Fact]
    public void Result_clause_without_a_declared_return_type_is_reported()
    {
        const string src = """
            context C {
              entity E identified by EId {
                n: Int
                command go { result n }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.ResultWithoutReturnType);
    }

    [Fact]
    public void Declared_return_type_with_no_result_clause_is_reported()
    {
        const string src = """
            context C {
              entity E identified by EId {
                n: Int
                command go(): Int { n -> 1 }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.MissingCommandResult);
    }

    [Fact]
    public void More_than_one_result_clause_is_reported()
    {
        const string src = """
            context C {
              entity E identified by EId {
                n: Int
                command go(): Int { result n  result n }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.MissingCommandResult);
    }

    [Fact]
    public void Result_of_an_incompatible_type_is_reported()
    {
        const string src = """
            context C {
              entity E identified by EId {
                name: String
                command go(): Int { result name }
              }
            }
            """;
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.CommandResultMismatch);
    }
}
