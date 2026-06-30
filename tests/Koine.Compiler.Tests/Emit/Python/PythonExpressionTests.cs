using Koine.Compiler.Ast;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="PythonExpressionTranslator"/> — the pure translation of the
/// target-agnostic <see cref="Expr"/> sublanguage into Python expression source. Python uses
/// NATIVE operators (<c>+ - * / &lt; &lt;= == …</c> and <c>and</c>/<c>or</c>/<c>not</c>) rather
/// than the TypeScript emitter's method-call lowering, so the assertions read close to the
/// emitted Python. Member identifiers render as <c>self.&lt;snake&gt;</c> (Property mode) or bare
/// <c>&lt;snake&gt;</c> (Parameter mode); Decimal-safe reductions route through the runtime
/// fold helpers (<c>koine_sum</c>/<c>koine_min</c>/<c>koine_max</c>).
/// </summary>
public class PythonExpressionTests
{
    // A model exercising a Decimal collection (for sum/min/max), a string, a list, and an enum,
    // so the translator's type-driven branches are reachable.
    private const string Source =
        """
        context Shop {
          enum OrderStatus { Draft, Placed, Cancelled }

          value Money { amount: Decimal }

          value Order {
            code: String
            quantity: Int
            total: Int
            discount: Int?
            subtotal: Decimal
            money: Money
            status: OrderStatus
            note: String?
            prices: List<Decimal>
            lines: List<Money>
            tags: List<String>
            counts: List<Int>
          }

          aggregate Cart root Basket {
            entity CartLine identified by CartLineId {
              sku: String
              qty: Int
            }
            entity Basket identified by BasketId {
              items: List<CartLine>
            }
          }
        }
        """;

    private static PythonExpressionTranslator Make()
    {
        var result = new KoineCompiler().Compile(Source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        var typeMapper = new PythonTypeMapper(index);
        var translator = new PythonExpressionTranslator(
            index, order.Members, index.EnumMemberToType, typeMapper, context: "Shop");
        return translator;
    }

    private static string Translate(Expr expr)
    {
        var t = Make();
        return t.Translate(expr);
    }

    // A translator whose member scope is an entity (rather than the Order value object), so a
    // selector projecting to an entity type — e.g. distinctBy(i => i) over List<CartLine> — is
    // reachable. CartLine/Basket are child/root entities of the Cart aggregate above (issue #712).
    private static PythonExpressionTranslator MakeForEntity(string entityName)
    {
        var result = new KoineCompiler().Compile(Source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var entity = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<EntityDecl>()
            .First(e => e.Name == entityName);

        var typeMapper = new PythonTypeMapper(index);
        return new PythonExpressionTranslator(
            index, entity.Members, index.EnumMemberToType, typeMapper, context: "Shop");
    }

    // A translator carrying the neutral RegexMatchTimeoutMs author intent (#812), so a `matches`
    // guard lowers to the third-party `regex` module's bounded `regex.search(..., timeout=…)`.
    private static PythonExpressionTranslator MakeWithTimeout(int milliseconds)
    {
        var result = new KoineCompiler().Compile(Source, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        var typeMapper = new PythonTypeMapper(index);
        return new PythonExpressionTranslator(
            index, order.Members, index.EnumMemberToType, typeMapper, context: "Shop",
            regexMatchTimeoutMs: milliseconds);
    }

    private static IdentifierExpr Id(string name) => new(name);
    private static MemberAccessExpr Member(string target, string member) => new(Id(target), member);
    private static LiteralExpr Int(string text) => new(LiteralKind.Int, text);
    private static LiteralExpr Dec(string text) => new(LiteralKind.Decimal, text);
    private static LiteralExpr Bool(bool b) => new(LiteralKind.Bool, b ? "true" : "false");

    // =========================================================================
    // Boolean operators
    // =========================================================================

    [Fact]
    public void And_lowers_to_python_and()
    {
        var expr = new BinaryExpr(BinaryOp.And, Id("a"), Id("b"));
        // `a`/`b` are not members, so they fall through to bare snake identifiers.
        Translate(expr).ShouldBe("(a and b)");
    }

    [Fact]
    public void Or_lowers_to_python_or()
    {
        var expr = new BinaryExpr(BinaryOp.Or, Id("a"), Id("b"));
        Translate(expr).ShouldBe("(a or b)");
    }

    [Fact]
    public void Not_lowers_to_python_not()
    {
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        Translate(expr).ShouldBe("not (a)");
    }

    // =========================================================================
    // Comparison — native operators, member as self.<snake>
    // =========================================================================

    [Fact]
    public void Comparison_member_renders_self_property()
    {
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Translate(expr).ShouldBe("(self.quantity >= 1)");
    }

    [Fact]
    public void Comparison_member_in_parameter_mode_is_bare()
    {
        var t = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        t.Translate(expr, PythonExpressionTranslator.NameMode.Parameter).ShouldBe("(quantity >= 1)");
    }

    // =========================================================================
    // Arithmetic — Int division must floor (Python `/` is true division → float)
    // =========================================================================

    [Fact]
    public void IntDivInt_lowers_to_floor_division()
    {
        // Koine types `Int / Int` as `Int` (matching C# integer division), but Python `/` is
        // *true* division and yields a float. The translator must emit `//` so the result stays
        // int-typed and int-valued. Regression for #611.
        var expr = new BinaryExpr(BinaryOp.Div, Id("total"), Id("quantity"));
        Translate(expr).ShouldBe("(self.total // self.quantity)");
    }

    [Fact]
    public void OptionalIntDivInt_lowers_to_floor_division()
    {
        // The resolver carries optionality on `Int`, so `Int? / Int` still resolves to the `Int`
        // name and must floor-divide.
        var expr = new BinaryExpr(BinaryOp.Div, Id("discount"), Id("quantity"));
        Translate(expr).ShouldBe("(self.discount // self.quantity)");
    }

    [Fact]
    public void NestedIntDivision_floors_at_every_level()
    {
        // `(total / quantity) / quantity` — the inner `Int / Int` resolves to `Int`, so the outer
        // division is also `Int / Int` and both must floor.
        var inner = new BinaryExpr(BinaryOp.Div, Id("total"), Id("quantity"));
        var outer = new BinaryExpr(BinaryOp.Div, inner, Id("quantity"));
        Translate(outer).ShouldBe("((self.total // self.quantity) // self.quantity)");
    }

    [Fact]
    public void IntDivByIntLiteral_floors()
    {
        // A bare integer literal divisor resolves to `Int`, so it must floor-divide too.
        var expr = new BinaryExpr(BinaryOp.Div, Id("total"), Int("2"));
        Translate(expr).ShouldBe("(self.total // 2)");
    }

    [Fact]
    public void DecimalDivisor_stays_true_division()
    {
        // A Decimal operand makes the result Decimal; decimal.Decimal `/` is the correct (true)
        // division, so the lowering must NOT touch it.
        var decOverInt = new BinaryExpr(BinaryOp.Div, Id("subtotal"), Id("quantity"));
        var intOverDec = new BinaryExpr(BinaryOp.Div, Id("quantity"), Id("subtotal"));
        Translate(decOverInt).ShouldBe("(self.subtotal / self.quantity)");
        Translate(intOverDec).ShouldBe("(self.quantity / self.subtotal)");
    }

    // =========================================================================
    // Reversed scalar * value-object (#788) — `0.9 * money` (scalar on the LEFT).
    // Unlike TypeScript/PHP, the Python translator stays type-blind and keeps the
    // NATIVE infix `Decimal("0.9") * self.money`; the reversed multiply is made to
    // work at the value-object boundary instead — the generated frozen-dataclass
    // value object gains `__rmul__` (delegating to `__mul__`), so Python's reflected
    // operand fallback (Decimal.__mul__(Money) → NotImplemented → Money.__rmul__)
    // resolves. Mirrors the merged PHP Bug-2 fix (#778).
    // =========================================================================

    [Fact]
    public void Reversed_scalar_times_value_object_keeps_native_infix()
    {
        // The translator is UNCHANGED — it must keep emitting native infix; the fix is the value
        // object's new `__rmul__`, not a translator lowering (a regression guard for that invariant).
        var reversed = new BinaryExpr(BinaryOp.Mul, Dec("0.9"), Id("money"));
        Translate(reversed).ShouldBe("(Decimal(\"0.9\") * self.money)");
    }

    [Fact]
    public void Scalar_multiplied_value_object_emits_rmul_delegating_to_mul()
    {
        // The issue's minimal model: a value object multiplied by a scalar on either side. The
        // emitted value object must carry `__rmul__` delegating to `__mul__`, so `0.9 * base`
        // (which Python lowers to `Decimal("0.9").__mul__(Money)` → NotImplemented → the reflected
        // `Money.__rmul__`) no longer raises `TypeError` and stays `mypy --strict`-clean.
        const string src =
            """
            context Shop {
              value Money {
                amount: Decimal
                invariant amount >= 0 "an amount cannot be negative"
              }
              value Line {
                base: Money
                discounted: Money = base * 0.9
                surcharged: Money = 1.1 * base
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var money = result.Files
            .First(f => f.RelativePath.EndsWith("value_objects/money.py", StringComparison.Ordinal))
            .Contents;

        // `__mul__` already exists; `__rmul__` must be emitted alongside it, delegating to `__mul__`.
        money.ShouldContain("def __mul__(self, factor:");
        money.ShouldContain("def __rmul__(self, factor:");
        money.ShouldContain("return self.__mul__(factor)");
    }

    // =========================================================================
    // Collection / string members
    // =========================================================================

    [Fact]
    public void IsEmpty_lowers_to_len_zero()
    {
        var expr = Member("lines", "isEmpty");
        Translate(expr).ShouldBe("len(self.lines) == 0");
    }

    [Fact]
    public void IsNotEmpty_lowers_to_len_not_zero()
    {
        var expr = Member("lines", "isNotEmpty");
        Translate(expr).ShouldBe("len(self.lines) != 0");
    }

    [Fact]
    public void Length_lowers_to_len()
    {
        var expr = Member("tags", "length");
        Translate(expr).ShouldBe("len(self.tags)");
    }

    [Fact]
    public void Count_lowers_to_len()
    {
        var expr = Member("lines", "count");
        Translate(expr).ShouldBe("len(self.lines)");
    }

    [Fact]
    public void StringOps_lower_natively()
    {
        Translate(Member("code", "trim")).ShouldBe("self.code.strip()");
        Translate(Member("code", "lower")).ShouldBe("self.code.lower()");
        Translate(Member("code", "upper")).ShouldBe("self.code.upper()");
        Translate(Member("code", "isBlank")).ShouldBe("(not self.code or self.code.isspace())");
    }

    [Fact]
    public void OptionalOps_lower_to_none_checks()
    {
        Translate(Member("note", "isPresent")).ShouldBe("self.note is not None");
        Translate(Member("note", "isNone")).ShouldBe("self.note is None");
    }

    // =========================================================================
    // Coalesce / ternary
    // =========================================================================

    [Fact]
    public void Coalesce_lowers_to_conditional_expression()
    {
        var expr = new CoalesceExpr(Id("note"), new LiteralExpr(LiteralKind.String, "n/a"));
        Translate(expr).ShouldBe("(self.note if self.note is not None else \"n/a\")");
    }

    [Fact]
    public void Ternary_lowers_to_python_conditional_expression()
    {
        var expr = new ConditionalExpr(
            new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1")),
            Int("10"),
            Int("0"));
        Translate(expr).ShouldBe("(10 if (self.quantity >= 1) else 0)");
    }

    [Fact]
    public void Ternary_with_bool_literals_simplifies()
    {
        var cond = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Translate(new ConditionalExpr(cond, Bool(true), Bool(false))).ShouldBe("(self.quantity >= 1)");
        Translate(new ConditionalExpr(cond, Bool(false), Bool(true))).ShouldBe("not ((self.quantity >= 1))");
    }

    // =========================================================================
    // Calls
    // =========================================================================

    [Fact]
    public void Contains_lowers_to_in()
    {
        var expr = new CallExpr(Id("tags"), "contains", new Expr[] { new LiteralExpr(LiteralKind.String, "x") });
        Translate(expr).ShouldBe("(\"x\" in self.tags)");
    }

    [Fact]
    public void StartsWith_endsWith_lower_natively()
    {
        var sw = new CallExpr(Id("code"), "startsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "X") });
        var ew = new CallExpr(Id("code"), "endsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "Y") });
        Translate(sw).ShouldBe("self.code.startswith(\"X\")");
        Translate(ew).ShouldBe("self.code.endswith(\"Y\")");
    }

    [Fact]
    public void All_any_none_lower_to_comprehensions()
    {
        var pred = new BinaryExpr(BinaryOp.Gt, new MemberAccessExpr(Id("m"), "amount"), Int("0"));
        var all = new CallExpr(Id("lines"), "all", new Expr[] { new LambdaExpr("m", pred) });
        var any = new CallExpr(Id("lines"), "any", new Expr[] { new LambdaExpr("m", pred) });
        var none = new CallExpr(Id("lines"), "none", new Expr[] { new LambdaExpr("m", pred) });
        Translate(all).ShouldBe("all((m.amount > 0) for m in self.lines)");
        Translate(any).ShouldBe("any((m.amount > 0) for m in self.lines)");
        Translate(none).ShouldBe("not any((m.amount > 0) for m in self.lines)");
    }

    // =========================================================================
    // Decimal-safe reductions via runtime fold helpers
    // =========================================================================

    [Fact]
    public void Sum_of_Int_projection_uses_builtin_sum_returning_zero_on_empty()
    {
        // Int projection: empty collection must return 0 (matches C#/TS).
        // Expect Python builtin `sum(...)`, NOT `koine_sum(...)`.
        var selector = new LambdaExpr("c", Id("c"));
        var expr = new CallExpr(Id("counts"), "sum", new Expr[] { selector });
        Translate(expr).ShouldBe("sum(c for c in self.counts)");
    }

    [Fact]
    public void Sum_of_Decimal_projection_uses_koine_sum_guarding_empty()
    {
        // Decimal projection: empty collection has no zero, so must raise — keep koine_sum.
        var selector = new LambdaExpr("p", Id("p"));
        var expr = new CallExpr(Id("prices"), "sum", new Expr[] { selector });
        Translate(expr).ShouldBe("koine_sum(p for p in self.prices)");
    }

    [Fact]
    public void Sum_of_value_object_projection_uses_koine_sum_guarding_empty()
    {
        // Value-object (Money) projection: no zero value — keep koine_sum.
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "sum", new Expr[] { selector });
        Translate(expr).ShouldBe("koine_sum(m.amount for m in self.lines)");
    }

    [Fact]
    public void Min_max_use_empty_guarded_runtime_helpers()
    {
        var selector = new LambdaExpr("p", new MemberAccessExpr(Id("p"), "amount"));
        var min = new CallExpr(Id("lines"), "min", new Expr[] { selector });
        var max = new CallExpr(Id("lines"), "max", new Expr[] { selector });
        Translate(min).ShouldBe("koine_min(p.amount for p in self.lines)");
        Translate(max).ShouldBe("koine_max(p.amount for p in self.lines)");
    }

    [Fact]
    public void DistinctBy_lowers_to_set_length_comparison()
    {
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "distinctBy", new Expr[] { selector });
        Translate(expr).ShouldBe("len({m.amount for m in self.lines}) == len(self.lines)");
    }

    [Fact]
    public void DistinctBy_with_entity_selector_dedupes_by_id_via_the_set()
    {
        // Entity projection (CartLine): unlike PHP's array_unique (string cast, #687) or a JS Set
        // (reference identity, #712-TS), a Python set dedupes by __hash__/__eq__ — and the emitter
        // gives every entity an identity __eq__/__hash__ over its id. So `len({i for i in self.items})`
        // already counts distinct entities BY ID, matching C#'s `.Distinct()` and PHP (post-#687). The
        // set is the correct, idiomatic Python path here — no first-occurrence fold is needed (#712).
        var t = MakeForEntity("Basket");
        var expr = new CallExpr(Id("items"), "distinctBy", new Expr[] { new LambdaExpr("i", Id("i")) });
        t.Translate(expr).ShouldBe("len({i for i in self.items}) == len(self.items)");
    }

    // =========================================================================
    // Regex match
    // =========================================================================

    [Fact]
    public void Matches_lowers_to_re_search()
    {
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        Translate(expr).ShouldBe("(re.search(r\"[A-Z]{3}\", self.code) is not None)");
    }

    [Fact]
    public void Matches_with_timeout_lowers_to_regex_search_with_timeout()
    {
        // The neutral RegexMatchTimeoutMs key set (#812) ⇒ the bounded `regex` module form: 250 ms
        // renders as the seconds-float `timeout=0.25`; stdlib `re` is left behind (it has no timeout).
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        MakeWithTimeout(250).Translate(expr)
            .ShouldBe("(regex.search(r\"[A-Z]{3}\", self.code, timeout=0.25) is not None)");
    }

    [Theory]
    [InlineData(1000, "1")]
    [InlineData(1500, "1.5")]
    [InlineData(100, "0.1")]
    [InlineData(1, "0.001")]
    public void Matches_timeout_renders_milliseconds_as_an_exact_seconds_float(int ms, string seconds)
    {
        // ms/1000 is exact decimal arithmetic (no lossy truncation) rendered with the invariant culture.
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        MakeWithTimeout(ms).Translate(expr)
            .ShouldBe($"(regex.search(r\"[A-Z]{{3}}\", self.code, timeout={seconds}) is not None)");
    }

    [Fact]
    public void Matches_invariant_unset_emits_stdlib_re_and_no_regex_dependency()
    {
        // Key unset ⇒ byte-identical to today: stdlib `re`, `import re`, and NO third-party `regex`.
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("email.py")).Contents;
        email.ShouldContain("re.search(");
        email.ShouldContain("import re\n");
        email.ShouldNotContain("regex.search(");
        email.ShouldNotContain("import regex");
    }

    [Fact]
    public void Matches_invariant_with_timeout_emits_regex_module_and_its_import()
    {
        // Key set ⇒ the emitter threads the bound through PythonEmitterOptions to the `matches` guard:
        // the bounded `regex.search(..., timeout=…)` form AND an `import regex` (with the opt-in note),
        // and the stdlib `re.search` is gone.
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var emitter = new PythonEmitter(PythonEmitterOptions.Empty with { RegexMatchTimeoutMs = 250 });
        var result = new KoineCompiler().Compile(src, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var email = result.Files.Single(f => f.RelativePath.EndsWith("email.py")).Contents;
        email.ShouldContain("regex.search(");
        email.ShouldContain("timeout=0.25");
        email.ShouldContain("import regex");
        email.ShouldNotContain("re.search(");
    }

    // =========================================================================
    // Let — IIFE lambdas
    // =========================================================================

    [Fact]
    public void Let_lowers_to_nested_iife_lambdas()
    {
        var bindings = new[]
        {
            new LetBinding("x", Int("1")),
            new LetBinding("y", Int("2")),
        };
        var body = new BinaryExpr(BinaryOp.Add, Id("x"), Id("y"));
        var expr = new LetExpr(bindings, body);
        Translate(expr).ShouldBe("(lambda x: (lambda y: (x + y))(2))(1)");
    }

    // =========================================================================
    // Enum access & literals
    // =========================================================================

    [Fact]
    public void Qualified_enum_access_renders_upper_snake_member()
    {
        var expr = new MemberAccessExpr(Id("OrderStatus"), "Cancelled");
        Translate(expr).ShouldBe("OrderStatus.CANCELLED");
    }

    [Fact]
    public void Decimal_literal_renders_money_safe_decimal()
    {
        var expr = new LiteralExpr(LiteralKind.Decimal, "9.99");
        Translate(expr).ShouldBe("Decimal(\"9.99\")");
    }

    [Fact]
    public void Bool_literals_render_python_capitalised()
    {
        Translate(Bool(true)).ShouldBe("True");
        Translate(Bool(false)).ShouldBe("False");
    }

    [Fact]
    public void String_literal_is_double_quoted_and_escaped()
    {
        var expr = new LiteralExpr(LiteralKind.String, "a\"b\\c");
        Translate(expr).ShouldBe("\"a\\\"b\\\\c\"");
    }

    // =========================================================================
    // TranslateNegated
    // =========================================================================

    [Fact]
    public void TranslateNegated_flips_comparison()
    {
        var t = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        t.TranslateNegated(expr).ShouldBe("self.quantity < 1");
    }

    [Fact]
    public void TranslateNegated_peels_not()
    {
        var t = Make();
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        t.TranslateNegated(expr).ShouldBe("a");
    }

    [Fact]
    public void TranslateNegated_wraps_other_expressions()
    {
        var t = Make();
        var expr = Member("lines", "isEmpty");
        t.TranslateNegated(expr).ShouldBe("not (len(self.lines) == 0)");
    }

    [Fact]
    public void User_field_named_after_member_op_emits_attribute_access_not_op_form()
    {
        // #672 (follow-up to #605): a user field named after an UNSAFE built-in member-op
        // (isEmpty/trim/…) must emit a plain attribute access, mirroring the #605 semantic
        // resolution — not the op form (`len(self.inner) == 0` / `self.inner.strip()`), which
        // targets a receiver that has no such op and is therefore wrong Python.
        const string src =
            """
            context Demo {
              value Inner {
                isEmpty: Bool
                trim:    String
              }
              value Outer {
                inner: Inner
                flag: Bool   = inner.isEmpty
                name: String = inner.trim
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var source = string.Join("\n", result.Files.Select(f => f.Contents));
        source.ShouldContain("self.inner.is_empty");
        source.ShouldContain("self.inner.trim");
        source.ShouldNotContain("len(self.inner)");
        source.ShouldNotContain("self.inner.strip()");
    }
}
