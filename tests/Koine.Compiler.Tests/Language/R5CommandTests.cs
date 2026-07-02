using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R5 — Commands &amp; State Transitions.</summary>
public class R5CommandTests
{
    private const string Fixture = """
        context Sales {
          enum OrderStatus { Draft, Placed, Shipped, Cancelled }
          value OrderLine { product: ProductId  quantity: Int }
          aggregate Sales root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft
              lines:  List<OrderLine>

              invariant status == Draft when lines.isEmpty

              command place {
                requires !lines.isEmpty   "cannot place an empty order"
                requires status == Draft  "order already placed"
                status -> Placed
              }

              command cancel {
                requires status != Shipped "shipped orders cannot be cancelled"
                status -> Cancelled
              }
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

    private static object NewOrder(Assembly asm, bool withLine)
    {
        var order = asm.GetType("Sales.Order")!;
        var orderId = asm.GetType("Sales.OrderId")!;
        var line = asm.GetType("Sales.OrderLine")!;
        var productId = asm.GetType("Sales.ProductId")!;

        var lines = (System.Collections.IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(line))!;
        if (withLine)
        {
            lines.Add(Activator.CreateInstance(line, productId.GetMethod("New")!.Invoke(null, null), 1));
        }

        // ctor: (OrderId id, IReadOnlyList<OrderLine> lines, OrderStatus? status = null)
        return Activator.CreateInstance(order, orderId.GetMethod("New")!.Invoke(null, null), lines, null)!;
    }

    private static object Status(Assembly asm, string name) => TestSupport.EnumValue(asm.GetType("Sales.OrderStatus")!, name);

    [Fact]
    public void Fixture_is_valid_and_compiles()
    {
        Diagnose(Fixture).ShouldBeEmpty();
        Compile();
    }

    [Fact]
    public void Command_with_satisfied_precondition_transitions_state()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;
        var o = NewOrder(asm, withLine: true);

        order.GetMethod("Place")!.Invoke(o, null);
        Status(asm, "Placed").Equals(order.GetProperty("Status")!.GetValue(o)).ShouldBeTrue();
    }

    [Fact]
    public void Command_with_violated_precondition_throws_before_mutating()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;
        var o = NewOrder(asm, withLine: false); // empty -> place precondition fails

        var ex = Should.Throw<TargetInvocationException>(() => order.GetMethod("Place")!.Invoke(o, null));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
        // state unchanged (still Draft)
        Status(asm, "Draft").Equals(order.GetProperty("Status")!.GetValue(o)).ShouldBeTrue();
    }

    [Fact]
    public void Second_command_precondition_uses_post_transition_state()
    {
        var asm = Compile();
        var order = asm.GetType("Sales.Order")!;
        var o = NewOrder(asm, withLine: true);

        order.GetMethod("Place")!.Invoke(o, null);   // Draft -> Placed
        order.GetMethod("Cancel")!.Invoke(o, null);  // Placed -> Cancelled (allowed; not Shipped)
        Status(asm, "Cancelled").Equals(order.GetProperty("Status")!.GetValue(o)).ShouldBeTrue();
    }

    [Fact]
    public void Mutated_field_gets_private_setter_others_stay_get_only()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        var order = result.Files.Single(f => f.RelativePath == "Sales/Order.cs").Contents;
        order.ShouldContain("public OrderStatus Status { get; private set; }");
        // Not mutated: no private setter. A value-object collection is exposed read-only over a
        // mutable backing list so EF Core can materialize it (issue #171).
        order.ShouldContain("public IReadOnlyList<OrderLine> Lines => _lines;");
    }

    // ---- diagnostics -------------------------------------------------------

    [Fact]
    public void Transition_to_unknown_field_is_reported()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    command go { bogus -> 1 }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.InvalidTransitionTarget);
    }

    [Fact]
    public void Transition_to_derived_field_is_reported()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    doubled: Int = n + n\n    command go { doubled -> 5 }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.InvalidTransitionTarget);
    }

    [Fact]
    public void Transition_with_incompatible_type_is_reported()
    {
        const string src =
            "context C {\n  enum E2 { A }\n  entity E identified by EId {\n    s: E2 = A\n    command go { s -> 5 }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.TransitionTypeMismatch);
    }

    [Fact]
    public void Requires_referencing_unknown_identifier_is_reported()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    command go { requires bogus > 0 \"x\" }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.UnknownField);
    }

    [Fact]
    public void Command_parameter_is_resolvable_in_requires_and_transition()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    n: Int\n    command setN(v: Int) {\n      requires v > 0 \"positive\"\n      n -> v\n    }\n  }\n}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    // ---- regressions found by the R5 review --------------------------------

    [Fact]
    public void Re_check_validates_post_transition_state_not_a_shadowing_parameter()
    {
        // The command parameter shares the field's name; the post-transition
        // re-check must validate the new property value (105), not the arg (5).
        const string src =
            "context C {\n" +
            "  entity E identified by EId {\n" +
            "    count: Int\n" +
            "    invariant count <= 10\n" +
            "    command setCount(count: Int) { count -> count + 100 }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var e = asm.GetType("C.E")!;
        var eid = asm.GetType("C.EId")!;
        var inst = Activator.CreateInstance(e, eid.GetMethod("New")!.Invoke(null, null), 0);

        var ex = Should.Throw<TargetInvocationException>(() => e.GetMethod("SetCount")!.Invoke(inst, new object[] { 5 }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Lambda_parameter_shadowing_a_command_parameter_keeps_the_binding()
    {
        const string src =
            "context C {\n" +
            "  value Line { qty: Int }\n" +
            "  entity Cart identified by CartId {\n" +
            "    lines: List<Line>\n" +
            "    n: Int\n" +
            "    command go(v: Int) {\n" +
            "      requires lines.all(v => v.qty > 0) \"x\"\n" +  // lambda param shadows command param
            "      n -> v\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var cart = result.Files.Single(f => f.RelativePath == "C/Entities/Cart.cs").Contents;
        cart.ShouldContain("N = v;");  // not `N = default`/dropped binding

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Duplicate_command_name_is_reported()
    {
        const string src = "context C {\n  entity E identified by EId {\n    n: Int\n    command go { n -> 1 }\n    command go { n -> 2 }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateCommand);
    }

    [Fact]
    public void Duplicate_command_parameter_is_reported()
    {
        const string src = "context C {\n  entity E identified by EId {\n    n: Int\n    command go(v: Int, v: Int) { n -> v }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.DuplicateParameter);
    }

    [Fact]
    public void Policy_targeting_command_with_duplicate_parameters_does_not_crash_validation()
    {
        // Regression for #604: a policy reacting to a command whose parameters share a
        // byte-for-byte identical name crashed ValidatePolicies — its ToDictionary lookup
        // threw ArgumentException on the duplicate key, aborting the whole built-in pass
        // and losing the KOI0504 diagnostic. Validation must complete and still report it.
        const string src = "context Billing {\n  event Ev { amount: Decimal }\n  aggregate Books root LedgerEntry {\n    entity LedgerEntry identified by LedgerEntryId {\n      balance: Decimal\n      command record(amount: Decimal, amount: Decimal) { balance -> balance }\n    }\n  }\n  policy P when Ev then Books.record(amount: amount)\n}\n";
        IReadOnlyList<Diagnostic> diagnostics = Should.NotThrow(() => Diagnose(src));
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateParameter);
    }

    [Fact]
    public void Policy_targeting_command_with_case_only_duplicate_parameters_does_not_crash_validation()
    {
        // Sanity sibling of the #604 fix: case-only duplicates are flagged KOI0504 by the
        // OrdinalIgnoreCase dup-check while the ordinal parameter lookup keeps them distinct,
        // so the lookup must stay duplicate-tolerant for these too — no throw, KOI0504 present.
        const string src = "context Billing {\n  event Ev { amount: Decimal }\n  aggregate Books root LedgerEntry {\n    entity LedgerEntry identified by LedgerEntryId {\n      balance: Decimal\n      command record(amount: Decimal, Amount: Decimal) { balance -> balance }\n    }\n  }\n  policy P when Ev then Books.record(amount: amount)\n}\n";
        IReadOnlyList<Diagnostic> diagnostics = Should.NotThrow(() => Diagnose(src));
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.DuplicateParameter);
    }

    [Fact]
    public void Command_name_colliding_with_a_property_is_reported()
    {
        const string src = "context C {\n  enum S { Draft, Placed }\n  entity E identified by EId {\n    status: S = Draft\n    command status { status -> Placed }\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.CommandNameCollision);
    }

    [Fact]
    public void Command_and_requires_are_usable_as_field_names()
    {
        const string src = "context C {\n  value V {\n    command: Int\n    requires: Int\n  }\n}\n";
        Diagnose(src).ShouldBeEmpty();
    }
}
