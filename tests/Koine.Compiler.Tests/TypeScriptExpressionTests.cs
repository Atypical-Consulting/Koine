using Koine.Compiler.Ast;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="TypeScriptExpressionTranslator"/> — the pure translation of the
/// target-agnostic <see cref="Expr"/> sublanguage into TypeScript expression source. The focus
/// here is on collection-op lowerings that must agree with the C# emitter's semantics: the numeric
/// <c>min</c>/<c>max</c> empty-collection guard (issue #610), and <c>distinctBy</c> (issue #609) —
/// which a JS <c>Set</c> cannot express for value-object/Id/<c>Decimal</c> selectors (it dedupes by
/// reference identity), so those route through the runtime's structural <c>structuralEquals</c>.
/// </summary>
public class TypeScriptExpressionTests
{
    // A value object whose lines carry a value-object field (Sku), a Decimal field, and primitive
    // fields, so the numeric min/max branch AND every distinctBy selector-type branch are reachable.
    private const string Source =
        """
        context Shop {
          value Sku { code: String }
          value Line {
            sku:    Sku
            amount: Decimal
            tag:    String
            qty:    Int
          }
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

    // =========================================================================
    // distinctBy (issue #609) — value-object / Decimal selectors must dedupe
    // STRUCTURALLY. A JS Set dedupes by reference identity, so two structurally
    // equal Skus (distinct instances) would survive as distinct entries and a
    // uniqueness invariant would silently never fire — diverging from C#'s
    // `.Distinct()`, which uses the value object's structural Equals.
    // =========================================================================

    // A distinctBy over `lines` projecting to the given Line member.
    private static CallExpr DistinctBy(string member) =>
        new(Id("lines"), "distinctBy", new Expr[] { new LambdaExpr("l", new MemberAccessExpr(Id("l"), member)) });

    [Fact]
    public void DistinctBy_value_object_selector_dedupes_structurally_not_by_set_identity()
    {
        var ts = Translate(DistinctBy("sku"));

        // Must NOT use a Set (reference identity); must collapse structurally-equal Skus via the
        // runtime's structuralEquals — keeping each value's first structural occurrence.
        ts.ShouldNotContain("new Set(");
        ts.ShouldBe(
            "this.lines.map((l) => l.sku).filter((__x, __i, __xs) => " +
            "__xs.findIndex((__y) => structuralEquals(__x, __y)) === __i).length === this.lines.length");
    }

    [Fact]
    public void DistinctBy_decimal_selector_dedupes_structurally()
    {
        // Decimal is emitted as a class with value `equals`; reference-identity dedupe would be wrong.
        Translate(DistinctBy("amount")).ShouldBe(
            "this.lines.map((l) => l.amount).filter((__x, __i, __xs) => " +
            "__xs.findIndex((__y) => structuralEquals(__x, __y)) === __i).length === this.lines.length");
    }

    [Fact]
    public void DistinctBy_primitive_string_selector_keeps_the_set_fast_path()
    {
        // A primitive selector (string) already dedupes by value under SameValueZero — keep the Set.
        Translate(DistinctBy("tag")).ShouldBe(
            "new Set(this.lines.map((l) => l.tag)).size === this.lines.length");
    }

    [Fact]
    public void DistinctBy_primitive_int_selector_keeps_the_set_fast_path()
    {
        Translate(DistinctBy("qty")).ShouldBe(
            "new Set(this.lines.map((l) => l.qty)).size === this.lines.length");
    }

    [Fact]
    public void User_field_named_after_member_op_emits_property_access_not_op_form()
    {
        // #672 (follow-up to #605): a user field named after an UNSAFE built-in member-op
        // (isEmpty/trim/…) must emit a plain property access, mirroring the #605 semantic
        // resolution — not the op form (`this.inner.length === 0` / `this.inner.trim()`), which
        // targets a receiver that has no such op and is therefore wrong TypeScript.
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
        var result = new KoineCompiler().Compile(src, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var source = string.Join("\n", result.Files.Select(f => f.Contents));
        source.ShouldContain("this.inner.isEmpty");
        source.ShouldContain("this.inner.trim");
        source.ShouldNotContain("this.inner.length");
        source.ShouldNotContain("this.inner.trim()");
    }
}
