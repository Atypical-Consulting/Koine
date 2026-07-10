using System.Reflection;
using Koine.Compiler.Diagnostics;
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
    // #1266: a binary +/- across two DIFFERENT quantity types must be
    // rejected at semantic-validation time, not left to crash a downstream
    // emitter target (e.g. Rust cargo check E0308) with zero diagnostics.
    // ======================================================================

    /// <summary>Shared fixture: two distinct quantity types combined via <paramref name="op"/> on line 15.</summary>
    private static string MixSrc(string op = "+") =>
        "context Shop {\n" +
        "  enum MassUnit { Grams, Kilograms }\n" +
        "  enum VolumeUnit { Liters }\n" +
        "  quantity Weight {\n" +
        "    amount: Decimal\n" +
        "    unit: MassUnit\n" +
        "  }\n" +
        "  quantity Volume {\n" +
        "    amount: Decimal\n" +
        "    unit: VolumeUnit\n" +
        "  }\n" +
        "  value Mix {\n" +
        "    w: Weight\n" +
        "    v: Volume\n" +
        $"    bad: Weight = w {op} v\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Quantity_addition_across_different_quantity_types_is_rejected()
    {
        var result = new KoineCompiler().Compile(MixSrc("+"), new CSharpEmitter());
        result.Success.ShouldBeFalse();

        var diag = result.Diagnostics.Single(d => d.Code == DiagnosticCodes.QuantityTypeMismatch);
        diag.Message.ShouldContain("Weight");
        diag.Message.ShouldContain("Volume");
        diag.Line.ShouldBe(15); // the `bad: Weight = w + v` line
    }

    [Fact]
    public void Quantity_subtraction_across_different_quantity_types_is_rejected()
    {
        Diagnose(MixSrc("-")).ShouldContain(d => d.Code == DiagnosticCodes.QuantityTypeMismatch);
    }

    [Fact]
    public void Quantity_addition_of_the_same_type_is_not_flagged_by_the_type_mismatch_check()
    {
        // #1068's legitimate same-type case must remain untouched by the new check.
        const string src = """
            context C {
              enum MassUnit { Gram, Kilogram }
              quantity Weight {
                amount: Decimal
                unit:   MassUnit
              }
              value Box {
                base: Weight
                combined: Weight = base + base
                diff:     Weight = base - base
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.QuantityTypeMismatch);
    }

    [Fact]
    public void Quantity_type_mismatch_is_still_caught_when_an_unrelated_context_reuses_the_same_type_name()
    {
        // Code-review finding (#1266): IsQuantity/left.Name==right.Name resolved via the flat,
        // context-unaware ModelIndex.TryGetDecl(name), so an UNRELATED context declaring its own
        // plain (non-quantity) value object with the same bare name ("Weight") as Shop's quantity
        // clobbered the lookup and silently suppressed KOI0218 for Shop's own mismatched w + v —
        // reopening the exact bug this diagnostic exists to close, via an ordinary, legal
        // multi-context model (R13.2 explicitly allows the same type name in different contexts).
        const string otherContext =
            "context Other {\n" +
            "  value Weight {\n" +
            "    label: String\n" +
            "  }\n" +
            "}\n";

        Diagnose(MixSrc("+") + otherContext).ShouldContain(d => d.Code == DiagnosticCodes.QuantityTypeMismatch);
    }

    [Fact]
    public void Quantity_type_mismatch_is_rejected_before_reaching_any_code_emitter()
    {
        // #1266: the check lives in Semantics/ (KoineCompiler.Compile validates BEFORE ever calling
        // IEmitter.Emit), so it must reject the mismatched model for every code emitter identically —
        // pinning that ordering so it can't silently regress into a single-target fix that leaves
        // the other targets to fail downstream on their own toolchains.
        var src = MixSrc("+");
        var compiler = new KoineCompiler();
        AssertRejected(compiler.Compile(src, new CSharpEmitter()));
        AssertRejected(compiler.Compile(src, new TypeScriptEmitter()));
        AssertRejected(compiler.Compile(src, new PythonEmitter()));
        AssertRejected(compiler.Compile(src, new PhpEmitter()));
        AssertRejected(compiler.Compile(src, new RustEmitter()));
        AssertRejected(compiler.Compile(src, new JavaEmitter()));
        AssertRejected(compiler.Compile(src, new KotlinEmitter()));

        static void AssertRejected(CompileResult result)
        {
            result.Success.ShouldBeFalse();
            result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.QuantityTypeMismatch);
            result.Files.ShouldBeEmpty();
        }
    }

    // ======================================================================
    // #1284: a binary +/- across a quantity and a differently-typed PLAIN
    // value object (or two differently-typed plain value objects) must also
    // be rejected — the sibling gap #1266 explicitly left open (KOI0218 only
    // fires when BOTH operands are quantity-classified).
    // ======================================================================

    /// <summary>Shared fixture: a quantity and a plain value object combined via <paramref name="op"/> on line 13.</summary>
    private static string QuantityVsPlainSrc(string op = "+") =>
        "context Shop {\n" +
        "  enum MassUnit { Grams, Kilograms }\n" +
        "  quantity Weight {\n" +
        "    amount: Decimal\n" +
        "    unit: MassUnit\n" +
        "  }\n" +
        "  value Money {\n" +
        "    amount: Decimal\n" +
        "  }\n" +
        "  value Mix {\n" +
        "    w: Weight\n" +
        "    m: Money\n" +
        $"    bad: Weight = w {op} m\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Quantity_plus_differently_typed_plain_value_object_is_rejected()
    {
        var result = new KoineCompiler().Compile(QuantityVsPlainSrc("+"), new CSharpEmitter());
        result.Success.ShouldBeFalse();

        var diag = result.Diagnostics.Single(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
        diag.Message.ShouldContain("Weight");
        diag.Message.ShouldContain("Money");
        diag.Line.ShouldBe(13); // the `bad: Weight = w + m` line
    }

    [Fact]
    public void Quantity_minus_differently_typed_plain_value_object_is_rejected()
    {
        Diagnose(QuantityVsPlainSrc("-")).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
    }

    [Fact]
    public void Plain_value_object_plus_quantity_is_rejected_regardless_of_operand_order()
    {
        // Reversed operand order (`value Money` on the left, `quantity Weight` on the right) — the
        // check must not be order-dependent.
        const string src = """
            context Shop {
              enum MassUnit { Grams, Kilograms }
              quantity Weight {
                amount: Decimal
                unit:   MassUnit
              }
              value Money {
                amount: Decimal
              }
              value Mix {
                w: Weight
                m: Money
                bad: Weight = m + w
              }
            }
            """;
        var diag = Diagnose(src).Single(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
        diag.Message.ShouldContain("Weight");
        diag.Message.ShouldContain("Money");
    }

    [Fact]
    public void Two_differently_typed_plain_value_objects_added_is_rejected()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
              }
              value Label {
                text: String
              }
              value Mix {
                m: Money
                l: Label
                bad: Money = m + l
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
    }

    [Fact]
    public void Same_type_plain_value_object_addition_is_not_flagged_by_the_type_mismatch_check()
    {
        // Same-type VO `+`/`-` (#833/#600) remains valid and untouched by this check.
        const string src = """
            context C {
              value Money {
                amount: Decimal
              }
              value Wallet {
                a: Money
                b: Money
                total: Money = a + b
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
    }

    [Fact]
    public void Quantity_type_mismatch_still_reports_the_quantity_specific_message()
    {
        // #1266's quantity-vs-quantity case keeps its own KOI0218 code/message rather than falling
        // through to the general KOI0219 wording.
        var diags = Diagnose(MixSrc("+"));
        diags.ShouldContain(d => d.Code == DiagnosticCodes.QuantityTypeMismatch);
        diags.ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
    }

    [Fact]
    public void Scalar_plus_value_object_stays_routed_through_the_scalar_arithmetic_check()
    {
        // `vo +/- scalar` is unaffected — still KOI0215, not the new VO-vs-VO check.
        const string src = """
            context C {
              value Money {
                amount: Decimal
              }
              value Bad {
                m: Money
                x: Money = m + 5
              }
            }
            """;
        var diags = Diagnose(src);
        diags.ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmetic);
        diags.ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
    }

    [Fact]
    public void Value_object_type_mismatch_is_rejected_before_reaching_any_code_emitter()
    {
        var src = QuantityVsPlainSrc("+");
        var compiler = new KoineCompiler();
        AssertRejected(compiler.Compile(src, new CSharpEmitter()));
        AssertRejected(compiler.Compile(src, new TypeScriptEmitter()));
        AssertRejected(compiler.Compile(src, new PythonEmitter()));
        AssertRejected(compiler.Compile(src, new PhpEmitter()));
        AssertRejected(compiler.Compile(src, new RustEmitter()));
        AssertRejected(compiler.Compile(src, new JavaEmitter()));
        AssertRejected(compiler.Compile(src, new KotlinEmitter()));

        static void AssertRejected(CompileResult result)
        {
            result.Success.ShouldBeFalse();
            result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
            result.Files.ShouldBeEmpty();
        }
    }

    [Fact]
    public void Value_object_type_mismatch_is_still_caught_when_an_unrelated_context_declares_a_differently_kinded_same_named_type()
    {
        // Code-review finding (#1284): the check must resolve BOTH the "is this value-like" and "is
        // this a quantity" classifications the SAME context-aware way #1266's review pass fixed for
        // IsQuantity — not via TypeResolver.IsValueLike's flat, context-blind ModelIndex.Classify
        // lookup. Without that, an UNRELATED context declaring its own, differently-kinded type under
        // the SAME bare name as Shop's in-scope plain value object ("Money") can silently misclassify
        // the in-scope operand as not value-like, causing the whole check to bail out — reopening
        // exactly the class of bug #1266 closed, just via the new IsValueLike gate instead of IsQuantity.
        const string otherContext =
            "context Other {\n" +
            "  entity Money identified by MoneyId {\n" +
            "    label: String\n" +
            "  }\n" +
            "}\n";

        Diagnose(QuantityVsPlainSrc("+") + otherContext).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
    }

    [Fact]
    public void Differently_typed_value_objects_across_two_contexts_sharing_a_bare_name_are_rejected()
    {
        // Code-review finding (#1284): a bare-name equality check (`left.Name == right.Name`) is wrong
        // when two operands are explicitly qualified (R13.2) to DIFFERENT contexts — Alpha.Money and
        // Beta.Money share a bare name but are genuinely unrelated declared types; comparing by resolved
        // declaration identity (not bare name) is required to reject this correctly.
        const string src = """
            context Alpha {
              value Money {
                amount: Decimal
              }
            }
            context Beta {
              value Money {
                code: String
              }
            }
            context Gamma {
              value Mix {
                a: Alpha.Money
                b: Beta.Money
                bad: Alpha.Money = a + b
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectTypeMismatch);
    }

    // ======================================================================
    // #1291 — the */÷ sibling gap #1284's own code-review pass found but left out of its own scope: a
    // binary '*'/'/' where BOTH operands are value-like (two value objects, or two quantities) must
    // also be rejected — mirroring #1266/#1284's +/- coverage. Unlike +/-, there is NO same-type
    // exception: no emitter ever generates a value-object-vs-value-object '*'/'/' operator, even for
    // the SAME declared type.
    // ======================================================================

    /// <summary>Shared fixture: two distinct plain value objects combined via <paramref name="op"/> on line 11 (this issue's own repro).</summary>
    private static string MulDivMixSrc(string op = "*") =>
        "context Shop {\n" +
        "  value Money {\n" +
        "    amount: Decimal\n" +
        "  }\n" +
        "  value Weight {\n" +
        "    amount: Decimal\n" +
        "  }\n" +
        "  value Mix {\n" +
        "    m: Money\n" +
        "    w: Weight\n" +
        $"    bad: Money = m {op} w\n" +
        "  }\n" +
        "}\n";

    [Fact]
    public void Value_object_multiplication_across_different_types_is_rejected()
    {
        var result = new KoineCompiler().Compile(MulDivMixSrc("*"), new CSharpEmitter());
        result.Success.ShouldBeFalse();

        var diag = result.Diagnostics.Single(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
        diag.Message.ShouldContain("Money");
        diag.Message.ShouldContain("Weight");
        diag.Line.ShouldBe(11); // the `bad: Money = m * w` line
    }

    [Fact]
    public void Value_object_division_across_different_types_is_rejected()
    {
        Diagnose(MulDivMixSrc("/")).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    [Fact]
    public void Value_object_multiplication_is_rejected_regardless_of_operand_order()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
              }
              value Weight {
                amount: Decimal
              }
              value Mix {
                m: Money
                w: Weight
                bad: Money = w * m
              }
            }
            """;
        var diag = Diagnose(src).Single(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
        diag.Message.ShouldContain("Money");
        diag.Message.ShouldContain("Weight");
    }

    [Fact]
    public void Same_type_value_object_multiplication_is_also_rejected()
    {
        // Unlike CheckValueObjectTypeMismatch's same-declared-type early return, VO-vs-VO of the SAME
        // type is ALSO rejected here: no emitter generates a `Money * Money` operator either — same-type
        // '*'/'/' between two value objects has no valid lowering, unlike same-type '+'/'-'.
        const string src = """
            context C {
              value Money {
                amount: Decimal
              }
              value Wallet {
                a: Money
                b: Money
                bad: Money = a * b
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    [Fact]
    public void Same_type_value_object_division_is_also_rejected()
    {
        const string src = """
            context C {
              value Money {
                amount: Decimal
              }
              value Wallet {
                a: Money
                b: Money
                bad: Money = a / b
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    [Fact]
    public void Value_object_scalar_multiply_and_divide_remain_valid_and_unaffected_by_the_mul_div_mismatch_check()
    {
        // `vo * scalar` / `vo / scalar` (KOI0215/KOI0216-adjacent, already-valid scaling forms) is
        // unaffected by this new VO-vs-VO check — it only fires when BOTH operands are value-like.
        const string src = """
            context C {
              value Money {
                amount: Decimal
              }
              value Bag {
                m: Money
                doubled: Money = m * 2
                halved:  Money = m / 2
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Quantity_multiplication_across_different_quantity_types_is_rejected()
    {
        // Reuses the #1266 MixSrc fixture (two differently-typed quantities) parametrized to '*'.
        Diagnose(MixSrc("*")).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    [Fact]
    public void Quantity_division_across_different_quantity_types_is_rejected()
    {
        Diagnose(MixSrc("/")).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    [Fact]
    public void Same_type_quantity_multiplication_is_also_rejected()
    {
        // No same-type exception here either: `Weight * Weight` is as dimensionally meaningless as
        // `Weight * Volume` and has no generated operator.
        const string src = """
            context C {
              enum MassUnit { Gram, Kilogram }
              quantity Weight {
                amount: Decimal
                unit:   MassUnit
              }
              value Box {
                w: Weight
                bad: Weight = w * w
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    [Fact]
    public void Quantity_scalar_multiply_remains_valid_and_unaffected_by_the_mul_div_mismatch_check()
    {
        const string src = """
            context C {
              enum MassUnit { Grams, Kilograms }
              quantity Weight {
                amount: Decimal
                unit:   MassUnit
              }
              value Bag {
                w: Weight
                doubled: Weight = w * 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    [Fact]
    public void Value_object_mul_div_mismatch_is_still_caught_when_an_unrelated_context_reuses_the_same_type_name()
    {
        // Mirrors #1266's own review-found regression: the check must resolve both operands the SAME
        // context-aware way (t.Qualifier ?? _resolver.Context + ModelIndex.TryGetDeclIn) so an unrelated
        // context declaring its own same-named type can't silently misclassify an in-scope operand.
        const string otherContext =
            "context Other {\n" +
            "  value Weight {\n" +
            "    label: String\n" +
            "  }\n" +
            "}\n";

        Diagnose(MulDivMixSrc("*") + otherContext).ShouldContain(d => d.Code == DiagnosticCodes.ValueObjectMulDivMismatch);
    }

    // ======================================================================
    // #1290 — an entity-typed operand in binary +/- (the Non-goal #1284 flagged for follow-up)
    // ======================================================================

    private const string EntityVsValueObjectSrc = """
        context Shop {
          value Money {
            amount: Decimal
          }
          aggregate CartAgg root Cart {
            entity Cart identified by CartId {
              item: Item
              fee: Money
              bad: Money = item + fee
            }
            entity Item identified by ItemId {
              name: String
            }
          }
        }
        """;

    [Fact]
    public void Entity_plus_value_object_is_rejected()
    {
        var result = new KoineCompiler().Compile(EntityVsValueObjectSrc, new CSharpEmitter());
        result.Success.ShouldBeFalse();

        var diag = result.Diagnostics.Single(d => d.Code == DiagnosticCodes.EntityOperandArithmetic);
        diag.Message.ShouldContain("Item");
        diag.Message.ShouldContain("Money");
    }

    [Fact]
    public void Entity_minus_value_object_is_rejected()
    {
        Diagnose(EntityVsValueObjectSrc.Replace("item + fee", "item - fee"))
            .ShouldContain(d => d.Code == DiagnosticCodes.EntityOperandArithmetic);
    }

    [Fact]
    public void Value_object_plus_entity_is_rejected_regardless_of_operand_order()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
              }
              aggregate CartAgg root Cart {
                entity Cart identified by CartId {
                  item: Item
                  fee:  Money
                  bad:  Money = fee + item
                }
                entity Item identified by ItemId {
                  name: String
                }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityOperandArithmetic);
    }

    [Fact]
    public void Same_type_entity_addition_is_also_rejected()
    {
        // Unlike CheckValueObjectTypeMismatch's same-declared-type early return, entity-vs-entity of the
        // SAME type is ALSO rejected here — entities never have a `+`/`-` operator regardless of a type
        // match.
        const string src = """
            context Shop {
              aggregate CartAgg root Cart {
                entity Cart identified by CartId {
                  item1: Item
                  item2: Item
                  bad:   Item = item1 + item2
                }
                entity Item identified by ItemId {
                  name: String
                }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityOperandArithmetic);
    }

    [Fact]
    public void Entity_identity_comparison_remains_valid_and_unaffected()
    {
        // `==`/`!=` (identity comparison) is legitimate and untouched by this check — scoped to `+`/`-`.
        // Asserts a fully clean compile (not just "no KOI0220"), so an unrelated typo in the fixture
        // can't make this pass vacuously.
        const string src = """
            context Shop {
              aggregate CartAgg root Cart {
                entity Cart identified by CartId {
                  item1: Item
                  item2: Item
                  same:  Bool = item1 == item2
                }
                entity Item identified by ItemId {
                  name: String
                }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Aggregate_typed_operand_is_also_rejected()
    {
        // Coverage for the `or AggregateDecl` disjunct in CheckEntityOperandArithmetic — a field can
        // legally be typed with an AGGREGATE's own bare name (not just an entity's), e.g. this
        // cross-aggregate reference (also separately flagged by KOI1602/EntityReferencesForeignAggregate,
        // per DddReferenceDisciplineTests.An_entity_field_typed_as_an_aggregate_is_reported) or a
        // domain-service `operation` parameter that ReferenceDisciplineAnalyzer doesn't cover at all.
        // Either way, an aggregate has no generated '+'/'-' operator either.
        const string src = """
            context Sales {
              value Money {
                amount: Decimal
              }
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  related: Customers
                  fee:     Money
                  bad:     Money = related + fee
                }
              }
              aggregate Customers root Customer {
                entity Customer identified by CustomerId {
                  name: String
                }
              }
            }
            """;
        Diagnose(src).ShouldContain(d => d.Code == DiagnosticCodes.EntityOperandArithmetic);
    }

    [Fact]
    public void Entity_operand_arithmetic_is_rejected_before_reaching_any_code_emitter()
    {
        var src = EntityVsValueObjectSrc;
        var compiler = new KoineCompiler();
        AssertRejected(compiler.Compile(src, new CSharpEmitter()));
        AssertRejected(compiler.Compile(src, new TypeScriptEmitter()));
        AssertRejected(compiler.Compile(src, new PythonEmitter()));
        AssertRejected(compiler.Compile(src, new PhpEmitter()));
        AssertRejected(compiler.Compile(src, new RustEmitter()));
        AssertRejected(compiler.Compile(src, new JavaEmitter()));
        AssertRejected(compiler.Compile(src, new KotlinEmitter()));

        static void AssertRejected(CompileResult result)
        {
            result.Success.ShouldBeFalse();
            result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.EntityOperandArithmetic);
            result.Files.ShouldBeEmpty();
        }
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
    public void Scalar_multiply_on_a_value_object_with_a_numeric_field_is_not_flagged_when_an_unrelated_context_declares_the_same_name_without_one()
    {
        // Issue #1285: HasNumericStoredField resolved via the flat, context-unaware
        // ModelIndex.TryGetDecl(name) — the same root-cause class fixed in #1266's IsQuantity helper.
        // context A's Money HAS a numeric field and legitimately scales via `* 2`; context B declares
        // its own unrelated, same-named Money with none. B is registered LAST in ModelIndex._byName,
        // so the flat lookup silently resolved A's `fee * 2` against B's declaration and wrongly
        // flagged KOI0216, even though A's own Money has amount: Decimal to scale.
        const string src = """
            context A {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Order identified by OrderId {
                fee: Money
              }
              readmodel FeeSplit from Order {
                doubled: Money = fee * 2
              }
            }
            context B {
              value Money {
                label: String
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.ValueObjectScalarArithmeticNoNumericField);
    }

    [Fact]
    public void Scalar_multiply_on_a_value_object_with_a_numeric_field_is_not_flagged_regardless_of_which_same_named_context_registers_last()
    {
        // Reversed declaration order from the fixture above (numeric-bearing context A declared
        // LAST, so it's the one registered last in ModelIndex._byName) — the fix must not be
        // order-dependent in either direction.
        const string src = """
            context B {
              value Money {
                label: String
              }
            }
            context A {
              value Money {
                amount: Decimal
                invariant amount >= 0
              }
              entity Order identified by OrderId {
                fee: Money
              }
              readmodel FeeSplit from Order {
                doubled: Money = fee * 2
              }
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
        narrowing.Code.ShouldBe(DiagnosticCodes.NumericNarrowingConversion);
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
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.NumericNarrowingConversion);
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
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.NumericNarrowingConversion);
    }

    [Fact]
    public void Stored_default_narrowing_decimal_literal_into_an_int_declared_type_is_rejected()
    {
        // `total: Int = 2.5` — a STORED (non-derived) constant default, not a computed member. The
        // literal infers to Decimal, the field is declared Int; same illegal narrowing as issue #961's
        // derived-member case, and must be rejected the same way (issue #974).
        const string src = """
            context Shop {
              value V {
                total: Int = 2.5
              }
            }
            """;
        var narrowing = Diagnose(src).ShouldHaveSingleItem();
        narrowing.Code.ShouldBe(DiagnosticCodes.NumericNarrowingConversion);
        narrowing.Severity.ShouldBe(DiagnosticSeverity.Error);
        narrowing.Message.ShouldContain("total");
        narrowing.Line.ShouldBe(3);   // the `total: Int = 2.5` line, not the whole value block
    }

    [Fact]
    public void Stored_default_narrowing_is_rejected_on_entity_and_event_members_too()
    {
        // KOI0217 lives in the member validation shared across value objects, entities, and events, so
        // the stored-default extension (issue #974) applies uniformly, not just to value objects.
        const string entitySrc = """
            context Shop {
              entity Item identified by ItemId as natural(Int) {
                total: Int = 2.5
              }
            }
            """;
        Diagnose(entitySrc).ShouldContain(d => d.Code == DiagnosticCodes.NumericNarrowingConversion);

        const string eventSrc = """
            context Shop {
              event Priced {
                total: Int = 2.5
              }
            }
            """;
        Diagnose(eventSrc).ShouldContain(d => d.Code == DiagnosticCodes.NumericNarrowingConversion);
    }

    [Fact]
    public void Stored_default_widening_int_literal_into_a_decimal_declared_type_is_allowed()
    {
        // `total: Decimal = 2` is the legal widening case (C# widens int -> decimal for free); must
        // NOT be flagged.
        const string src = """
            context Shop {
              value V {
                total: Decimal = 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.NumericNarrowingConversion);
    }

    [Fact]
    public void Stored_default_with_a_same_type_numeric_literal_is_allowed()
    {
        // `total: Int = 2` is same-type: no narrowing, no diagnostic.
        const string src = """
            context Shop {
              value V {
                total: Int = 2
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.NumericNarrowingConversion);
    }

    [Fact]
    public void Derived_member_conditional_with_a_narrowing_decimal_else_branch_is_rejected()
    {
        // `total: Int = if base > 0 then 0 else base` — the `then` branch is Int (`0`), the `else` branch
        // is Decimal (`base`). The conditional's inferred type is the common (wider) Decimal, so assigning
        // it into the Int member is the same illegal narrowing as `base * 1.5`. Before #975 the conditional
        // took only its `then` branch (Int), hiding the Decimal else from KOI0217 and emitting non-compiling
        // code (C# CS0266); it must be rejected here instead.
        const string src = """
            context Shop {
              value V {
                base:  Decimal
                total: Int = if base > 0 then 0 else base
              }
            }
            """;
        var narrowing = Diagnose(src).ShouldHaveSingleItem();
        narrowing.Code.ShouldBe(DiagnosticCodes.NumericNarrowingConversion);
        narrowing.Severity.ShouldBe(DiagnosticSeverity.Error);
        narrowing.Message.ShouldContain("total");
    }

    [Fact]
    public void Derived_member_conditional_widening_into_a_decimal_declared_type_is_allowed()
    {
        // The SAME conditional assigned into a Decimal member is a legal widening (both branches fit
        // Decimal for free) — it must NOT be flagged.
        const string src = """
            context Shop {
              value V {
                base:  Decimal
                total: Decimal = if base > 0 then 0 else base
              }
            }
            """;
        Diagnose(src).ShouldNotContain(d => d.Code == DiagnosticCodes.NumericNarrowingConversion);
    }
}
