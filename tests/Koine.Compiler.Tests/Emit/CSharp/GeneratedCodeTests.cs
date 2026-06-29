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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    [Fact]
    public void Generated_csharp_compiles()
    {
        var asm = CompileFixture();
        asm.GetType("Billing.Money").ShouldNotBeNull();
        asm.GetType("Billing.Order").ShouldNotBeNull();
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
        ok.ShouldNotBeNull();

        // Money(-1, EUR) throws DomainInvariantViolationException (wrapped by reflection).
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(money, -1m, eur));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
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
        b.ShouldBe(a);
        b!.GetHashCode().ShouldBe(a!.GetHashCode());
        ReferenceEquals(a, b).ShouldBeFalse();
        c.ShouldNotBe(a);

        // The == / != operators (defined on the ValueObject base) compare by value too.
        var op = money.BaseType!.GetMethod("op_Equality")!;
        ((bool)op.Invoke(null, new[] { a, b })!).ShouldBeTrue();
        ((bool)op.Invoke(null, new[] { a, c })!).ShouldBeFalse();
    }

    [Fact]
    public void Value_object_is_a_class_deriving_ValueObject_not_a_record()
    {
        var asm = CompileFixture();
        var money = asm.GetType("Billing.Money")!;

        money.BaseType!.Name.ShouldBe("ValueObject");
        (money.IsSealed && money.GetMethods().Any(m => m.Name == "<Clone>$")).ShouldBeFalse("value objects must not be compiler-generated records");
    }

    [Fact]
    public void Boolean_conditional_is_emitted_without_a_redundant_ternary()
    {
        // `if cond then true else false` must lower to the bare condition, not `cond ? true : false`.
        const string src =
            "context C {\n  enum Tier { Bronze, Gold }\n" +
            "  value V {\n    tier: Tier\n    isGold: Bool = if tier == Gold then true else false\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var file = result.Files.Single(f => f.RelativePath.EndsWith("V.cs"));
        file.Contents.ShouldContain("IsGold\n        => Tier == Tier.Gold;");
        file.Contents.ShouldNotContain("? true : false");

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
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

        c1!.Equals(c2).ShouldBeTrue(); // equal by identity only
        c2.GetHashCode().ShouldBe(c1.GetHashCode());
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
        amount.ShouldBe(15m); // 5 * 3
    }

    [Fact]
    public void Root_entity_implements_IAggregateRoot()
    {
        var asm = CompileFixture();
        var order = asm.GetType("Billing.Order")!;
        order.GetInterfaces().ShouldContain(i => i.Name == "IAggregateRoot");
    }

    [Fact]
    public void Keyword_field_names_emit_compiling_code()
    {
        // `base` is a C# keyword; it must be escaped (@base) so the output compiles.
        const string src =
            "context C {\n  value Weighted {\n    base: Decimal\n    factor: Decimal\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue();

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        asm.GetType("C.Weighted").ShouldNotBeNull();
    }

    [Fact]
    public void Member_less_value_object_compiles()
    {
        // GetEqualityComponents must stay a valid iterator (yield break) with no fields.
        const string src = "context Demo {\n  value Empty { }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        asm.GetType("Demo.Empty").ShouldNotBeNull();
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
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var quote = result.Files.Single(f => f.RelativePath == "Sales/ValueObjects/Quote.cs").Contents;
        quote.ShouldContain("using Shared;");

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        asm.GetType("Sales.Quote").ShouldNotBeNull();
    }

    [Fact]
    public void Value_object_with_collections_compares_by_content()
    {
        const string src = "context Cart {\n  value Tags {\n    labels: List<String>\n    codes:  Set<Int>\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        var tags = asm.GetType("Cart.Tags")!;

        // ctor: (IReadOnlyList<string> labels, IReadOnlySet<int> codes).
        var t1 = Activator.CreateInstance(tags, new List<string> { "a", "b" }, new HashSet<int> { 1, 2 })!;
        var sameContent = Activator.CreateInstance(tags, new List<string> { "a", "b" }, new HashSet<int> { 2, 1 })!;
        var listReordered = Activator.CreateInstance(tags, new List<string> { "b", "a" }, new HashSet<int> { 1, 2 })!;

        // List is order-sensitive, Set is order-insensitive — both compared by content, not reference.
        sameContent.ShouldBe(t1);
        sameContent.GetHashCode().ShouldBe(t1.GetHashCode());
        listReordered.ShouldNotBe(t1);
    }

    [Fact]
    public void Reemitting_is_byte_identical()
    {
        var compiler = new KoineCompiler();
        var first = compiler.Compile(TestSupport.BillingFixture, new CSharpEmitter()).Files;
        var second = compiler.Compile(TestSupport.BillingFixture, new CSharpEmitter()).Files;

        TestSupport.Render(second).ShouldBe(TestSupport.Render(first));
    }

    [Fact]
    public void Matches_invariant_emits_a_timeout_bounded_regex()
    {
        // A `matches` invariant must lower to a TIMEOUT-bounded Regex.IsMatch so a
        // catastrophic-backtracking pattern in a value object cannot become a ReDoS sink
        // (issue #641). The emitted guard carries `RegexOptions.None, TimeSpan.From...`.
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("Email.cs")).Contents;
        email.ShouldContain("Regex.IsMatch(");
        email.ShouldContain("RegexOptions.None, TimeSpan.From");

        // The bounded form still behaves identically for normal input: a valid value is
        // accepted and an invalid one is rejected (Roslyn compile + execute).
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        var type = asm.GetType("C.Email")!;

        Activator.CreateInstance(type, "a@b.co").ShouldNotBeNull();
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(type, "not-an-email"));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }
}
