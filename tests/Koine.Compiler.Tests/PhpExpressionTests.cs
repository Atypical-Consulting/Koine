using System.Linq;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="PhpExpressionTranslator"/> — the pure translation of the
/// target-agnostic <see cref="Expr"/> sublanguage into PHP expression source. PHP uses
/// NATIVE operators (<c>+ - * / &lt; &lt;= === …</c> and <c>&amp;&amp;</c>/<c>||</c>/<c>!</c>)
/// throughout. Member identifiers render as <c>$this-&gt;camelProp</c> (Property mode) or bare
/// <c>$camelParam</c> (Parameter mode). Decimal literals construct via the runtime class.
/// </summary>
public class PhpExpressionTests
{
    // A model exercising a Decimal collection (for sum/min/max), a string, a list, and an enum,
    // so the translator's type-driven branches are reachable.
    private const string Source =
        """
        context Shop {
          enum OrderStatus { Draft, Placed, Cancelled }
          enum MassUnit { Gram, Kilogram }

          value Money { amount: Decimal }

          quantity Weight {
            amount: Decimal
            unit:   MassUnit
          }

          value Order {
            code: String
            quantity: Int
            status: OrderStatus
            note: String?
            price: Decimal
            limit: Decimal
            weight: Weight
            otherWeight: Weight
            prices: List<Decimal>
            lines: List<Money>
            tags: List<String>
            counts: List<Int>
          }
        }
        """;

    private static (PhpExpressionTranslator translator, IReadOnlyList<Member> members) Make()
    {
        var result = new KoineCompiler().Compile(Source, new PhpEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        var typeMapper = new PhpTypeMapper(index);
        var translator = new PhpExpressionTranslator(
            index, order.Members, index.EnumMemberToType, typeMapper, context: "Shop");
        return (translator, order.Members);
    }

    private static string Translate(Expr expr)
    {
        var (t, _) = Make();
        return t.Translate(expr);
    }

    private static IdentifierExpr Id(string name) => new(name);
    private static MemberAccessExpr Member(string target, string member) => new(Id(target), member);
    private static LiteralExpr Int(string text) => new(LiteralKind.Int, text);
    private static LiteralExpr Decimal(string text) => new(LiteralKind.Decimal, text);
    private static LiteralExpr Bool(bool b) => new(LiteralKind.Bool, b ? "true" : "false");

    // =========================================================================
    // Boolean operators
    // =========================================================================

    [Fact]
    public void And_lowers_to_php_and()
    {
        var expr = new BinaryExpr(BinaryOp.And, Id("a"), Id("b"));
        // `a`/`b` are not members, so they fall through to bare camelCase identifiers with $ prefix.
        Assert.Equal("($a && $b)", Translate(expr));
    }

    [Fact]
    public void Or_lowers_to_php_or()
    {
        var expr = new BinaryExpr(BinaryOp.Or, Id("a"), Id("b"));
        Assert.Equal("($a || $b)", Translate(expr));
    }

    [Fact]
    public void Not_lowers_to_php_bang()
    {
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        Assert.Equal("!($a)", Translate(expr));
    }

    // =========================================================================
    // Comparison — native operators, member as $this->camelProp
    // =========================================================================

    [Fact]
    public void Comparison_member_renders_this_arrow_property()
    {
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Assert.Equal("($this->quantity >= 1)", Translate(expr));
    }

    [Fact]
    public void Comparison_member_in_parameter_mode_is_dollar_var()
    {
        var (t, _) = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Assert.Equal("($quantity >= 1)", t.Translate(expr, PhpExpressionTranslator.NameMode.Parameter));
    }

    [Fact]
    public void Equality_uses_strict_triple_equals()
    {
        var expr = new BinaryExpr(BinaryOp.Eq, Id("quantity"), Int("0"));
        Assert.Equal("($this->quantity === 0)", Translate(expr));
    }

    [Fact]
    public void Inequality_uses_strict_not_equals()
    {
        var expr = new BinaryExpr(BinaryOp.Neq, Id("quantity"), Int("0"));
        Assert.Equal("($this->quantity !== 0)", Translate(expr));
    }

    // =========================================================================
    // Decimal operands — PHP has no operator overloading, so native operators on a
    // runtime Decimal are invalid; comparisons go through compareTo()/equals() and
    // arithmetic through add()/sub()/mul()/div(). A non-Decimal operand is wrapped.
    // =========================================================================

    [Fact]
    public void Decimal_comparison_against_int_literal_lowers_to_compareTo()
    {
        // `price >= 0` where price is Decimal -> price->compareTo(new Decimal('0')) >= 0
        var expr = new BinaryExpr(BinaryOp.Ge, Id("price"), Int("0"));
        Assert.Equal(
            "($this->price->compareTo(new \\Koine\\Runtime\\Decimal('0')) >= 0)",
            Translate(expr));
    }

    [Fact]
    public void Decimal_less_than_lowers_to_compareTo()
    {
        var expr = new BinaryExpr(BinaryOp.Lt, Id("price"), Int("0"));
        Assert.Equal(
            "($this->price->compareTo(new \\Koine\\Runtime\\Decimal('0')) < 0)",
            Translate(expr));
    }

    [Fact]
    public void Decimal_comparison_against_decimal_operand_uses_it_directly()
    {
        // `price < limit` where both are Decimal -> no wrapping of the right operand.
        var expr = new BinaryExpr(BinaryOp.Lt, Id("price"), Id("limit"));
        Assert.Equal(
            "($this->price->compareTo($this->limit) < 0)",
            Translate(expr));
    }

    [Fact]
    public void Decimal_equality_lowers_to_equals()
    {
        var eq = new BinaryExpr(BinaryOp.Eq, Id("price"), Decimal("0"));
        var ne = new BinaryExpr(BinaryOp.Neq, Id("price"), Decimal("0"));
        Assert.Equal("$this->price->equals(new \\Koine\\Runtime\\Decimal('0'))", Translate(eq));
        Assert.Equal("!$this->price->equals(new \\Koine\\Runtime\\Decimal('0'))", Translate(ne));
    }

    [Fact]
    public void Decimal_arithmetic_lowers_to_method_calls()
    {
        Assert.Equal("$this->price->add($this->limit)", Translate(new BinaryExpr(BinaryOp.Add, Id("price"), Id("limit"))));
        Assert.Equal("$this->price->sub($this->limit)", Translate(new BinaryExpr(BinaryOp.Sub, Id("price"), Id("limit"))));
        Assert.Equal("$this->price->mul($this->limit)", Translate(new BinaryExpr(BinaryOp.Mul, Id("price"), Id("limit"))));
        Assert.Equal("$this->price->div($this->limit)", Translate(new BinaryExpr(BinaryOp.Div, Id("price"), Id("limit"))));
    }

    [Fact]
    public void Decimal_arithmetic_wraps_int_operand_in_decimal()
    {
        // `price * quantity` (Decimal * Int) -> wrap the Int operand as a Decimal expression.
        var expr = new BinaryExpr(BinaryOp.Mul, Id("price"), Id("quantity"));
        Assert.Equal(
            "$this->price->mul(new \\Koine\\Runtime\\Decimal($this->quantity))",
            Translate(expr));
    }

    [Fact]
    public void Decimal_negated_comparison_flips_via_compareTo()
    {
        // The invariant-guard path: `price >= 0` negated must still use compareTo, not `<`.
        var (t, _) = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("price"), Int("0"));
        Assert.Equal(
            "$this->price->compareTo(new \\Koine\\Runtime\\Decimal('0')) < 0",
            t.TranslateNegated(expr));
    }

    // =========================================================================
    // Quantity / value-object operands — use the VO's generated methods.
    // =========================================================================

    [Fact]
    public void Quantity_times_scalar_lowers_to_multipliedBy()
    {
        // `weight * quantity` (Weight quantity * Int) -> weight->multipliedBy(new Decimal(quantity)).
        var expr = new BinaryExpr(BinaryOp.Mul, Id("weight"), Id("quantity"));
        Assert.Equal(
            "$this->weight->multipliedBy(new \\Koine\\Runtime\\Decimal($this->quantity))",
            Translate(expr));
    }

    [Fact]
    public void Quantity_divided_by_scalar_lowers_to_dividedBy()
    {
        var expr = new BinaryExpr(BinaryOp.Div, Id("weight"), Id("quantity"));
        Assert.Equal(
            "$this->weight->dividedBy(new \\Koine\\Runtime\\Decimal($this->quantity))",
            Translate(expr));
    }

    [Fact]
    public void Quantity_plus_quantity_lowers_to_add()
    {
        var expr = new BinaryExpr(BinaryOp.Add, Id("weight"), Id("otherWeight"));
        Assert.Equal("$this->weight->add($this->otherWeight)", Translate(expr));
    }

    [Fact]
    public void Quantity_minus_quantity_lowers_to_subtract()
    {
        var expr = new BinaryExpr(BinaryOp.Sub, Id("weight"), Id("otherWeight"));
        Assert.Equal("$this->weight->subtract($this->otherWeight)", Translate(expr));
    }

    [Fact]
    public void Value_object_add_with_vo_on_the_right_uses_the_vo_as_receiver()
    {
        // The VO is the RIGHT operand; the receiver must be the value object (not the literal),
        // otherwise we emit `1->add(...)` which is a fatal PHP error. The other operand is the arg.
        var expr = new BinaryExpr(BinaryOp.Add, Int("1"), Id("weight"));
        Assert.Equal("$this->weight->add(1)", Translate(expr));
    }

    [Fact]
    public void Value_object_subtract_with_vo_on_the_right_uses_the_vo_as_receiver()
    {
        var expr = new BinaryExpr(BinaryOp.Sub, Int("1"), Id("weight"));
        Assert.Equal("$this->weight->subtract(1)", Translate(expr));
    }

    [Fact]
    public void Value_object_equality_lowers_to_equals()
    {
        var eq = new BinaryExpr(BinaryOp.Eq, Id("weight"), Id("otherWeight"));
        var ne = new BinaryExpr(BinaryOp.Neq, Id("weight"), Id("otherWeight"));
        Assert.Equal("$this->weight->equals($this->otherWeight)", Translate(eq));
        Assert.Equal("!$this->weight->equals($this->otherWeight)", Translate(ne));
    }

    [Fact]
    public void Value_object_comparison_compares_underlying_amount()
    {
        // No generated VO comparison method, so compare the underlying Decimal amount accessor.
        var expr = new BinaryExpr(BinaryOp.Lt, Id("weight"), Id("otherWeight"));
        Assert.Equal(
            "($this->weight->amount->compareTo($this->otherWeight->amount) < 0)",
            Translate(expr));
    }

    // =========================================================================
    // Collection / string members
    // =========================================================================

    [Fact]
    public void IsEmpty_lowers_to_count_zero()
    {
        var expr = Member("lines", "isEmpty");
        Assert.Equal("count($this->lines) === 0", Translate(expr));
    }

    [Fact]
    public void IsNotEmpty_lowers_to_count_not_zero()
    {
        var expr = Member("lines", "isNotEmpty");
        Assert.Equal("count($this->lines) !== 0", Translate(expr));
    }

    [Fact]
    public void Length_lowers_to_strlen_for_strings_and_count_for_lists()
    {
        // `tags` is List<String>, so uses count()
        var expr = Member("tags", "length");
        Assert.Equal("count($this->tags)", Translate(expr));
    }

    [Fact]
    public void String_length_member_lowers_to_strlen()
    {
        // `code` is String, so uses strlen()
        var expr = Member("code", "length");
        Assert.Equal("strlen($this->code)", Translate(expr));
    }

    [Fact]
    public void Count_lowers_to_count()
    {
        var expr = Member("lines", "count");
        Assert.Equal("count($this->lines)", Translate(expr));
    }

    [Fact]
    public void StringOps_lower_to_php_functions()
    {
        Assert.Equal("trim($this->code)", Translate(Member("code", "trim")));
        Assert.Equal("strtolower($this->code)", Translate(Member("code", "lower")));
        Assert.Equal("strtoupper($this->code)", Translate(Member("code", "upper")));
        Assert.Equal("(trim($this->code) === '')", Translate(Member("code", "isBlank")));
    }

    [Fact]
    public void OptionalOps_lower_to_null_checks()
    {
        Assert.Equal("$this->note !== null", Translate(Member("note", "isPresent")));
        Assert.Equal("$this->note === null", Translate(Member("note", "isNone")));
    }

    // =========================================================================
    // Coalesce / ternary
    // =========================================================================

    [Fact]
    public void Coalesce_lowers_to_null_coalescing_operator()
    {
        var expr = new CoalesceExpr(Id("note"), new LiteralExpr(LiteralKind.String, "n/a"));
        Assert.Equal("($this->note ?? \"n/a\")", Translate(expr));
    }

    [Fact]
    public void Ternary_lowers_to_php_ternary()
    {
        var expr = new ConditionalExpr(
            new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1")),
            Int("10"),
            Int("0"));
        Assert.Equal("(($this->quantity >= 1) ? 10 : 0)", Translate(expr));
    }

    [Fact]
    public void Ternary_with_bool_literals_simplifies()
    {
        var cond = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Assert.Equal("($this->quantity >= 1)", Translate(new ConditionalExpr(cond, Bool(true), Bool(false))));
        Assert.Equal("!(($this->quantity >= 1))", Translate(new ConditionalExpr(cond, Bool(false), Bool(true))));
    }

    // =========================================================================
    // Calls
    // =========================================================================

    [Fact]
    public void Contains_on_string_lowers_to_str_contains()
    {
        var expr = new CallExpr(Id("code"), "contains", new Expr[] { new LiteralExpr(LiteralKind.String, "x") });
        Assert.Equal("str_contains($this->code, \"x\")", Translate(expr));
    }

    [Fact]
    public void Contains_on_list_lowers_to_in_array()
    {
        var expr = new CallExpr(Id("tags"), "contains", new Expr[] { new LiteralExpr(LiteralKind.String, "x") });
        Assert.Equal("in_array(\"x\", $this->tags, true)", Translate(expr));
    }

    [Fact]
    public void StartsWith_endsWith_lower_to_php_functions()
    {
        var sw = new CallExpr(Id("code"), "startsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "X") });
        var ew = new CallExpr(Id("code"), "endsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "Y") });
        Assert.Equal("str_starts_with($this->code, \"X\")", Translate(sw));
        Assert.Equal("str_ends_with($this->code, \"Y\")", Translate(ew));
    }

    [Fact]
    public void All_any_none_lower_to_array_comprehensions()
    {
        // `m.amount > 0` is a Decimal compared with an Int literal: PHP has no operator overloading,
        // so it lowers to compareTo() with the literal wrapped as a Decimal.
        var pred = new BinaryExpr(BinaryOp.Gt, new MemberAccessExpr(Id("m"), "amount"), Int("0"));
        var all = new CallExpr(Id("lines"), "all", new Expr[] { new LambdaExpr("m", pred) });
        var any = new CallExpr(Id("lines"), "any", new Expr[] { new LambdaExpr("m", pred) });
        var none = new CallExpr(Id("lines"), "none", new Expr[] { new LambdaExpr("m", pred) });
        const string cmp = "($m->amount->compareTo(new \\Koine\\Runtime\\Decimal('0')) > 0)";
        Assert.Equal($"array_reduce($this->lines, fn($carry, $m) => $carry && {cmp}, true)", Translate(all));
        Assert.Equal($"array_reduce($this->lines, fn($carry, $m) => $carry || {cmp}, false)", Translate(any));
        Assert.Equal($"!array_reduce($this->lines, fn($carry, $m) => $carry || {cmp}, false)", Translate(none));
    }

    // =========================================================================
    // Decimal-safe reductions
    // =========================================================================

    [Fact]
    public void Sum_of_Int_projection_uses_array_sum()
    {
        // Int projection: builtin array_sum should work
        var selector = new LambdaExpr("c", Id("c"));
        var expr = new CallExpr(Id("counts"), "sum", new Expr[] { selector });
        Assert.Equal("array_sum(array_map(fn($c) => $c, $this->counts))", Translate(expr));
    }

    [Fact]
    public void Sum_of_Decimal_projection_uses_koine_sum()
    {
        // Decimal projection: empty collection has no zero, so must raise — keep koine_sum.
        var selector = new LambdaExpr("p", Id("p"));
        var expr = new CallExpr(Id("prices"), "sum", new Expr[] { selector });
        Assert.Equal("\\Koine\\Runtime\\Decimal::sum(array_map(fn($p) => $p, $this->prices))", Translate(expr));
    }

    [Fact]
    public void Sum_of_value_object_projection_uses_koine_sum()
    {
        // Value-object (Money) projection: no zero value — keep runtime sum.
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "sum", new Expr[] { selector });
        Assert.Equal("\\Koine\\Runtime\\Decimal::sum(array_map(fn($m) => $m->amount, $this->lines))", Translate(expr));
    }

    [Fact]
    public void Min_max_use_runtime_helpers()
    {
        var selector = new LambdaExpr("p", new MemberAccessExpr(Id("p"), "amount"));
        var min = new CallExpr(Id("lines"), "min", new Expr[] { selector });
        var max = new CallExpr(Id("lines"), "max", new Expr[] { selector });
        Assert.Equal("\\Koine\\Runtime\\Decimal::min(array_map(fn($p) => $p->amount, $this->lines))", Translate(min));
        Assert.Equal("\\Koine\\Runtime\\Decimal::max(array_map(fn($p) => $p->amount, $this->lines))", Translate(max));
    }

    [Fact]
    public void DistinctBy_lowers_to_unique_count_comparison()
    {
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "distinctBy", new Expr[] { selector });
        Assert.Equal("count(array_unique(array_map(fn($m) => $m->amount, $this->lines))) === count($this->lines)", Translate(expr));
    }

    // =========================================================================
    // Regex match
    // =========================================================================

    [Fact]
    public void Matches_lowers_to_preg_match()
    {
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        Assert.Equal("(bool)preg_match('/[A-Z]{3}/', $this->code)", Translate(expr));
    }

    [Fact]
    public void Matches_escapes_a_slash_in_the_pattern()
    {
        // A `/` in the pattern would otherwise close the PCRE `/.../` delimiter early — emitting a
        // broken regex that preg_match rejects (warning + always-false). It must be escaped to `\/`.
        var expr = new MatchExpr(Id("code"), "a/b");
        Assert.Equal("(bool)preg_match('/a\\/b/', $this->code)", Translate(expr));
    }

    // =========================================================================
    // Let — closure application
    // =========================================================================

    [Fact]
    public void Let_lowers_to_immediately_invoked_closures()
    {
        var bindings = new[]
        {
            new LetBinding("x", Int("1")),
            new LetBinding("y", Int("2")),
        };
        var body = new BinaryExpr(BinaryOp.Add, Id("x"), Id("y"));
        var expr = new LetExpr(bindings, body);
        Assert.Equal("(fn($x) => (fn($y) => ($x + $y))(2))(1)", Translate(expr));
    }

    // =========================================================================
    // Enum access & literals
    // =========================================================================

    [Fact]
    public void Qualified_enum_access_renders_class_constant()
    {
        var expr = new MemberAccessExpr(Id("OrderStatus"), "Cancelled");
        Assert.Equal("OrderStatus::CANCELLED", Translate(expr));
    }

    [Fact]
    public void Decimal_literal_renders_runtime_decimal_constructor()
    {
        var expr = new LiteralExpr(LiteralKind.Decimal, "9.99");
        Assert.Equal("new \\Koine\\Runtime\\Decimal('9.99')", Translate(expr));
    }

    [Fact]
    public void Bool_literals_render_php_lowercase()
    {
        Assert.Equal("true", Translate(Bool(true)));
        Assert.Equal("false", Translate(Bool(false)));
    }

    [Fact]
    public void String_literal_is_double_quoted_and_escaped()
    {
        var expr = new LiteralExpr(LiteralKind.String, "a\"b\\c");
        Assert.Equal("\"a\\\"b\\\\c\"", Translate(expr));
    }

    // =========================================================================
    // TranslateNegated
    // =========================================================================

    [Fact]
    public void TranslateNegated_flips_comparison()
    {
        var (t, _) = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Assert.Equal("$this->quantity < 1", t.TranslateNegated(expr));
    }

    [Fact]
    public void TranslateNegated_peels_not()
    {
        var (t, _) = Make();
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        Assert.Equal("$a", t.TranslateNegated(expr));
    }

    [Fact]
    public void TranslateNegated_wraps_other_expressions()
    {
        var (t, _) = Make();
        var expr = Member("lines", "isEmpty");
        Assert.Equal("!(count($this->lines) === 0)", t.TranslateNegated(expr));
    }
}
