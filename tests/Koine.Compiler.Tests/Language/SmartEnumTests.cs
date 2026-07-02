using System.Reflection;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Enums emit as self-contained "smart enums": static instances with value
/// equality, <c>Name</c>/<c>Value</c>, <c>All</c>, and <c>FromName</c>/<c>FromValue</c>.
/// </summary>
public class SmartEnumTests
{
    private const string Src = """
        context Shop {
          enum OrderStatus { Draft, Placed, Shipped, Cancelled }
          entity Order identified by OrderId {
            note:   String
            status: OrderStatus = Draft
          }
        }
        """;

    private static Assembly Compile()
    {
        var result = new KoineCompiler().Compile(Src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    [Fact]
    public void Smart_enum_exposes_name_value_all_and_equality()
    {
        var asm = Compile();
        var status = asm.GetType("Shop.OrderStatus")!;

        var draft = TestSupport.EnumValue(status, "Draft");
        var shipped = TestSupport.EnumValue(status, "Shipped");

        status.GetProperty("Name")!.GetValue(draft).ShouldBe("Draft");
        status.GetProperty("Value")!.GetValue(draft).ShouldBe(0);
        status.GetProperty("Value")!.GetValue(shipped).ShouldBe(2);
        draft.ToString().ShouldBe("Draft");

        // value equality + FromName round-trip
        var fromName = status.GetMethod("FromName")!.Invoke(null, new object[] { "Draft" });
        draft.Equals(fromName).ShouldBeTrue();

        var all = (System.Collections.IEnumerable)status.GetProperty("All")!.GetValue(null)!;
        all.Cast<object>().Count().ShouldBe(4);
    }

    [Fact]
    public void Enum_default_applies_when_omitted()
    {
        var asm = Compile();
        var order = asm.GetType("Shop.Order")!;
        var status = asm.GetType("Shop.OrderStatus")!;
        var orderId = asm.GetType("Shop.OrderId")!;
        var id = orderId.GetMethod("New")!.Invoke(null, null);

        // status omitted (null) -> coalesces to Draft before guards/assignment.
        var o = Activator.CreateInstance(order, id, "hello", null);
        var draft = TestSupport.EnumValue(status, "Draft");
        draft.Equals(order.GetProperty("Status")!.GetValue(o)).ShouldBeTrue();

        // explicit value is honored.
        var shipped = TestSupport.EnumValue(status, "Shipped");
        var o2 = Activator.CreateInstance(order, id, "hello", shipped);
        shipped.Equals(order.GetProperty("Status")!.GetValue(o2)).ShouldBeTrue();
    }
}
