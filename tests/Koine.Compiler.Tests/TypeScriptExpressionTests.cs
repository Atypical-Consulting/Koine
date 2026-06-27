using Koine.Compiler.Ast;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="TypeScriptExpressionTranslator"/> — the pure translation of the
/// target-agnostic <see cref="Expr"/> sublanguage into TypeScript expression source. The focus
/// here is the numeric <c>min</c>/<c>max</c> lowering (issue #610): folding an <b>empty</b>
/// numeric collection must throw <c>DomainInvariantViolationError</c> — mirroring the value-object
/// branch and the C#/Python targets — rather than silently returning <c>Math.min()</c> /
/// <c>Math.max()</c>'s <c>±Infinity</c>.
/// </summary>
public class TypeScriptExpressionTests
{
    // A value object with a numeric projection (`lines.min(l => l.qty)`, qty: Int) so the
    // translator's numeric min/max branch is reachable.
    private const string Source =
        """
        context Shop {
          value Line { qty: Int }
          value Order {
            lines: List<Line>
          }
        }
        """;

    private static TypeScriptExpressionTranslator Make()
    {
        var result = new KoineCompiler().Compile(Source, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        var semantic = new SemanticModel(model);
        ModelIndex index = semantic.Index;

        var order = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Order");

        var typeMapper = new TypeScriptTypeMapper(index);
        return new TypeScriptExpressionTranslator(
            index, order.Members, index.EnumMemberToType, typeMapper, context: "Shop");
    }

    private static string Translate(Expr expr) => Make().Translate(expr);

    private static IdentifierExpr Id(string name) => new(name);

    // A numeric projection `lines.<op>(l => l.qty)` (qty: Int).
    private static CallExpr MinMax(string op) =>
        new(Id("lines"), op, new Expr[] { new LambdaExpr("l", new MemberAccessExpr(Id("l"), "qty")) });

    [Fact]
    public void Numeric_min_guards_empty_collection_and_folds_with_seedless_reduce()
    {
        // Issue #610: `Math.min(...[])` returns Infinity. The numeric branch must instead map once,
        // throw DomainInvariantViolationError on an empty collection, then fold with a seedless
        // `.reduce` — mirroring the value-object branch above it and matching C#/Python.
        var expected =
            "(this.lines.map((l) => l.qty) as readonly number[]).length === 0\n" +
            "        ? (() => { throw new DomainInvariantViolationError('Int', 'cannot take min of an empty collection (no value)'); })()\n" +
            "        : this.lines.map((l) => l.qty).reduce((__mm0a, __mm0b) => Math.min(__mm0a, __mm0b))";
        Translate(MinMax("min")).ShouldBe(expected);
    }

    [Fact]
    public void Numeric_max_guards_empty_collection_and_folds_with_seedless_reduce()
    {
        var expected =
            "(this.lines.map((l) => l.qty) as readonly number[]).length === 0\n" +
            "        ? (() => { throw new DomainInvariantViolationError('Int', 'cannot take max of an empty collection (no value)'); })()\n" +
            "        : this.lines.map((l) => l.qty).reduce((__mm0a, __mm0b) => Math.max(__mm0a, __mm0b))";
        Translate(MinMax("max")).ShouldBe(expected);
    }

    [Fact]
    public void Numeric_min_max_no_longer_emit_a_bare_Math_min_max_spread()
    {
        // The old lowering `Math.min(...arr)` / `Math.max(...arr)` both returns ±Infinity on empty
        // and risks the argument-arity RangeError on very large arrays. Neither should appear now.
        Translate(MinMax("min")).ShouldNotContain("Math.min(...");
        Translate(MinMax("max")).ShouldNotContain("Math.max(...");
    }
}
