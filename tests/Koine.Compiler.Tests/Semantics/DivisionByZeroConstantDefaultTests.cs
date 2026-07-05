using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1031: <c>amount: Decimal = 4 / 0</c> — a literal division by zero in a member's
/// constant-foldable default — compiles today with NO diagnostic, and every current emitter target
/// mishandles the resulting expression, each in a different way (cross-target audit, Task 1):
///
/// <list type="bullet">
/// <item><b>C#</b>: the generated <c>Rate.cs</c> fails to even build — Roslyn rejects the literal
/// <c>int</c> division default with <c>CS0020: Division by constant zero</c>.</item>
/// <item><b>TypeScript</b>: <c>tsc --strict</c> rejects the generated <c>Rate.ts</c> with
/// <c>TS2322: Type 'number' is not assignable to type 'Decimal'</c> — the raw <c>4 / 0</c> literal
/// is typed <c>number</c>, not the branded <c>Decimal</c>.</item>
/// <item><b>Python</b>: <c>amount: Decimal = (4 // 0)</c> raises <c>ZeroDivisionError</c> the moment
/// the module is imported — the dataclass field default is evaluated at class-body execution
/// time.</item>
/// <item><b>PHP</b>: <c>php -l</c> sees nothing wrong (the raw <c>(4 / 0)</c> is syntactically legal
/// in a constructor-promoted property default), but constructing a <c>Rate</c> with the default
/// (i.e. omitting <c>amount</c>) throws <c>DivisionByZeroError</c> at runtime — see #971 / PR #1025,
/// whose <c>PhpEmitter.TryFoldNumericLiteral</c> already refuses to fold a literal-zero divisor
/// (matching <see cref="Koine.Compiler.Semantics.ConstantFolder"/>'s own div-by-zero stance) but has
/// no better fallback today than re-emitting the original, still-broken expression.</item>
/// </list>
///
/// Every target's failure mode differs, but all four share the same root cause: the model layer
/// never checks that a computed default's constant arithmetic is actually representable. That makes
/// this a <see cref="Koine.Compiler.Semantics.SemanticValidator"/>-level gap, not a PHP-only one —
/// hence the fix lives in <c>Semantics/</c> rather than another per-emitter patch.
/// </summary>
public class DivisionByZeroConstantDefaultTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private const string Repro = """
        context Pricing {
          value Rate {
            amount: Decimal = 4 / 0
          }
        }
        """;

    [Fact]
    public void Division_by_a_literal_zero_in_a_constant_default_is_rejected()
    {
        var divByZero = Diagnose(Repro).ShouldHaveSingleItem();
        divByZero.Code.ShouldBe(DiagnosticCodes.DivisionByZeroInConstantDefault);
        divByZero.Severity.ShouldBe(DiagnosticSeverity.Error);
        divByZero.Message.ShouldContain("amount");
    }

    [Fact]
    public void Compile_reports_failure_for_the_repro_model_before_any_emitter_runs()
    {
        var result = new KoineCompiler().Compile(Repro, new CSharpEmitter());
        result.Success.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.DivisionByZeroInConstantDefault);
    }
}
