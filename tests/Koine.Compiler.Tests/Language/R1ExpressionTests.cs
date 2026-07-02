using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R1 — Expression Sublanguage Completeness. Conditionals, string ops,
/// collection ops + lambdas, and Instant comparison are exercised end-to-end:
/// emitted C# is compiled with Roslyn and run via reflection, and the semantic
/// diagnostics are asserted directly.
/// </summary>
public class R1ExpressionTests
{
    // A fixture spanning all four R1 stories.
    private const string Fixture = """
        context R1 {
          enum Currency { EUR, USD }

          value Money {
            amount: Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }

          value Discount {
            quantity:  Int
            unitPrice: Money
            effective: Money = if quantity >= 10 then unitPrice * 0.9 else unitPrice
          }

          value PostalCode {
            raw: String
            normalized: String = raw.trim.upper
            invariant raw.trim.length > 0 "postal code cannot be blank"
          }

          value DateRange {
            startsAt: Instant
            endsAt:   Instant
            invariant startsAt <= endsAt "start must precede end"
          }

          value Line {
            product:   ProductId
            quantity:  Int
            unitPrice: Money
            subtotal:  Money = unitPrice * quantity
          }

          value Cart {
            lines: List<Line>
            total: Money = lines.sum(l => l.subtotal)
            invariant lines.all(l => l.quantity > 0)  "every line needs a positive quantity"
            invariant lines.distinctBy(l => l.product) "no duplicate products"
          }

          value Event {
            startsAt: Instant
            isPast:   Bool = startsAt < now
          }
        }
        """;

    private static Assembly CompileFixture()
    {
        var result = new KoineCompiler().Compile(Fixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm;
    }

    private static IReadOnlyList<Diagnostic> Diagnose(string source) =>
        new KoineCompiler().Diagnose(source);

    // ---- compile gate ------------------------------------------------------

    [Fact]
    public void Fixture_is_valid_and_compiles()
    {
        Diagnose(Fixture).ShouldBeEmpty();
        CompileFixture(); // throws on compile failure
    }

    // ---- R1.1 conditional --------------------------------------------------

    [Fact]
    public void Conditional_selects_branch_by_condition()
    {
        var asm = CompileFixture();
        var money = asm.GetType("R1.Money")!;
        var discount = asm.GetType("R1.Discount")!;
        var currency = asm.GetType("R1.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");

        decimal Effective(int qty)
        {
            var price = Activator.CreateInstance(money, 100m, eur);
            var d = Activator.CreateInstance(discount, qty, price);
            var eff = discount.GetProperty("Effective")!.GetValue(d);
            return (decimal)money.GetProperty("Amount")!.GetValue(eff)!;
        }

        Effective(10).ShouldBe(90m); // >= 10 -> 100 * 0.9
        Effective(5).ShouldBe(100m); // else  -> 100
    }

    // ---- R1.2 string ops ---------------------------------------------------

    [Fact]
    public void String_ops_trim_length_and_upper()
    {
        var asm = CompileFixture();
        var postal = asm.GetType("R1.PostalCode")!;

        var ok = Activator.CreateInstance(postal, "  ab ");
        postal.GetProperty("Normalized")!.GetValue(ok).ShouldBe("AB");

        // raw.trim.length > 0 fails for blank input.
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(postal, "   "));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    // ---- R1.3 collection ops + lambdas -------------------------------------

    [Fact]
    public void Collection_sum_folds_value_objects()
    {
        var asm = CompileFixture();
        var money = asm.GetType("R1.Money")!;
        var line = asm.GetType("R1.Line")!;
        var cart = asm.GetType("R1.Cart")!;
        var productId = asm.GetType("R1.ProductId")!;
        var currency = asm.GetType("R1.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");
        var newId = productId.GetMethod("New")!;

        object MakeLine(int qty) =>
            Activator.CreateInstance(line, newId.Invoke(null, null), qty, Activator.CreateInstance(money, 10m, eur))!;

        var lines = (System.Collections.IList)Activator.CreateInstance(
            typeof(List<>).MakeGenericType(line))!;
        lines.Add(MakeLine(2));
        lines.Add(MakeLine(3));

        var c = Activator.CreateInstance(cart, lines);
        var total = cart.GetProperty("Total")!.GetValue(c);
        ((decimal)money.GetProperty("Amount")!.GetValue(total)!).ShouldBe(50m); // 2*10 + 3*10
    }

    [Fact]
    public void Collection_all_invariant_rejects_nonpositive_quantity()
    {
        var asm = CompileFixture();
        var money = asm.GetType("R1.Money")!;
        var line = asm.GetType("R1.Line")!;
        var cart = asm.GetType("R1.Cart")!;
        var productId = asm.GetType("R1.ProductId")!;
        var currency = asm.GetType("R1.Currency")!;
        var eur = TestSupport.EnumValue(currency, "EUR");
        var newId = productId.GetMethod("New")!;

        var lines = (System.Collections.IList)Activator.CreateInstance(
            typeof(List<>).MakeGenericType(line))!;
        lines.Add(Activator.CreateInstance(line, newId.Invoke(null, null), 0, Activator.CreateInstance(money, 10m, eur)));

        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(cart, lines));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    // ---- R1.4 Instant + now ------------------------------------------------

    [Fact]
    public void Instant_comparison_and_now_compile_and_run()
    {
        var asm = CompileFixture();
        var range = asm.GetType("R1.DateRange")!;
        var ev = asm.GetType("R1.Event")!;

        var start = DateTimeOffset.UtcNow;
        Activator.CreateInstance(range, start, start.AddHours(1)).ShouldNotBeNull();

        // start after end violates the invariant.
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(range, start, start.AddHours(-1)));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");

        // `now`-based derived field evaluates against the current time.
        var past = Activator.CreateInstance(ev, DateTimeOffset.UtcNow.AddHours(-1));
        ((bool)ev.GetProperty("IsPast")!.GetValue(past)!).ShouldBeTrue();
    }

    // ---- diagnostics -------------------------------------------------------

    [Fact]
    public void Instant_compared_with_non_instant_is_reported()
    {
        var diags = Diagnose("context C {\n  value V {\n    a: Instant\n    b: Int\n    invariant a <= b \"x\"\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("cannot compare 'Instant' with 'Int'"));
    }

    [Fact]
    public void Now_as_stored_default_is_reported()
    {
        var diags = Diagnose("context C {\n  value V {\n    t: Instant = now\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("'now' cannot be used as a stored default"));
    }

    [Fact]
    public void Unknown_string_operation_is_reported()
    {
        var diags = Diagnose("context C {\n  value V {\n    raw: String\n    normalized: String = raw.bogus\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("unknown string operation 'bogus'"));
    }

    [Fact]
    public void String_op_on_non_string_is_reported()
    {
        var diags = Diagnose("context C {\n  value V {\n    n: Int\n    invariant n.trim.length > 0 \"x\"\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("string operation 'trim' cannot be applied to 'Int'"));
    }

    [Fact]
    public void Collection_op_on_non_collection_is_reported()
    {
        var diags = Diagnose("context C {\n  value V {\n    n: Int\n    invariant n.all(x => x > 0) \"y\"\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("collection operation 'all' cannot be applied to 'Int'"));
    }

    [Fact]
    public void Conditional_with_incompatible_branches_is_reported()
    {
        var diags = Diagnose("context C {\n  value V {\n    a: Int\n    b: String\n    x: String = if a > 0 then a else b\n  }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("incompatible types"));
    }

    [Fact]
    public void Unknown_member_in_lambda_is_reported()
    {
        const string src =
            "context C {\n" +
            "  value Line { quantity: Int }\n" +
            "  value Cart {\n" +
            "    lines: List<Line>\n" +
            "    invariant lines.all(l => l.bogus > 0) \"z\"\n" +
            "  }\n" +
            "}\n";
        var diags = Diagnose(src);
        diags.ShouldContain(d => d.Message.Contains("unknown member 'bogus' on type 'Line'"));
    }

    // ---- regressions found by the R1 review --------------------------------

    [Fact]
    public void Relational_on_value_object_is_reported()
    {
        const string src = "context C {\n  value Money { amount: Decimal }\n  value V {\n    a: Money\n    b: Money\n    invariant a < b \"x\"\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("relational operator cannot be applied to 'Money'"));
    }

    [Fact]
    public void Enum_compared_with_int_is_reported()
    {
        const string src = "context C {\n  enum E { A }\n  value V {\n    e: E\n    ok: Bool = e == 1\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("cannot compare 'E' with 'Int'"));
    }

    [Fact]
    public void Min_over_value_object_selector_is_reported()
    {
        const string src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "  value Cart {\n" +
            "    lines: List<Line>\n" +
            "    cheapest: Money = lines.min(l => l.price)\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("min requires a comparable selector"));
    }

    [Fact]
    public void Collection_contains_argument_type_is_checked()
    {
        const string src = "context C {\n  value V {\n    tags: List<String>\n    ok: Bool = tags.contains(5)\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("collection 'contains' expects an argument of type 'String'"));
    }

    [Fact]
    public void Member_access_on_primitive_element_is_reported()
    {
        const string src = "context C {\n  value V {\n    xs: List<Int>\n    ok: Bool = xs.all(x => x.foo > 0)\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("unknown member 'foo' on type 'Int'"));
    }

    [Fact]
    public void User_field_named_after_member_op_shadows_the_builtin_op()
    {
        // #605: a value/entity member named after a built-in member-op (count, length,
        // isEmpty, …) must resolve as an ordinary field access — not be shadowed by the
        // built-in op and raise a false KOI0207 (collection op) / KOI0206 (string op).
        // `count: Money` also exercises the inference fix: the built-in `count` op infers
        // `Int`, so only a declared-member-first resolver yields the real `Money` type.
        const string src =
            "context Demo {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Inner {\n" +
            "    count:  Money\n" +
            "    length: Int\n" +
            "  }\n" +
            "  value Outer {\n" +
            "    inner: Inner\n" +
            "    total: Money = inner.count\n" +
            "    invariant inner.length > 0 \"length must be positive\"\n" +
            "  }\n" +
            "}\n";

        // No false collection/string member-op diagnostic on the user fields, and
        // `total: Money = inner.count` only type-checks when `inner.count` infers to Money.
        Diagnose(src).ShouldBeEmpty();

        // The emitted C# compiles — `inner.count`/`inner.length` map to the declared
        // properties, with the inferred types agreeing with the checker.
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
    }

    [Fact]
    public void User_field_named_after_member_op_emits_field_access_not_op_form()
    {
        // #672 (follow-up to #605): #605 fixed the *semantics* so a user field named after a
        // built-in member-op resolves as a plain field access. But the C# emitter still
        // `switch`ed blindly on the member NAME, so an UNSAFE op name — one whose emitted form
        // differs from a property access (isEmpty/isNotEmpty/trim/lower/upper/isBlank/isPresent/
        // isNone) — still emitted the op form (`inner.Count == 0`, `inner.Trim()`) for a field
        // that has no such member, failing to compile (CS1061: 'Inner' has no 'Count'/'Trim').
        // The emitter must prefer the user-declared member, mirroring #605 one layer down.
        const string src =
            "context Demo {\n" +
            "  value Inner {\n" +
            "    isEmpty: Bool\n" +
            "    trim:    String\n" +
            "  }\n" +
            "  value Outer {\n" +
            "    inner: Inner\n" +
            "    flag: Bool   = inner.isEmpty\n" +
            "    name: String = inner.trim\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // The derived members read the declared property, not the built-in op form.
        var source = string.Join("\n", result.Files.Select(f => f.Contents));
        source.ShouldContain(".IsEmpty");
        source.ShouldNotContain(".Count == 0");
        source.ShouldNotContain(".Trim()");

        // And the emitted C# compiles + runs: the derived members project the inner fields.
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var inner = asm!.GetType("Demo.Inner")!;
        var innerInstance = Activator.CreateInstance(inner, true, "hello");
        var outer = asm.GetType("Demo.Outer")!;
        var o = Activator.CreateInstance(outer, innerInstance);
        outer.GetProperty("Flag")!.GetValue(o).ShouldBe(true);
        outer.GetProperty("Name")!.GetValue(o).ShouldBe("hello");
    }

    [Fact]
    public void Numeric_min_and_double_negation_compile_and_run()
    {
        const string src =
            "context N {\n" +
            "  value Stats {\n" +
            "    xs:      List<Int>\n" +
            "    lowest:  Int = xs.min(x => x)\n" +
            "  }\n" +
            "  value Neg {\n" +
            "    a: Int\n" +
            "    b: Int = - - a\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var neg = asm.GetType("N.Neg")!;
        var n = Activator.CreateInstance(neg, 7);
        neg.GetProperty("B")!.GetValue(n).ShouldBe(7); // -(-7) == 7

        var stats = asm.GetType("N.Stats")!;
        var ints = (System.Collections.IList)Activator.CreateInstance(typeof(List<int>))!;
        ints.Add(3);
        ints.Add(1);
        ints.Add(2);
        var s = Activator.CreateInstance(stats, ints);
        stats.GetProperty("Lowest")!.GetValue(s).ShouldBe(1);
    }

    [Fact]
    public void Min_and_max_over_empty_collection_throw_domain_error()
    {
        // #628: min/max over a possibly-empty collection must throw a clear
        // DomainInvariantViolationException, not leak LINQ's opaque
        // "Sequence contains no elements" InvalidOperationException — mirroring the
        // value-object `sum` fold and the TS (#610) / Python / Rust emitters.
        const string src =
            "context E {\n" +
            "  value Stats {\n" +
            "    xs:       List<Int>\n" +
            "    prices:   List<Decimal>\n" +
            "    lowest:   Int     = xs.min(x => x)\n" +
            "    highest:  Int     = xs.max(x => x)\n" +
            "    cheapest: Decimal = prices.min(p => p)\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var stats = asm!.GetType("E.Stats")!;

        // Populated → correct min/max (the guard's non-empty branch still folds right).
        var ints = (System.Collections.IList)Activator.CreateInstance(typeof(List<int>))!;
        ints.Add(3);
        ints.Add(1);
        ints.Add(2);
        var decs = (System.Collections.IList)Activator.CreateInstance(typeof(List<decimal>))!;
        decs.Add(9m);
        decs.Add(4m);
        decs.Add(7m);
        var s = Activator.CreateInstance(stats, ints, decs);
        stats.GetProperty("Lowest")!.GetValue(s).ShouldBe(1);
        stats.GetProperty("Highest")!.GetValue(s).ShouldBe(3);
        stats.GetProperty("Cheapest")!.GetValue(s).ShouldBe(4m);

        // Empty → reading the derived member throws the domain error (wrapped by the
        // reflection getter), not InvalidOperationException("Sequence contains no elements").
        var empty = Activator.CreateInstance(stats,
            Activator.CreateInstance(typeof(List<int>)),
            Activator.CreateInstance(typeof(List<decimal>)));
        var exMin = Should.Throw<TargetInvocationException>(() => stats.GetProperty("Lowest")!.GetValue(empty));
        exMin.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
        var exMax = Should.Throw<TargetInvocationException>(() => stats.GetProperty("Highest")!.GetValue(empty));
        exMax.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
        var exDec = Should.Throw<TargetInvocationException>(() => stats.GetProperty("Cheapest")!.GetValue(empty));
        exDec.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    // ---- R1.4 `now` as a first-class builtin -------------------------------

    [Fact]
    public void Now_is_a_registered_nullary_builtin_typed_as_instant()
    {
        // Single source of truth: `now` is defined once in BuiltinOps, not as a
        // scattered string literal across resolver/checker/emitter.
        Ast.BuiltinOps.IsNullaryValueOp("now").ShouldBeTrue();
        Ast.BuiltinOps.NullaryValueOps["now"].ShouldBe("Instant");
    }

    [Fact]
    public void Now_emits_utc_now_in_generated_csharp()
    {
        const string src =
            "context T {\n" +
            "  value Event {\n" +
            "    startsAt: Instant\n" +
            "    isPast:   Bool = startsAt < now\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var source = string.Join("\n", result.Files.Select(f => f.Contents));
        source.ShouldContain("DateTimeOffset.UtcNow");
    }

    [Fact]
    public void Field_named_now_shadows_the_builtin()
    {
        // `now` stays a (shadowable) Identifier, not a reserved word: a member named
        // `now` resolves to the member, not the builtin current-instant value.
        const string src =
            "context T {\n" +
            "  value Snapshot {\n" +
            "    now:    Instant\n" +
            "    sameAs: Bool = now == now\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var source = string.Join("\n", result.Files.Select(f => f.Contents));
        source.ShouldNotContain("DateTimeOffset.UtcNow");
    }
}
