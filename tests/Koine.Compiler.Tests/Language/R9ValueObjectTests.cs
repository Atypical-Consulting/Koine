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

    // ======================================================================
    // Demand-driven operators must cover invariants and read-model projections (#600)
    // ======================================================================

    [Fact]
    public void Value_object_sum_inside_an_invariant_gets_an_additive_operator()
    {
        // The ONLY VO `sum` fold is in the entity invariant. OperatorNeedsAnalyzer must still
        // record Money's `operator +`, or the emitted `CheckInvariants()` references an operator
        // that was never generated (CS0019). Compile() asserts the emitted C# compiles.
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              value CartLine {
                subtotal: Money
              }
              entity Cart identified by CartId {
                lines: List<CartLine>
                invariant lines.sum(l => l.subtotal).amount >= 0
              }
            }
            """;
        var (asm, files) = Compile(src);
        asm.GetType("Shop.Money").ShouldNotBeNull();
        files.ShouldContain("operator +");
    }

    [Fact]
    public void Value_object_arithmetic_inside_a_read_model_projection_gets_operators()
    {
        // The ONLY VO `sum` fold and `* scalar` multiply live in read-model derived fields.
        // OperatorNeedsAnalyzer must record Money's `operator +` and `operator *`, or the
        // emitted projection mapper references operators that were never generated (CS0019).
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              value CartLine {
                subtotal: Money
              }
              entity Cart identified by CartId {
                lines: List<CartLine>
                fee:   Money
              }
              readmodel CartSummary from Cart {
                grandTotal: Money = lines.sum(l => l.subtotal)
                doubleFee:  Money = fee * 2
              }
            }
            """;
        var (asm, files) = Compile(src);
        asm.GetType("Shop.CartSummary").ShouldNotBeNull();
        files.ShouldContain("operator +");
        files.ShouldContain("operator *");
    }

    [Fact]
    public void Value_object_divided_by_a_scalar_gets_a_division_operator()
    {
        // #832: a plain value object divided by a numeric scalar (fee / 2) must demand-generate
        // `operator /`, the natural dual of scalar `*`. Without it the emitted projection mapper
        // references an operator that was never generated (CS0019). Compile() asserts the emitted
        // C# compiles, so this test fails until the division need is recorded AND emitted.
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Order identified by OrderId {
                fee: Money
              }
              readmodel FeeSplit from Order {
                half: Money = fee / 2
              }
            }
            """;
        var (asm, files) = Compile(src);
        asm.GetType("Shop.Money").ShouldNotBeNull();
        files.ShouldContain("operator /");
    }

    [Fact]
    public void Direct_same_type_value_object_add_and_subtract_get_their_operators()
    {
        // #833: direct same-type `VO + VO` / `VO - VO` written DIRECTLY (not via a `sum` fold) must
        // demand-generate `operator +` AND `operator -`. Before the fix the read-model mapper emits
        // `src.Fee + src.Fee` / `src.Fee - src.Fee` while Money defines NEITHER operator, so the
        // emitted C# fails with two CS0019s. `+` was generated only by a `sum` fold and `-` was never
        // generated for plain VOs at all. Compile() asserts the emitted C# compiles, so this test
        // fails until both needs are recorded AND emitted. Both fields fail independently — drop one
        // and the other still breaks — so asserting both operators exist pins down the fix.
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Order identified by OrderId {
                fee: Money
              }
              readmodel Totals from Order {
                total: Money = fee + fee
                diff:  Money = fee - fee
              }
            }
            """;
        var (asm, files) = Compile(src);
        asm.GetType("Shop.Money").ShouldNotBeNull();
        files.ShouldContain("operator +");
        files.ShouldContain("operator -");
    }

    // ======================================================================
    // Scalar add/subtract against a value object is a type mismatch (#804,
    // follow-up to the reversed-multiply fixes #788/#797). A value object
    // SCALES by a scalar (Money * 2) and adds to another value object of its
    // OWN type (Money + Money, via a `sum` fold), but there is no
    // `operator +/-(value-object, scalar)` in ANY target — so `5.0 + money`
    // would emit non-compiling code (C# CS0019; a `tsc` type error). The
    // validator rejects it so no emitter is ever asked to lower it.
    // ======================================================================

    [Fact]
    public void Scalar_added_to_a_value_object_is_rejected()
    {
        // `5.0 + fee` — Decimal scalar on the LEFT, value object on the RIGHT
        // (the reversed-additive path probed in #804).
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Cart identified by CartId {
                fee: Money
              }
              readmodel CartSummary from Cart {
                bumped: Money = 5.0 + fee
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmetic);
    }

    [Fact]
    public void Scalar_subtracted_from_a_value_object_is_rejected()
    {
        // Canonical order too: value object on the LEFT, scalar on the RIGHT.
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Cart identified by CartId {
                fee: Money
              }
              readmodel CartSummary from Cart {
                docked: Money = fee - 1
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmetic);
    }

    [Fact]
    public void Value_object_scalar_multiply_and_same_type_addition_remain_valid()
    {
        // The rejection must NOT catch the two SUPPORTED value-object arithmetic
        // forms: scalar multiply (Money * 2) and same-type addition (sum -> Money + Money).
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              value CartLine {
                subtotal: Money
              }
              entity Cart identified by CartId {
                lines: List<CartLine>
                fee:   Money
              }
              readmodel CartSummary from Cart {
                grandTotal: Money = lines.sum(l => l.subtotal)
                doubleFee:  Money = fee * 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmetic);
    }

    [Fact]
    public void Scalar_divided_by_a_value_object_is_rejected()
    {
        // #878: `2 / fee` — a bare numeric scalar on the LEFT, value object on the RIGHT.
        // Division is non-commutative and #832 only demand-generates `operator /(Money, int)`,
        // so the reversed order is meaningless and must be rejected here, not lowered to CS0019.
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Order identified by OrderId {
                fee: Money
              }
              readmodel FeeSplit from Order {
                weird: Money = 2 / fee
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmetic);
    }

    [Fact]
    public void Value_object_divided_by_a_scalar_is_not_flagged_by_the_reversed_check()
    {
        // The reversed-division guard must NOT catch the canonical form (#832): a value
        // object divided by a scalar (fee / 2) is a supported scaling-down operation.
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Order identified by OrderId {
                fee: Money
              }
              readmodel FeeSplit from Order {
                half: Money = fee / 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmetic);
    }

    [Fact]
    public void Scalar_multiply_on_a_value_object_with_no_numeric_field_is_rejected()
    {
        // `tag * 2` — Label has only a String field, so no target can generate a scalar operator.
        const string src = """
            context Shop {
              value Label { text: String }
              entity Item identified by ItemId { tag: Label }
              readmodel ItemSummary from Item { scaled: Label = tag * 2 }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmeticNoNumericField);
    }

    [Fact]
    public void Scalar_divide_on_a_value_object_with_no_numeric_field_is_rejected()
    {
        // `tag / 2` — the supported value-object / scalar direction, but Label has nothing numeric to scale.
        const string src = """
            context Shop {
              value Label { text: String }
              entity Item identified by ItemId { tag: Label }
              readmodel ItemSummary from Item { scaled: Label = tag / 2 }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmeticNoNumericField);
    }

    [Fact]
    public void Scalar_arithmetic_on_a_value_object_with_a_numeric_field_is_allowed()
    {
        // Money has a numeric field; `* 2` and `/ 2` scale it — must NOT be flagged by the new rule.
        const string src = """
            context Shop {
              value Money { amount: Decimal  invariant amount >= 0 }
              entity Order identified by OrderId { fee: Money }
              readmodel FeeSplit from Order {
                doubled: Money = fee * 2
                half:    Money = fee / 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmeticNoNumericField);
    }

    [Fact]
    public void Scalar_arithmetic_on_a_mixed_value_object_with_at_least_one_numeric_field_is_allowed()
    {
        // Priced has a non-numeric (String label) AND a numeric (Decimal amount) field: amount scales,
        // label copies. At least one numeric stored field => the new rule must NOT fire.
        const string src = """
            context Shop {
              value Priced { label: String  amount: Decimal  invariant amount >= 0 }
              entity Order identified by OrderId { fee: Priced }
              readmodel FeeSplit from Order { doubled: Priced = fee * 2 }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmeticNoNumericField);
    }

    [Fact]
    public void Derived_member_narrowing_decimal_body_into_an_int_declared_type_is_rejected()
    {
        // `total: Int = base * 1.5` — the body infers to Decimal, the member is declared Int; no target
        // implicitly narrows Decimal to Int (C#'s CS0266). The model must be rejected before any emitter
        // runs, with the diagnostic spanned to the offending derived member and naming it.
        const string src = """
            context Shop {
              value Sums {
                base:  Decimal
                total: Int = base * 1.5
              }
            }
            """;
        var narrowing = Diagnose(src).ShouldHaveSingleItem();
        narrowing.Code.ShouldBe(DiagnosticCodes.NarrowingConversionInDerivedMember);
        narrowing.Severity.ShouldBe(DiagnosticSeverity.Error);
        narrowing.Message.ShouldContain("total");
        narrowing.Line.ShouldBe(4);   // the `total: Int = base * 1.5` line, not the whole value block
    }

    [Fact]
    public void Derived_member_widening_int_body_into_a_decimal_declared_type_is_allowed()
    {
        // `total: Decimal = a + b` over two Int fields is the LEGAL widening case (C# widens int → decimal
        // for free); it must NOT be flagged — the Rust emitter inserts the conversion instead.
        const string src = """
            context Shop {
              value Sums {
                a: Int
                b: Int
                total: Decimal = a + b
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.NarrowingConversionInDerivedMember);
    }

    [Fact]
    public void Derived_member_with_a_same_type_numeric_body_is_allowed()
    {
        // Int → Int (and Decimal → Decimal) derived members are unchanged: no narrowing, no diagnostic.
        const string src = """
            context Shop {
              value Sums {
                a: Int
                b: Int
                total: Int = a + b
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.NarrowingConversionInDerivedMember);
    }
}
