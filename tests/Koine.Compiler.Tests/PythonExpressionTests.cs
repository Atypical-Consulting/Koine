using System.Linq;
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
            status: OrderStatus
            note: String?
            prices: List<Decimal>
            lines: List<Money>
            tags: List<String>
          }
        }
        """;

    private static (PythonExpressionTranslator translator, IReadOnlyList<Member> members) Make()
    {
        var result = new KoineCompiler().Compile(Source, new PythonEmitter());
        Assert.True(result.Success, string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

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
    public void And_lowers_to_python_and()
    {
        var expr = new BinaryExpr(BinaryOp.And, Id("a"), Id("b"));
        // `a`/`b` are not members, so they fall through to bare snake identifiers.
        Assert.Equal("(a and b)", Translate(expr));
    }

    [Fact]
    public void Or_lowers_to_python_or()
    {
        var expr = new BinaryExpr(BinaryOp.Or, Id("a"), Id("b"));
        Assert.Equal("(a or b)", Translate(expr));
    }

    [Fact]
    public void Not_lowers_to_python_not()
    {
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        Assert.Equal("not (a)", Translate(expr));
    }

    // =========================================================================
    // Comparison — native operators, member as self.<snake>
    // =========================================================================

    [Fact]
    public void Comparison_member_renders_self_property()
    {
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Assert.Equal("(self.quantity >= 1)", Translate(expr));
    }

    [Fact]
    public void Comparison_member_in_parameter_mode_is_bare()
    {
        var (t, _) = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Assert.Equal("(quantity >= 1)", t.Translate(expr, PythonExpressionTranslator.NameMode.Parameter));
    }

    // =========================================================================
    // Collection / string members
    // =========================================================================

    [Fact]
    public void IsEmpty_lowers_to_len_zero()
    {
        var expr = Member("lines", "isEmpty");
        Assert.Equal("len(self.lines) == 0", Translate(expr));
    }

    [Fact]
    public void IsNotEmpty_lowers_to_len_not_zero()
    {
        var expr = Member("lines", "isNotEmpty");
        Assert.Equal("len(self.lines) != 0", Translate(expr));
    }

    [Fact]
    public void Length_lowers_to_len()
    {
        var expr = Member("tags", "length");
        Assert.Equal("len(self.tags)", Translate(expr));
    }

    [Fact]
    public void Count_lowers_to_len()
    {
        var expr = Member("lines", "count");
        Assert.Equal("len(self.lines)", Translate(expr));
    }

    [Fact]
    public void StringOps_lower_natively()
    {
        Assert.Equal("self.code.strip()", Translate(Member("code", "trim")));
        Assert.Equal("self.code.lower()", Translate(Member("code", "lower")));
        Assert.Equal("self.code.upper()", Translate(Member("code", "upper")));
        Assert.Equal("(not self.code or self.code.isspace())", Translate(Member("code", "isBlank")));
    }

    [Fact]
    public void OptionalOps_lower_to_none_checks()
    {
        Assert.Equal("self.note is not None", Translate(Member("note", "isPresent")));
        Assert.Equal("self.note is None", Translate(Member("note", "isNone")));
    }

    // =========================================================================
    // Coalesce / ternary
    // =========================================================================

    [Fact]
    public void Coalesce_lowers_to_conditional_expression()
    {
        var expr = new CoalesceExpr(Id("note"), new LiteralExpr(LiteralKind.String, "n/a"));
        Assert.Equal("(self.note if self.note is not None else \"n/a\")", Translate(expr));
    }

    [Fact]
    public void Ternary_lowers_to_python_conditional_expression()
    {
        var expr = new ConditionalExpr(
            new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1")),
            Int("10"),
            Int("0"));
        Assert.Equal("(10 if (self.quantity >= 1) else 0)", Translate(expr));
    }

    [Fact]
    public void Ternary_with_bool_literals_simplifies()
    {
        var cond = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        Assert.Equal("(self.quantity >= 1)", Translate(new ConditionalExpr(cond, Bool(true), Bool(false))));
        Assert.Equal("not ((self.quantity >= 1))", Translate(new ConditionalExpr(cond, Bool(false), Bool(true))));
    }

    // =========================================================================
    // Calls
    // =========================================================================

    [Fact]
    public void Contains_lowers_to_in()
    {
        var expr = new CallExpr(Id("tags"), "contains", new Expr[] { new LiteralExpr(LiteralKind.String, "x") });
        Assert.Equal("(\"x\" in self.tags)", Translate(expr));
    }

    [Fact]
    public void StartsWith_endsWith_lower_natively()
    {
        var sw = new CallExpr(Id("code"), "startsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "X") });
        var ew = new CallExpr(Id("code"), "endsWith", new Expr[] { new LiteralExpr(LiteralKind.String, "Y") });
        Assert.Equal("self.code.startswith(\"X\")", Translate(sw));
        Assert.Equal("self.code.endswith(\"Y\")", Translate(ew));
    }

    [Fact]
    public void All_any_none_lower_to_comprehensions()
    {
        var pred = new BinaryExpr(BinaryOp.Gt, new MemberAccessExpr(Id("m"), "amount"), Int("0"));
        var all = new CallExpr(Id("lines"), "all", new Expr[] { new LambdaExpr("m", pred) });
        var any = new CallExpr(Id("lines"), "any", new Expr[] { new LambdaExpr("m", pred) });
        var none = new CallExpr(Id("lines"), "none", new Expr[] { new LambdaExpr("m", pred) });
        Assert.Equal("all((m.amount > 0) for m in self.lines)", Translate(all));
        Assert.Equal("any((m.amount > 0) for m in self.lines)", Translate(any));
        Assert.Equal("not any((m.amount > 0) for m in self.lines)", Translate(none));
    }

    // =========================================================================
    // Decimal-safe reductions via runtime fold helpers
    // =========================================================================

    [Fact]
    public void Sum_uses_decimal_safe_runtime_helper()
    {
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "sum", new Expr[] { selector });
        Assert.Equal("koine_sum(m.amount for m in self.lines)", Translate(expr));
    }

    [Fact]
    public void Min_max_use_empty_guarded_runtime_helpers()
    {
        var selector = new LambdaExpr("p", new MemberAccessExpr(Id("p"), "amount"));
        var min = new CallExpr(Id("lines"), "min", new Expr[] { selector });
        var max = new CallExpr(Id("lines"), "max", new Expr[] { selector });
        Assert.Equal("koine_min(p.amount for p in self.lines)", Translate(min));
        Assert.Equal("koine_max(p.amount for p in self.lines)", Translate(max));
    }

    [Fact]
    public void DistinctBy_lowers_to_set_length_comparison()
    {
        var selector = new LambdaExpr("m", new MemberAccessExpr(Id("m"), "amount"));
        var expr = new CallExpr(Id("lines"), "distinctBy", new Expr[] { selector });
        Assert.Equal("len({m.amount for m in self.lines}) == len(self.lines)", Translate(expr));
    }

    // =========================================================================
    // Regex match
    // =========================================================================

    [Fact]
    public void Matches_lowers_to_re_search()
    {
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        Assert.Equal("(re.search(r\"[A-Z]{3}\", self.code) is not None)", Translate(expr));
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
        Assert.Equal("(lambda x: (lambda y: (x + y))(2))(1)", Translate(expr));
    }

    // =========================================================================
    // Enum access & literals
    // =========================================================================

    [Fact]
    public void Qualified_enum_access_renders_upper_snake_member()
    {
        var expr = new MemberAccessExpr(Id("OrderStatus"), "Cancelled");
        Assert.Equal("OrderStatus.CANCELLED", Translate(expr));
    }

    [Fact]
    public void Decimal_literal_renders_money_safe_decimal()
    {
        var expr = new LiteralExpr(LiteralKind.Decimal, "9.99");
        Assert.Equal("Decimal(\"9.99\")", Translate(expr));
    }

    [Fact]
    public void Bool_literals_render_python_capitalised()
    {
        Assert.Equal("True", Translate(Bool(true)));
        Assert.Equal("False", Translate(Bool(false)));
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
        Assert.Equal("self.quantity < 1", t.TranslateNegated(expr));
    }

    [Fact]
    public void TranslateNegated_peels_not()
    {
        var (t, _) = Make();
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        Assert.Equal("a", t.TranslateNegated(expr));
    }

    [Fact]
    public void TranslateNegated_wraps_other_expressions()
    {
        var (t, _) = Make();
        var expr = Member("lines", "isEmpty");
        Assert.Equal("not (len(self.lines) == 0)", t.TranslateNegated(expr));
    }
}
