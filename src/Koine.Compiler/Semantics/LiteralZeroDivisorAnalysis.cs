using System.Globalization;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Detects a provable division by a literal zero inside a member initializer's <b>unbound</b>
/// <see cref="Expr"/> tree — before <see cref="Ast.Bound.Binder"/> or <see cref="ConstantFolder"/>
/// ever run. <see cref="ConstantFolder"/> operates on the already-bound IR and collapses "unfoldable
/// because an operand isn't constant" and "unfoldable because of a literal-zero divisor" into the
/// same <c>null</c> ("not constant") result, so it cannot report the more specific div-by-zero
/// diagnostic on its own. This walker mirrors <c>PhpEmitter.TryFoldNumericLiteral</c>'s pure-literal
/// arithmetic recursion (<c>Add</c>/<c>Sub</c>/<c>Mul</c>/<c>Negate</c>/<c>Div</c>) so it catches at
/// least everything that emitter-side fold already attempts, never less — including a zero divisor
/// that only appears after folding a sub-expression (e.g. <c>4 / (1 - 1)</c>).
///
/// <para>A <see cref="BinaryOp.Div"/> whose right operand folds to a literal zero is flagged
/// regardless of whether the LEFT operand is itself foldable — dividing by zero is wrong no matter
/// what the numerator evaluates to, so this also catches a <b>derived</b> member's expression like
/// <c>total: Decimal = a / 0</c> where <c>a</c> is a sibling member.</para>
/// </summary>
internal static class LiteralZeroDivisorAnalysis
{
    /// <summary>True when <paramref name="expr"/> contains a division whose right operand is a
    /// provably-literal zero.</summary>
    public static bool HasDivisionByLiteralZero(Expr expr)
    {
        switch (expr)
        {
            case BinaryExpr { Op: BinaryOp.Div } bin:
                return (TryFoldNumericLiteral(bin.Right, out decimal r) && r == 0m)
                    || HasDivisionByLiteralZero(bin.Left)
                    || HasDivisionByLiteralZero(bin.Right);

            case BinaryExpr { Op: BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul } bin:
                return HasDivisionByLiteralZero(bin.Left) || HasDivisionByLiteralZero(bin.Right);

            case UnaryExpr { Op: UnaryOp.Negate } un:
                return HasDivisionByLiteralZero(un.Operand);

            default:
                return false;
        }
    }

    /// <summary>Pure-literal arithmetic fold — mirrors <c>PhpEmitter.TryFoldNumericLiteral</c>
    /// exactly (including its "a literal-zero divisor is not foldable" stance), so the two never
    /// silently drift apart. NEVER throws: an overflowing intermediate (e.g. two near-<see
    /// cref="decimal.MaxValue"/> literals multiplied) is "not foldable" here too, mirroring
    /// <see cref="ConstantFolder"/>'s and <c>PhpEmitter.FoldDecimalConstantDefault</c>'s own
    /// never-throw discipline — a validation pass must never crash the compiler on a malformed
    /// literal.</summary>
    private static bool TryFoldNumericLiteral(Expr expr, out decimal value)
    {
        try
        {
            switch (expr)
            {
                case LiteralExpr { Kind: LiteralKind.Int or LiteralKind.Decimal } lit
                    when decimal.TryParse(lit.Text, NumberStyles.Number | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out value):
                    return true;

                case UnaryExpr { Op: UnaryOp.Negate } un when TryFoldNumericLiteral(un.Operand, out decimal v):
                    value = -v;
                    return true;

                case BinaryExpr { Op: BinaryOp.Add } bin
                    when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r):
                    value = l + r;
                    return true;

                case BinaryExpr { Op: BinaryOp.Sub } bin
                    when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r):
                    value = l - r;
                    return true;

                case BinaryExpr { Op: BinaryOp.Mul } bin
                    when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r):
                    value = l * r;
                    return true;

                case BinaryExpr { Op: BinaryOp.Div } bin
                    when TryFoldNumericLiteral(bin.Left, out decimal l) && TryFoldNumericLiteral(bin.Right, out decimal r) && r != 0m:
                    value = l / r;
                    return true;

                default:
                    value = 0;
                    return false;
            }
        }
        catch (OverflowException)
        {
            value = 0;
            return false;
        }
    }
}
