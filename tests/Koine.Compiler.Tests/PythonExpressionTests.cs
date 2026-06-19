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
            counts: List<Int>
          }
        }
        """;

    private static (PythonExpressionTranslator translator, IReadOnlyList<Member> members) Make()
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
        var (t, _) = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        t.Translate(expr, PythonExpressionTranslator.NameMode.Parameter).ShouldBe("(quantity >= 1)");
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

    // =========================================================================
    // Regex match
    // =========================================================================

    [Fact]
    public void Matches_lowers_to_re_search()
    {
        var expr = new MatchExpr(Id("code"), "[A-Z]{3}");
        Translate(expr).ShouldBe("(re.search(r\"[A-Z]{3}\", self.code) is not None)");
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
        var (t, _) = Make();
        var expr = new BinaryExpr(BinaryOp.Ge, Id("quantity"), Int("1"));
        t.TranslateNegated(expr).ShouldBe("self.quantity < 1");
    }

    [Fact]
    public void TranslateNegated_peels_not()
    {
        var (t, _) = Make();
        var expr = new UnaryExpr(UnaryOp.Not, Id("a"));
        t.TranslateNegated(expr).ShouldBe("a");
    }

    [Fact]
    public void TranslateNegated_wraps_other_expressions()
    {
        var (t, _) = Make();
        var expr = Member("lines", "isEmpty");
        t.TranslateNegated(expr).ShouldBe("not (len(self.lines) == 0)");
    }
}
