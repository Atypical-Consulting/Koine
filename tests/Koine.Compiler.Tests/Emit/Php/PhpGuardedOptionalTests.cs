using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Regression tests for #787: a guard-narrowed optional operand must emit correct PHP. Narrowing in
/// Koine is validator-only and never reaches <see cref="TypeResolver"/>, so the translator still sees
/// these operands as optional — yet the routing/coalescing must produce PHP that is both phpstan-clean
/// AND semantically correct. The phpstan conformance facts in <c>PhpConformanceTests</c> prove
/// type-safety; these pin the exact emitted shape — including the <b>equality</b> case, whose
/// null-corruption a type-checker cannot catch (coalescing an optional Decimal to <c>Decimal('0')</c>
/// in <c>==</c> would silently turn <c>null == 0</c> into <c>true</c>).
/// </summary>
public class PhpGuardedOptionalTests
{
    // Two optional stored members: a `String?` and a `Decimal?`. The translator infers both as
    // optional (no flow narrowing), exactly the state in which a guard-narrowed operand reaches emit.
    private const string Source =
        """
        context Shop {
          value V {
            name: String?
            base: Decimal?
          }
        }
        """;

    private static PhpExpressionTranslator Make()
    {
        var result = new KoineCompiler().Compile(Source, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var model = result.Model!;
        ModelIndex index = new SemanticModel(model).Index;
        var v = model.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(t => t.Name == "V");

        return new PhpExpressionTranslator(index, v.Members, index.EnumMemberToType, context: "Shop");
    }

    private static IdentifierExpr Id(string name) => new(name);
    private static LiteralExpr Str(string text) => new(LiteralKind.String, text);

    [Fact]
    public void Optional_String_concat_operand_is_coalesced_to_a_non_null_string()
    {
        // `name + "!"` — `name` is `String?`. The `.` operand must be `($this->name ?? '')` so the
        // concat site is never `string|null` under phpstan --level max (never the numeric `+`).
        Make().Translate(new BinaryExpr(BinaryOp.Add, Id("name"), Str("!")))
            .ShouldBe("(($this->name ?? '') . '!')");
    }

    [Fact]
    public void Optional_Decimal_arithmetic_operand_is_coalesced_to_a_non_null_Decimal()
    {
        // `base + base` — `base` is `Decimal?`. Arithmetic is validator-guarded, so the operand is
        // provably guarded; it routes to the runtime Decimal `add` with each side coalesced to a
        // non-null Decimal (never a native `+` on a runtime Decimal object).
        Make().Translate(new BinaryExpr(BinaryOp.Add, Id("base"), Id("base")))
            .ShouldBe(@"($this->base ?? new \Koine\Runtime\Decimal('0'))->add(($this->base ?? new \Koine\Runtime\Decimal('0')))");
    }

    [Fact]
    public void Optional_Decimal_equality_stays_native_and_is_not_coalesced()
    {
        // `base == base` — equality is NOT guarded by the validator (unlike arithmetic/relational), so
        // an optional operand may be genuinely null at runtime. It must stay on the native
        // null-distinguishing `===`, NOT be coalesced to `Decimal('0')` (which would corrupt
        // `null == 0` / `null == null` into a wrong `true`). The regression guard for #787's review.
        Make().Translate(new BinaryExpr(BinaryOp.Eq, Id("base"), Id("base")))
            .ShouldBe("($this->base === $this->base)");
    }
}
