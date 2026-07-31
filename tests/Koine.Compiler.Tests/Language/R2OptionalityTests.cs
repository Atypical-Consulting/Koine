using System.Collections;
using System.Reflection;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R2 — Optionality &amp; Richer Collections. Optional fields, null-coalescing,
/// presence checks, and Set/Map types are exercised end-to-end (Roslyn) and via
/// semantic diagnostics.
/// </summary>
public class R2OptionalityTests
{
    private const string Fixture = """
        context R2 {
          value Email { raw: String }
          entity Customer identified by CustomerId {
            name:     String
            nickname: String?
            email:    Email
            display:  String = nickname ?? name
            hasNick:  Bool = nickname.isPresent
          }
          value Money { amount: Decimal }
          entity Catalog identified by CatalogId {
            tags:   Set<String>
            prices: Map<ProductId, Money>
            note:   String?
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

    [Fact]
    public void Fixture_is_valid_and_compiles()
    {
        Diagnose(Fixture).ShouldBeEmpty();
        CompileFixture();
    }

    // ---- R2.1 optional + coalescing + presence -----------------------------

    [Fact]
    public void Unset_optional_falls_back_via_coalesce_and_presence()
    {
        var asm = CompileFixture();
        var customer = asm.GetType("R2.Customer")!;
        var customerId = asm.GetType("R2.CustomerId")!;
        var email = asm.GetType("R2.Email")!;
        var id = customerId.GetMethod("New")!.Invoke(null, null);
        var mail = Activator.CreateInstance(email, "a@b.co");

        // Constructor order is (id, name, email, nickname=null) — defaulted params last.
        var without = Activator.CreateInstance(customer, id, "Alice", mail, null);
        customer.GetProperty("Nickname")!.GetValue(without).ShouldBeNull();
        customer.GetProperty("Display")!.GetValue(without).ShouldBe("Alice"); // nickname ?? name
        ((bool)customer.GetProperty("HasNick")!.GetValue(without)!).ShouldBeFalse();

        var with = Activator.CreateInstance(customer, id, "Alice", mail, "Ali");
        customer.GetProperty("Display")!.GetValue(with).ShouldBe("Ali");
        ((bool)customer.GetProperty("HasNick")!.GetValue(with)!).ShouldBeTrue();
    }

    // ---- R2.2 Set / Map ----------------------------------------------------

    [Fact]
    public void Set_and_map_round_trip_and_defensively_copy()
    {
        var asm = CompileFixture();
        var catalog = asm.GetType("R2.Catalog")!;
        var catalogId = asm.GetType("R2.CatalogId")!;
        var productId = asm.GetType("R2.ProductId")!;
        var money = asm.GetType("R2.Money")!;
        var id = catalogId.GetMethod("New")!.Invoke(null, null);

        var tags = (ISet<string>)Activator.CreateInstance(typeof(HashSet<string>))!;
        tags.Add("a");
        tags.Add("b");

        var prices = (IDictionary)Activator.CreateInstance(
            typeof(Dictionary<,>).MakeGenericType(productId, money))!;
        var pid = productId.GetMethod("New")!.Invoke(null, null);
        prices.Add(pid!, Activator.CreateInstance(money, 5m)!);

        var c = Activator.CreateInstance(catalog, id, tags, prices, null);

        var resultTags = (IEnumerable)catalog.GetProperty("Tags")!.GetValue(c)!;
        resultTags.Cast<object>().Count().ShouldBe(2);

        // Defensive copy: mutating the source set does not affect the stored set.
        tags.Add("c");
        ((IEnumerable)catalog.GetProperty("Tags")!.GetValue(c)!).Cast<object>().Count().ShouldBe(2);

        var resultPrices = (IDictionary)catalog.GetProperty("Prices")!.GetValue(c)!;
        resultPrices.Keys.Cast<object>().ShouldHaveSingleItem();
    }

    // ---- diagnostics -------------------------------------------------------

    [Fact]
    public void Optional_assigned_to_non_optional_is_reported()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    name: String\n    nickname: String?\n    display: String = nickname\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("optional value assigned to non-optional field 'display'"));
    }

    [Fact]
    public void Null_unsafe_access_on_optional_is_reported()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    nickname: String?\n    len: Int = nickname.length\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("optional value may be null"));
    }

    [Fact]
    public void Presence_check_then_coalesce_is_clean()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    name: String\n    nickname: String?\n    safe: String = nickname ?? name\n    has:  Bool = nickname.isPresent\n  }\n}\n";
        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Unknown_key_or_value_type_in_map_is_reported()
    {
        const string src =
            "context C {\n  value V {\n    m: Map<String, Nope>\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("unknown type 'Nope'"));
    }

    // ---- regressions found by the R2 review --------------------------------

    [Fact]
    public void Operator_args_align_with_reordered_constructor()
    {
        // Money has an optional field BEFORE the numeric one; the ctor reorders it
        // last, so the generated `operator *` must pass args in the reordered order.
        const string src =
            "context O {\n" +
            "  value Money { note: String?  amount: Decimal }\n" +
            "  value Line { qty: Int  price: Money  total: Money = price * qty }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var money = asm.GetType("O.Money")!;
        var line = asm.GetType("O.Line")!;
        var price = Activator.CreateInstance(money, 10m, null); // (decimal amount, string? note = null)
        var l = Activator.CreateInstance(line, 3, price);
        var total = line.GetProperty("Total")!.GetValue(l);
        money.GetProperty("Amount")!.GetValue(total).ShouldBe(30m);
    }

    [Fact]
    public void Presence_check_on_non_optional_is_reported()
    {
        const string src = "context C {\n  value V {\n    count: Int\n    has: Bool = count.isPresent\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("can only be applied to an optional value"));
    }

    [Fact]
    public void Arithmetic_on_optional_is_reported()
    {
        const string src = "context C {\n  entity E identified by EId {\n    age: Int?\n    twice: Int = age + age\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("optional value may be null"));
    }

    [Fact]
    public void Relational_on_optional_is_reported()
    {
        const string src = "context C {\n  entity E identified by EId {\n    age: Int?\n    big: Bool = age > 10\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("optional value may be null"));
    }

    [Fact]
    public void Sum_over_a_guard_narrowed_optional_selector_is_rejected()
    {
        // #1556: `qty` is guard-narrowed to present for the `then` branch, but the selector's
        // inferred TypeRef still carries IsOptional (narrowing is checker-only, never fed back
        // into TypeResolver), and the TS emitter can't render an optional-typed fold as valid
        // `tsc --strict` output — so this must be rejected here, at the validator, uniformly
        // across every emitter.
        const string src =
            "context C {\n" +
            "  value V {\n" +
            "    rate:  Decimal\n" +
            "    qty:   Int?\n" +
            "    rates: List<Decimal>\n" +
            "    total: Decimal? = if qty.isPresent then rates.sum(r => qty + r) else rate\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("sum requires a non-optional selector"));
    }

    [Fact]
    public void Max_over_a_selector_that_is_both_optional_and_not_orderable_reports_both_defects()
    {
        // Code-review finding on #1556: an early return after the new optionality diagnostic used to
        // swallow the pre-existing "not orderable" diagnostic below it, hiding one of two independent
        // defects until a second compile. Both must surface together.
        const string src =
            "context C {\n" +
            "  value Money { amount: Int }\n" +
            "  value Item { price: Money? }\n" +
            "  value V {\n" +
            "    items:   List<Item>\n" +
            "    biggest: Money = items.max(i => i.price)\n" +
            "  }\n" +
            "}\n";
        var diagnostics = Diagnose(src);
        diagnostics.ShouldContain(d => d.Message.Contains("max requires a non-optional selector"));
        diagnostics.ShouldContain(d => d.Message.Contains("max requires a comparable selector; 'Money' is not orderable"));
    }

    [Fact]
    public void Sum_over_a_selector_resolved_via_coalesce_is_accepted()
    {
        // `qty ?? 0` fully resolves to a non-optional Int before it ever reaches the selector body,
        // so the aggregate-selector check must not flag it.
        const string src =
            "context C {\n" +
            "  value V {\n" +
            "    qty:   Int?\n" +
            "    rates: List<Int>\n" +
            "    total: Int = rates.sum(r => (qty ?? 0) + r)\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();
    }

    [Fact]
    public void Coalesce_with_optional_fallback_stays_optional()
    {
        // name is also optional, so `nickname ?? name` is still optional -> can't fill String.
        const string src =
            "context C {\n  entity E identified by EId {\n    name: String?\n    nickname: String?\n    display: String = nickname ?? name\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("optional value assigned to non-optional field 'display'"));
    }

    [Fact]
    public void Conditional_with_optional_branch_stays_optional()
    {
        const string src =
            "context C {\n  entity E identified by EId {\n    name: String\n    nickname: String?\n    chosen: String = if name.isBlank then name else nickname\n  }\n}\n";
        Diagnose(src).ShouldContain(d => d.Message.Contains("optional value assigned to non-optional field 'chosen'"));
    }

    [Fact]
    public void Map_missing_value_type_is_reported()
    {
        Diagnose("context C {\n  value V {\n    m: Map<String>\n  }\n}\n").ShouldContain(d => d.Message.Contains("'Map' requires two type arguments"));
    }

    [Fact]
    public void List_with_extra_type_argument_is_reported()
    {
        Diagnose("context C {\n  value V {\n    xs: List<String, Int>\n  }\n}\n").ShouldContain(d => d.Message.Contains("'List' takes a single type argument"));
    }

    [Fact]
    public void Guarded_optional_access_is_clean_and_null_safe()
    {
        const string src =
            "context G {\n" +
            "  entity E identified by EId {\n" +
            "    name:     String\n" +
            "    nickname: String?\n" +
            "    safe:     Bool = if nickname.isPresent then nickname.length > 2 else false\n" +
            "    invariant nickname.length > 2 when nickname.isPresent \"nick too short\"\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty(); // no false-positive null-safety diagnostic

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var e = asm.GetType("G.E")!;
        var eid = asm.GetType("G.EId")!;
        var id = eid.GetMethod("New")!.Invoke(null, null);

        // nickname null: guard skipped, no throw; safe == false.
        var unset = Activator.CreateInstance(e, id, "Bob", null);
        ((bool)e.GetProperty("Safe")!.GetValue(unset)!).ShouldBeFalse();

        // nickname "abc": invariant holds (3 > 2); safe == true.
        var set = Activator.CreateInstance(e, id, "Bob", "abc");
        ((bool)e.GetProperty("Safe")!.GetValue(set)!).ShouldBeTrue();
    }

    [Fact]
    public void Collection_ops_work_on_a_set()
    {
        const string src =
            "context S {\n" +
            "  entity E identified by EId {\n" +
            "    tags: Set<String>\n" +
            "    n:    Int  = tags.count\n" +
            "    has:  Bool = tags.contains(\"x\")\n" +
            "  }\n" +
            "}\n";
        Diagnose(src).ShouldBeEmpty();

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));

        var e = asm.GetType("S.E")!;
        var eid = asm.GetType("S.EId")!;
        var id = eid.GetMethod("New")!.Invoke(null, null);
        var tags = (ISet<string>)Activator.CreateInstance(typeof(HashSet<string>))!;
        tags.Add("x");
        tags.Add("y");

        var inst = Activator.CreateInstance(e, id, tags);
        e.GetProperty("N")!.GetValue(inst).ShouldBe(2);
        ((bool)e.GetProperty("Has")!.GetValue(inst)!).ShouldBeTrue();
    }
}
