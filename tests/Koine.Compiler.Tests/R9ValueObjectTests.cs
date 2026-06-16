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
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        Assert.True(asm is not null, "generated C# failed to compile:\n" + string.Join("\n", errors));
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

        Assert.Equal("€", currency.GetProperty("Symbol")!.GetValue(eur));
        Assert.Equal(2, currency.GetProperty("Decimals")!.GetValue(eur));
        Assert.Equal("EUR", currency.GetProperty("Name")!.GetValue(eur));   // base smart-enum API intact
        Assert.Equal(0, currency.GetProperty("Value")!.GetValue(eur));
    }

    [Fact]
    public void Enum_with_associated_data_keeps_value_equality()
    {
        var (asm, _) = Compile(CurrencySrc);
        var currency = asm.GetType("Money.Currency")!;
        var fromName = currency.GetMethod("FromName")!.Invoke(null, new object[] { "USD" });
        var usd = TestSupport.EnumValue(currency, "USD");
        Assert.True(usd.Equals(fromName));
    }

    [Fact]
    public void Bare_enum_emission_is_unchanged()
    {
        // A v0 bare enum still emits the simple ctor and no associated properties.
        var (_, files) = Compile("context C { enum S { A, B, C } }");
        Assert.Contains("private S(string name, int value)", files);
        Assert.Contains("public static readonly S A = new(\"A\", 0);", files);
        Assert.DoesNotContain("public string Symbol", files);
    }

    [Fact]
    public void Bare_and_comma_free_member_lists_both_parse()
    {
        Assert.Empty(Diagnose("context C { enum A { X, Y, Z } }"));
        Assert.Empty(Diagnose("""context C { enum B(n: Int) { X(1) Y(2) Z(3) } }"""));
    }

    [Fact]
    public void Enum_member_arity_mismatch_is_reported()
    {
        const string src = """context C { enum E(a: Int, b: Int) { X(1) } }""";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EnumMemberArity);
    }

    [Fact]
    public void Bare_member_with_args_but_no_signature_is_reported()
    {
        const string src = """context C { enum E { X(1) } }""";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EnumMemberArity);
    }

    [Fact]
    public void Enum_member_arg_type_mismatch_is_reported()
    {
        const string src = """context C { enum E(n: Int) { X("nope") } }""";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EnumMemberArgType);
    }

    [Fact]
    public void Enum_associated_field_colliding_with_reserved_name_is_reported()
    {
        const string src = """context C { enum E(value: Int) { X(1) } }""";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.EnumReservedAssociatedField);
    }

    [Fact]
    public void Enum_with_decimal_associated_data_compiles()
    {
        var (asm, _) = Compile("""context C { enum Rate(factor: Decimal) { Low(0.5) High(1.5) } }""");
        var rate = asm.GetType("C.Rate")!;
        Assert.Equal(0.5m, rate.GetProperty("Factor")!.GetValue(TestSupport.EnumValue(rate, "Low")));
    }

    // ======================================================================
    // R9.3 — Range/interval value objects
    // ======================================================================

    [Fact]
    public void Range_field_emits_the_runtime_range_and_compiles()
    {
        var (asm, files) = Compile("context Booking { value BookingPeriod { period: Range<Instant> } }");
        Assert.Contains("Koine/Runtime/Range.cs", files);
        var period = asm.GetType("Booking.BookingPeriod")!;
        Assert.Equal("Range`1", period.GetProperty("Period")!.PropertyType.Name);
    }

    [Fact]
    public void Range_runtime_is_not_emitted_when_unused()
    {
        var (_, files) = Compile("context C { value V { n: Int } }");
        Assert.DoesNotContain("Koine/Runtime/Range.cs", files);
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
        Assert.True((bool)contains.Invoke(range, new object[] { start.AddDays(5) })!);
        Assert.False((bool)contains.Invoke(range, new object[] { end.AddDays(1) })!);

        // start > end violates the construction invariant.
        var ex = Assert.Throws<TargetInvocationException>(() => Activator.CreateInstance(rangeT, end, start));
        Assert.Equal("DomainInvariantViolationException", ex.InnerException!.GetType().Name);
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
        Assert.True((bool)overlaps.Invoke(a, new[] { b })!);   // touch at 5
        Assert.False((bool)overlaps.Invoke(a, new[] { c })!);
    }

    [Fact]
    public void Range_over_non_orderable_type_is_reported()
    {
        Assert.Contains(Diagnose("context C { value V { p: Range<String> } }"),
            d => d.Code == DiagnosticCodes.RangeNotOrderable);
        Assert.Contains(Diagnose("context C { value W { amt: Decimal }  value V { p: Range<W> } }"),
            d => d.Code == DiagnosticCodes.RangeNotOrderable);
    }

    [Fact]
    public void Range_without_a_type_argument_is_reported()
    {
        Assert.Contains(Diagnose("context C { value V { p: Range } }"),
            d => d.Code == DiagnosticCodes.GenericArity);
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
        Assert.Equal(5.0m, weight.GetProperty("Amount")!.GetValue(sum));
    }

    [Fact]
    public void Quantity_mixed_unit_addition_is_prevented()
    {
        var (asm, _) = Compile(WeightSrc);
        var weight = asm.GetType("C.Weight")!;
        var add = weight.GetMethod("op_Addition", new[] { weight, weight })!;

        var ex = Assert.Throws<TargetInvocationException>(() =>
            add.Invoke(null, new[] { Weight(asm, 1.0m, "Gram"), Weight(asm, 1.0m, "Kilogram") }));
        Assert.Equal("DomainInvariantViolationException", ex.InnerException!.GetType().Name);
    }

    [Fact]
    public void Quantity_scalar_multiplication_preserves_the_unit()
    {
        var (asm, _) = Compile(WeightSrc);
        var weight = asm.GetType("C.Weight")!;
        var mul = weight.GetMethod("op_Multiply", new[] { weight, typeof(int) })!;

        var scaled = mul.Invoke(null, [Weight(asm, 2.0m, "Gram"), 3]);
        Assert.Equal(6.0m, weight.GetProperty("Amount")!.GetValue(scaled));
        Assert.True(TestSupport.EnumValue(asm.GetType("C.MassUnit")!, "Gram")
            .Equals(weight.GetProperty("Unit")!.GetValue(scaled)));
    }

    [Fact]
    public void Quantity_invariant_is_still_enforced()
    {
        var (asm, _) = Compile(WeightSrc);
        var ex = Assert.Throws<TargetInvocationException>(() => Weight(asm, -1.0m, "Gram"));
        Assert.Equal("DomainInvariantViolationException", ex.InnerException!.GetType().Name);
    }

    [Fact]
    public void Quantity_without_a_unit_is_reported()
    {
        const string src = "context C { quantity Q { amount: Decimal } }";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.QuantityUnitCardinality);
    }

    [Fact]
    public void Quantity_without_an_amount_is_reported()
    {
        const string src = "context C { enum U { A, B }  quantity Q { unit: U } }";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.QuantityAmountCardinality);
    }

    [Fact]
    public void Quantity_with_an_extra_member_is_reported()
    {
        const string src = "context C { enum U { A, B }  quantity Q { amount: Decimal  unit: U  note: String } }";
        Assert.Contains(Diagnose(src), d => d.Code == DiagnosticCodes.QuantityMemberNotAllowed);
    }

    [Fact]
    public void Quantity_is_usable_as_a_field_name()
    {
        // `quantity` stays a soft keyword (OrderLine.quantity etc. keep working).
        Assert.Empty(Diagnose("context C { value Line { quantity: Int } }"));
    }

    [Fact]
    public void Plain_value_with_numeric_and_enum_is_not_a_quantity()
    {
        // Money-shaped value (numeric + enum) must NOT get forced unit-checked operators.
        var (_, files) = Compile("context C { enum Cur { EUR }  value Money { amount: Decimal  currency: Cur } }");
        Assert.DoesNotContain("cannot add quantities of different units", files);
    }

    // ======================================================================
    // Regressions found by the R9 review
    // ======================================================================

    [Fact]
    public void Enum_with_negative_associated_value_compiles()
    {
        var (asm, _) = Compile("context C { enum Temp(offset: Int) { Cold(-5) Warm(5) } }");
        var t = asm.GetType("C.Temp")!;
        Assert.Equal(-5, t.GetProperty("Offset")!.GetValue(TestSupport.EnumValue(t, "Cold")));
    }

    [Fact]
    public void Enum_associated_field_of_non_literal_type_is_reported()
    {
        Assert.Contains(Diagnose("context C { enum E(items: List<String>) { A(1) } }"),
            d => d.Code == DiagnosticCodes.EnumAssociatedFieldType);
        Assert.Contains(Diagnose("context C { value V { x: Int }  enum E(v: V) { A(1) } }"),
            d => d.Code == DiagnosticCodes.EnumAssociatedFieldType);
    }

    [Fact]
    public void Quantity_with_an_int_amount_is_reported()
    {
        // An Int amount would integer-divide / truncate when scaled; amounts must be Decimal.
        Assert.Contains(Diagnose("context C { enum U { A }  quantity Q { amount: Int  unit: U } }"),
            d => d.Code == DiagnosticCodes.QuantityAmountCardinality);
    }

    [Fact]
    public void Quantity_may_declare_a_derived_projection()
    {
        const string src = "context C { enum U { A, B }  quantity Q { amount: Decimal  unit: U  doubled: Decimal = amount * 2 } }";
        Assert.Empty(Diagnose(src));
        var (asm, files) = Compile(src);
        Assert.Contains("public decimal Doubled\n        => ", files);
        Assert.NotNull(asm.GetType("C.Q"));
    }

    [Fact]
    public void User_type_named_like_a_builtin_generic_is_reported()
    {
        Assert.Contains(Diagnose("context C { value Range { lo: Int } }"),
            d => d.Code == DiagnosticCodes.ReservedTypeName);
        Assert.Contains(Diagnose("context C { value List { x: Int } }"),
            d => d.Code == DiagnosticCodes.ReservedTypeName);
    }
}
