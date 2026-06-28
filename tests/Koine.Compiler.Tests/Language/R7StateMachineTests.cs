using System.Collections;
using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R7 — Entity Lifecycle &amp; State Machines.</summary>
public class R7StateMachineTests
{
    private const string Fixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Shipped, Cancelled }
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              status:      OrderStatus = Draft
              lines:       List<OrderLine>
              isFullyPaid: Bool

              states status {
                Draft  -> Placed, Cancelled
                Placed -> Shipped when isFullyPaid
                Placed -> Cancelled
                Shipped
                Cancelled
              }

              command place  { status -> Placed }
              command ship   { status -> Shipped }
              command cancel { status -> Cancelled }
            }
          }
        }
        """;

    private static Assembly Compile()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    // ctor: (OrderId id, IReadOnlyList<OrderLine> lines, bool isFullyPaid, OrderStatus? status = null)
    private static object NewOrder(Assembly asm, bool fullyPaid)
    {
        var order = asm.GetType("Sales.Order")!;
        var orderId = asm.GetType("Sales.OrderId")!;
        var line = asm.GetType("Sales.OrderLine")!;
        var productId = asm.GetType("Sales.ProductId")!;
        var lines = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(line))!;
        lines.Add(Activator.CreateInstance(line, productId.GetMethod("New")!.Invoke(null, null), 1));
        return Activator.CreateInstance(order, orderId.GetMethod("New")!.Invoke(null, null), lines, fullyPaid, null)!;
    }

    private static string StatusName(Assembly asm, object order) =>
        (string)asm.GetType("Sales.OrderStatus")!.GetProperty("Name")!.GetValue(
            asm.GetType("Sales.Order")!.GetProperty("Status")!.GetValue(order))!;

    [Fact]
    public void Fixture_is_valid_and_compiles() { Diagnose(Fixture).ShouldBeEmpty(); Compile(); }

    [Fact]
    public void Legal_transition_succeeds()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;
        var o = NewOrder(asm, fullyPaid: true);

        order.GetMethod("Place")!.Invoke(o, null);   // Draft -> Placed (legal)
        StatusName(asm, o).ShouldBe("Placed");
        order.GetMethod("Ship")!.Invoke(o, null);    // Placed -> Shipped, isFullyPaid (legal)
        StatusName(asm, o).ShouldBe("Shipped");
    }

    [Fact]
    public void Illegal_transition_throws()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;
        var o = NewOrder(asm, fullyPaid: true);

        // From Draft, ship is illegal (only Placed -> Shipped).
        var ex = Should.Throw<TargetInvocationException>(() => order.GetMethod("Ship")!.Invoke(o, null));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
        StatusName(asm, o).ShouldBe("Draft"); // unchanged
    }

    [Fact]
    public void Guarded_transition_is_blocked_when_guard_is_false()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;
        var o = NewOrder(asm, fullyPaid: false);

        order.GetMethod("Place")!.Invoke(o, null);   // Draft -> Placed
        // Placed -> Shipped requires isFullyPaid, which is false here.
        var ex = Should.Throw<TargetInvocationException>(() => order.GetMethod("Ship")!.Invoke(o, null));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
        StatusName(asm, o).ShouldBe("Placed");
    }

    [Fact]
    public void Terminal_state_rejects_outgoing_transition()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;
        var o = NewOrder(asm, fullyPaid: true);

        order.GetMethod("Cancel")!.Invoke(o, null);  // Draft -> Cancelled (terminal)
        StatusName(asm, o).ShouldBe("Cancelled");
        // From Cancelled, nothing is legal.
        Should.Throw<TargetInvocationException>(() => order.GetMethod("Place")!.Invoke(o, null));
    }

    // ---- diagnostics -------------------------------------------------------

    [Fact]
    public void States_on_a_non_enum_field_is_reported()
    {
        const string src = "context C {\n  entity E identified by EId {\n    n: Int\n    states n { A -> B }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.InvalidStatesBinding);
    }

    [Fact]
    public void States_on_unknown_field_is_reported()
    {
        const string src = "context C {\n  enum S { A }\n  entity E identified by EId {\n    s: S = A\n    states bogus { A -> A }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.InvalidStatesBinding);
    }

    [Fact]
    public void Unknown_state_member_is_reported()
    {
        const string src = "context C {\n  enum S { A, B }\n  entity E identified by EId {\n    s: S = A\n    states s { A -> Nope }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownState && d.Message.Contains("Nope"));
    }

    [Fact]
    public void Transition_to_unreachable_state_is_reported()
    {
        // No rule targets Draft, so a command transitioning to Draft can never be legal.
        const string src =
            "context C {\n" +
            "  enum S { Draft, Done }\n" +
            "  entity E identified by EId {\n" +
            "    s: S = Draft\n" +
            "    states s { Draft -> Done  Done }\n" +
            "    command reset { s -> Draft }\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnreachableTransition);
    }

    [Fact]
    public void Guard_referencing_unknown_identifier_is_reported()
    {
        const string src =
            "context C {\n  enum S { A, B }\n  entity E identified by EId {\n    s: S = A\n    states s { A -> B when bogus }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownField);
    }

    [Fact]
    public void Duplicate_states_block_for_one_field_is_reported()
    {
        const string src =
            "context C {\n  enum S { A, B }\n  entity E identified by EId {\n    s: S = A\n    states s { A -> B }\n    states s { A -> B }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateStatesBlock);
    }

    // ---- guard codegen regressions ----------------------------------------

    private static Assembly CompileSource(string src)
    {
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    // An OR guard must bind below the `&&` that joins it to the source-state check;
    // otherwise an illegal transition from a non-source state would slip through when
    // only the looser disjunct is true.
    [Fact]
    public void Or_guard_does_not_bypass_the_source_state_check()
    {
        const string src = """
            context Sales {
              enum St { Draft, Placed, Shipped }
              entity E identified by EId {
                status: St = Draft
                paid: Bool
                vip:  Bool
                states status {
                  Draft  -> Placed
                  Placed -> Shipped when paid || vip
                }
                command place { status -> Placed }
                command ship  { status -> Shipped }
              }
            }
            """;
        var asm = CompileSource(src);
        var e = asm.GetType("Sales.E")!;
        var eid = asm.GetType("Sales.EId")!;
        // ctor: (EId id, bool paid, bool vip, St? status = null) — defaulted status moves last.
        var o = Activator.CreateInstance(e, eid.GetMethod("New")!.Invoke(null, null), false, true, null)!;

        // From Draft (not Placed), Ship must throw even though vip is true.
        var ex = Should.Throw<TargetInvocationException>(() => e.GetMethod("Ship")!.Invoke(o, null));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    // A state-rule guard is validated against entity members only; a command parameter
    // sharing a guard member's name must NOT shadow the persisted state in the guard.
    [Fact]
    public void Guard_reads_the_entity_member_not_a_shadowing_command_parameter()
    {
        const string src = """
            context Sales {
              enum St { Draft, Placed }
              entity E identified by EId {
                status: St = Draft
                ready:  Bool
                states status { Draft -> Placed when ready }
                command go(ready: Bool) { status -> Placed }
              }
            }
            """;
        var asm = CompileSource(src);
        var e = asm.GetType("Sales.E")!;
        var eid = asm.GetType("Sales.EId")!;
        // ctor: (EId id, bool ready, St? status = null). Member Ready = true.
        var o = Activator.CreateInstance(e, eid.GetMethod("New")!.Invoke(null, null), true, null)!;

        // Guard `when ready` means the member (true), so Go(false) still transitions.
        e.GetMethod("Go")!.Invoke(o, new object?[] { false });
        var status = e.GetProperty("Status")!.GetValue(o);
        ((string)asm.GetType("Sales.St")!.GetProperty("Name")!.GetValue(status)!).ShouldBe("Placed");
    }
}
