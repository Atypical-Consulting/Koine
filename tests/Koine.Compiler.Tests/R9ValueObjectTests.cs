using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R9 — Richer Value Objects (enum data, quantities, ranges).</summary>
public class R9ValueObjectTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static (Assembly Asm, string Files) Compile(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm, TestSupport.Render(result.Files));
    }

    // ======================================================================
    // R9.1 — Enum members carrying associated data
    // ======================================================================

    private const string CurrencySrc = """
        context Money {
          enum Currency(symbol: String, decimals: Int) {
            EUR("€", 2)
            USD("$", 2)
            GBP("£", 2)
          }
        }
        """;

    [Fact]
    public void Enum_with_associated_data_exposes_it_as_properties()
    {
        var (asm, _) = Compile(CurrencySrc);
        var currency = asm.GetType("Money.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        currency.GetProperty("Symbol")!.GetValue(eur).ShouldBe("€");
        currency.GetProperty("Decimals")!.GetValue(eur).ShouldBe(2);
        currency.GetProperty("Name")!.GetValue(eur).ShouldBe("EUR");   // base smart-enum API intact
        currency.GetProperty("Value")!.GetValue(eur).ShouldBe(0);
    }

    [Fact]
    public void Enum_with_associated_data_keeps_value_equality()
    {
        var (asm, _) = Compile(CurrencySrc);
        var currency = asm.GetType("Money.Currency")!;
        var fromName = currency.GetMethod("FromName")!.Invoke(null, new object[] { "USD" });
        var usd = TestSupport.EnumValue(currency, "USD");
        usd.Equals(fromName).ShouldBeTrue();
    }

    [Fact]
    public void Bare_enum_emission_is_unchanged()
    {
        // A v0 bare enum still emits the simple ctor and no associated properties.
        var (_, files) = Compile("context C { enum S { A, B, C } }");
        files.ShouldContain("private S(string name, int value)");
        files.ShouldContain("public static readonly S A = new(\"A\", 0);");
        files.ShouldNotContain("public string Symbol");
    }

    [Fact]
    public void Bare_and_comma_free_member_lists_both_parse()
    {
        Diagnose("context C { enum A { X, Y, Z } }").ShouldBeEmpty();
        Diagnose("""context C { enum B(n: Int) { X(1) Y(2) Z(3) } }""").ShouldBeEmpty();
    }

    [Fact]
    public void Enum_member_arity_mismatch_is_reported()
    {
        const string src = """context C { enum E(a: Int, b: Int) { X(1) } }""";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EnumMemberArity);
    }

    [Fact]
    public void Bare_member_with_args_but_no_signature_is_reported()
    {
        const string src = """context C { enum E { X(1) } }""";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EnumMemberArity);
    }

    [Fact]
    public void Enum_member_arg_type_mismatch_is_reported()
    {
        const string src = """context C { enum E(n: Int) { X("nope") } }""";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EnumMemberArgType);
    }

    [Fact]
    public void Enum_associated_field_colliding_with_reserved_name_is_reported()
    {
        const string src = """context C { enum E(value: Int) { X(1) } }""";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EnumReservedAssociatedField);
    }

    [Fact]
    public void Enum_with_decimal_associated_data_compiles()
    {
        var (asm, _) = Compile("""context C { enum Rate(factor: Decimal) { Low(0.5) High(1.5) } }""");
        var rate = asm.GetType("C.Rate")!;
        rate.GetProperty("Factor")!.GetValue(TestSupport.EnumValue(rate, "Low")).ShouldBe(0.5m);
    }

    // ======================================================================
    // R9.3 — Range/interval value objects
    // ======================================================================

    [Fact]
    public void Range_field_emits_the_runtime_range_and_compiles()
    {
        var (asm, files) = Compile("context Booking { value BookingPeriod { period: Range<Instant> } }");
        files.ShouldContain("Koine/Runtime/Range.cs");
        var period = asm.GetType("Booking.BookingPeriod")!;
        period.GetProperty("Period")!.PropertyType.Name.ShouldBe("Range`1");
    }

    [Fact]
    public void Range_runtime_is_not_emitted_when_unused()
    {
        var (_, files) = Compile("context C { value V { n: Int } }");
        files.ShouldNotContain("Koine/Runtime/Range.cs");
    }

    [Fact]
    public void Range_containment_and_min_le_max_invariant_behave()
    {
        var (asm, _) = Compile("context Booking { value BookingPeriod { period: Range<Instant> } }");
        var rangeT = asm.GetType("Koine.Runtime.Range`1")!.MakeGenericType(typeof(DateTimeOffset));

        var start = new DateTimeOffset(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
        var end = start.AddDays(10);
        var range = Activator.CreateInstance(rangeT, start, end);

        var contains = rangeT.GetMethod("Contains")!;
        ((bool)contains.Invoke(range, new object[] { start.AddDays(5) })!).ShouldBeTrue();
        ((bool)contains.Invoke(range, new object[] { end.AddDays(1) })!).ShouldBeFalse();

        // start > end violates the construction invariant.
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(rangeT, end, start));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Range_overlaps_behaves()
    {
        var (asm, _) = Compile("context C { value Band { span: Range<Int> } }");
        var rangeT = asm.GetType("Koine.Runtime.Range`1")!.MakeGenericType(typeof(int));
        var a = Activator.CreateInstance(rangeT, 1, 5);
        var b = Activator.CreateInstance(rangeT, 5, 9);
        var c = Activator.CreateInstance(rangeT, 6, 9);
        var overlaps = rangeT.GetMethod("Overlaps")!;
        ((bool)overlaps.Invoke(a, new[] { b })!).ShouldBeTrue();   // touch at 5
        ((bool)overlaps.Invoke(a, new[] { c })!).ShouldBeFalse();
    }

    [Fact]
    public void Range_over_non_orderable_type_is_reported()
    {
        Diagnose("context C { value V { p: Range<String> } }").ShouldContain(d => d.Code == DiagnosticCodes.RangeNotOrderable);
        Diagnose("context C { value W { amt: Decimal }  value V { p: Range<W> } }").ShouldContain(d => d.Code == DiagnosticCodes.RangeNotOrderable);
    }

    [Fact]
    public void Range_without_a_type_argument_is_reported()
    {
        Diagnose("context C { value V { p: Range } }").ShouldContain(d => d.Code == DiagnosticCodes.GenericArity);
    }

    // ======================================================================
    // R9.2 — Quantity value objects with unit-checked arithmetic
    // ======================================================================

    private const string WeightSrc = """
        context C {
          enum MassUnit { Gram, Kilogram }
          quantity Weight {
            amount: Decimal
            unit:   MassUnit
            invariant amount >= 0  "weight cannot be negative"
          }
        }
        """;

    private static object Weight(Assembly asm, decimal amount, string unit)
    {
        var weight = asm.GetType("C.Weight")!;
        var massUnit = asm.GetType("C.MassUnit")!;
        return Activator.CreateInstance(weight, amount, TestSupport.EnumValue(massUnit, unit))!;
    }

    [Fact]
    public void Quantity_same_unit_addition_works()
    {
        var (asm, _) = Compile(WeightSrc);
        var weight = asm.GetType("C.Weight")!;
        var add = weight.GetMethod("op_Addition", new[] { weight, weight })!;

        var sum = add.Invoke(null, new[] { Weight(asm, 2.0m, "Gram"), Weight(asm, 3.0m, "Gram") });
        weight.GetProperty("Amount")!.GetValue(sum).ShouldBe(5.0m);
    }

    [Fact]
    public void Quantity_mixed_unit_addition_is_prevented()
    {
        var (asm, _) = Compile(WeightSrc);
        var weight = asm.GetType("C.Weight")!;
        var add = weight.GetMethod("op_Addition", new[] { weight, weight })!;

        var ex = Should.Throw<TargetInvocationException>(() =>
            add.Invoke(null, new[] { Weight(asm, 1.0m, "Gram"), Weight(asm, 1.0m, "Kilogram") }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Quantity_scalar_multiplication_preserves_the_unit()
    {
        var (asm, _) = Compile(WeightSrc);
        var weight = asm.GetType("C.Weight")!;
        var mul = weight.GetMethod("op_Multiply", new[] { weight, typeof(int) })!;

        var scaled = mul.Invoke(null, [Weight(asm, 2.0m, "Gram"), 3]);
        weight.GetProperty("Amount")!.GetValue(scaled).ShouldBe(6.0m);
        TestSupport.EnumValue(asm.GetType("C.MassUnit")!, "Gram")
            .Equals(weight.GetProperty("Unit")!.GetValue(scaled)).ShouldBeTrue();
    }

    [Fact]
    public void Quantity_invariant_is_still_enforced()
    {
        var (asm, _) = Compile(WeightSrc);
        var ex = Should.Throw<TargetInvocationException>(() => Weight(asm, -1.0m, "Gram"));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Quantity_without_a_unit_is_reported()
    {
        const string src = "context C { quantity Q { amount: Decimal } }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.QuantityUnitCardinality);
    }

    [Fact]
    public void Quantity_without_an_amount_is_reported()
    {
        const string src = "context C { enum U { A, B }  quantity Q { unit: U } }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.QuantityAmountCardinality);
    }

    [Fact]
    public void Quantity_with_an_extra_member_is_reported()
    {
        const string src = "context C { enum U { A, B }  quantity Q { amount: Decimal  unit: U  note: String } }";
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.QuantityMemberNotAllowed);
    }

    [Fact]
    public void Quantity_is_usable_as_a_field_name()
    {
        // `quantity` stays a soft keyword (OrderLine.quantity etc. keep working).
        Diagnose("context C { value Line { quantity: Int } }").ShouldBeEmpty();
    }

    [Fact]
    public void Plain_value_with_numeric_and_enum_is_not_a_quantity()
    {
        // Money-shaped value (numeric + enum) must NOT get forced unit-checked operators.
        var (_, files) = Compile("context C { enum Cur { EUR }  value Money { amount: Decimal  currency: Cur } }");
        files.ShouldNotContain("cannot add quantities of different units");
    }

    // ======================================================================
    // Regressions found by the R9 review
    // ======================================================================

    [Fact]
    public void Enum_with_negative_associated_value_compiles()
    {
        var (asm, _) = Compile("context C { enum Temp(offset: Int) { Cold(-5) Warm(5) } }");
        var t = asm.GetType("C.Temp")!;
        t.GetProperty("Offset")!.GetValue(TestSupport.EnumValue(t, "Cold")).ShouldBe(-5);
    }

    [Fact]
    public void Enum_associated_field_of_non_literal_type_is_reported()
    {
        Diagnose("context C { enum E(items: List<String>) { A(1) } }").ShouldContain(d => d.Code == DiagnosticCodes.EnumAssociatedFieldType);
        Diagnose("context C { value V { x: Int }  enum E(v: V) { A(1) } }").ShouldContain(d => d.Code == DiagnosticCodes.EnumAssociatedFieldType);
    }

    [Fact]
    public void Quantity_with_an_int_amount_is_reported()
    {
        // An Int amount would integer-divide / truncate when scaled; amounts must be Decimal.
        Diagnose("context C { enum U { A }  quantity Q { amount: Int  unit: U } }").ShouldContain(d => d.Code == DiagnosticCodes.QuantityAmountCardinality);
    }

    [Fact]
    public void Quantity_may_declare_a_derived_projection()
    {
        const string src = "context C { enum U { A, B }  quantity Q { amount: Decimal  unit: U  doubled: Decimal = amount * 2 } }";
        Diagnose(src).ShouldBeEmpty();
        var (asm, files) = Compile(src);
        files.ShouldContain("public decimal Doubled\n        => ");
        asm.GetType("C.Q").ShouldNotBeNull();
    }

    [Fact]
    public void User_type_named_like_a_builtin_generic_is_reported()
    {
        Diagnose("context C { value Range { lo: Int } }").ShouldContain(d => d.Code == DiagnosticCodes.ReservedTypeName);
        Diagnose("context C { value List { x: Int } }").ShouldContain(d => d.Code == DiagnosticCodes.ReservedTypeName);
    }
}
