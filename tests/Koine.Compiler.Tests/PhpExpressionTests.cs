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

          value Money { amount: Decimal }

          value Order {
            code: String
            quantity: Int
            status: OrderStatus
            note: String?
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
        var pred = new BinaryExpr(BinaryOp.Gt, new MemberAccessExpr(Id("m"), "amount"), Int("0"));
        var all = new CallExpr(Id("lines"), "all", new Expr[] { new LambdaExpr("m", pred) });
        var any = new CallExpr(Id("lines"), "any", new Expr[] { new LambdaExpr("m", pred) });
        var none = new CallExpr(Id("lines"), "none", new Expr[] { new LambdaExpr("m", pred) });
        Assert.Equal("array_reduce($this->lines, fn($carry, $m) => $carry && ($m->amount > 0), true)", Translate(all));
        Assert.Equal("array_reduce($this->lines, fn($carry, $m) => $carry || ($m->amount > 0), false)", Translate(any));
        Assert.Equal("!array_reduce($this->lines, fn($carry, $m) => $carry || ($m->amount > 0), false)", Translate(none));
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
