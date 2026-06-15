using System.Reflection;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Meta-tests: emit C# for the fixture, compile it in-memory with Roslyn, then
/// exercise the generated types via reflection to assert DDD semantics.
/// </summary>
public class GeneratedCodeTests
{
    private static Assembly CompileFixture()
    {
        var result = new KoineCompiler().Compile(TestSupport.BillingFixture, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    [Fact]
    public void Generated_csharp_compiles()
    {
        var asm = CompileFixture();
        Assert.NotNull(asm.GetType("Billing.Money"));
        Assert.NotNull(asm.GetType("Billing.Order"));
    }

    [Fact]
    public void Money_rejects_negative_amount_and_accepts_zero()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;
        var currency = asm.GetType("Billing.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        // Money(0, EUR) succeeds.
        var ok = Activator.CreateInstance(money, 0m, eur);
        Assert.NotNull(ok);

        // Money(-1, EUR) throws DomainInvariantViolationException (wrapped by reflection).
        var ex = Assert.Throws<TargetInvocationException>(
            () => Activator.CreateInstance(money, -1m, eur));
        Assert.Equal("DomainInvariantViolationException", ex.InnerException!.GetType().Name);
    }

    [Fact]
    public void Value_object_has_value_equality()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;
        var currency = asm.GetType("Billing.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        var usd = TestSupport.EnumValue(currency, "USD");
        var a = Activator.CreateInstance(money, 10m, eur);
        var b = Activator.CreateInstance(money, 10m, eur);
        var c = Activator.CreateInstance(money, 10m, usd); // differs by a component

        // Structural equality from the ValueObject base (not a record, not reference equality).
        Assert.Equal(a, b);
        Assert.Equal(a!.GetHashCode(), b!.GetHashCode());
        Assert.False(ReferenceEquals(a, b));
        Assert.NotEqual(a, c);

        // The == / != operators (defined on the ValueObject base) compare by value too.
        var op = money.BaseType!.GetMethod("op_Equality")!;
        Assert.True((bool)op.Invoke(null, new[] { a, b })!);
        Assert.False((bool)op.Invoke(null, new[] { a, c })!);
    }

    [Fact]
    public void Value_object_is_a_class_deriving_ValueObject_not_a_record()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;

        Assert.Equal("ValueObject", money.BaseType!.Name);
        Assert.False(money.IsSealed && money.GetMethods().Any(m => m.Name == "<Clone>$"),
            "value objects must not be compiler-generated records");
    }

    [Fact]
    public void Boolean_conditional_is_emitted_without_a_redundant_ternary()
    {
        // `if cond then true else false` must lower to the bare condition, not `cond ? true : false`.
        const string src =
            "context C {\n  enum Tier { Bronze, Gold }\n" +
            "  value V {\n    tier: Tier\n    isGold: Bool = if tier == Gold then true else false\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var file = result.Files.Single(f => f.RelativePath.EndsWith("V.cs"));
        Assert.Contains("IsGold => Tier == Tier.Gold;", file.Contents);
        Assert.DoesNotContain("? true : false", file.Contents);

        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void Entity_equality_uses_only_identity()
    {
        var asm = CompileFixture();
        var customer = asm.GetType("Billing.Customer")!;
        var customerId = asm.GetType("Billing.CustomerId")!;
        var email = asm.GetType("Billing.Email")!;

        var id = Activator.CreateInstance(customerId, Guid.NewGuid());
        var mail = Activator.CreateInstance(email, "a@b.co");

        var c1 = Activator.CreateInstance(customer, id, "Alice", mail);
        var c2 = Activator.CreateInstance(customer, id, "Bob", mail); // different name, same id

        Assert.True(c1!.Equals(c2)); // equal by identity only
        Assert.Equal(c1.GetHashCode(), c2.GetHashCode());
    }

    [Fact]
    public void Derived_subtotal_scales_money_by_quantity()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;
        var currency = asm.GetType("Billing.Currency")!;
        var line = asm.GetType("Billing.OrderLine")!;
        var productId = asm.GetType("Billing.ProductId")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        var unitPrice = Activator.CreateInstance(money, 5m, eur);
        var pid = Activator.CreateInstance(productId, Guid.NewGuid());
        var orderLine = Activator.CreateInstance(line, pid, 3, unitPrice);

        var subtotal = line.GetProperty("Subtotal")!.GetValue(orderLine);
        var amount = (decimal)money.GetProperty("Amount")!.GetValue(subtotal)!;
        Assert.Equal(15m, amount); // 5 * 3
    }

    [Fact]
    public void Root_entity_implements_IAggregateRoot()
    {
        var asm = CompileFixture();
        var order = asm.GetType("Billing.Order")!;
        Assert.Contains(order.GetInterfaces(), i => i.Name == "IAggregateRoot");
    }

    [Fact]
    public void Keyword_field_names_emit_compiling_code()
    {
        // `base` is a C# keyword; it must be escaped (@base) so the output compiles.
        const string src =
            "context C {\n  value Weighted {\n    base: Decimal\n    factor: Decimal\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        Assert.True(result.Success);

        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        Assert.NotNull(asm.GetType("C.Weighted"));
    }

    [Fact]
    public void Member_less_value_object_compiles()
    {
        // GetEqualityComponents must stay a valid iterator (yield break) with no fields.
        const string src = "context Demo {\n  value Empty { }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        Assert.NotNull(asm.GetType("Demo.Empty"));
    }

    [Fact]
    public void Cross_context_reference_compiles()
    {
        // A value object referencing a type from another context imports it (R13.2); the
        // emitted C# carries a precise `using Shared;`.
        const string src =
            "context Shared {\n  value Money { amount: Decimal }\n}\n" +
            "context Sales {\n  import Shared.{ Money }\n  value Quote { price: Money }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var quote = result.Files.Single(f => f.RelativePath == "Sales/Quote.cs").Contents;
        Assert.Contains("using Shared;", quote);

        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        Assert.NotNull(asm.GetType("Sales.Quote"));
    }

    [Fact]
    public void Value_object_with_collections_compares_by_content()
    {
        const string src = "context Cart {\n  value Tags {\n    labels: List<String>\n    codes:  Set<Int>\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
        var tags = asm.GetType("Cart.Tags")!;

        // ctor: (IReadOnlyList<string> labels, IReadOnlySet<int> codes).
        var t1 = Activator.CreateInstance(tags, new List<string> { "a", "b" }, new HashSet<int> { 1, 2 })!;
        var sameContent = Activator.CreateInstance(tags, new List<string> { "a", "b" }, new HashSet<int> { 2, 1 })!;
        var listReordered = Activator.CreateInstance(tags, new List<string> { "b", "a" }, new HashSet<int> { 1, 2 })!;

        // List is order-sensitive, Set is order-insensitive — both compared by content, not reference.
        Assert.Equal(t1, sameContent);
        Assert.Equal(t1.GetHashCode(), sameContent.GetHashCode());
        Assert.NotEqual(t1, listReordered);
    }

    [Fact]
    public void Reemitting_is_byte_identical()
    {
        var compiler = new KoineCompiler();
        var first = compiler.Compile(TestSupport.BillingFixture, new CSharpEmitter()).Files;
        var second = compiler.Compile(TestSupport.BillingFixture, new CSharpEmitter()).Files;

        Assert.Equal(TestSupport.Render(first), TestSupport.Render(second));
    }
}
