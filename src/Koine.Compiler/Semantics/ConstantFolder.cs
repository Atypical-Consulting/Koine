using System.Globalization;
using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;

namespace Koine.Compiler.Semantics;

/// <summary>
/// A folded compile-time constant value (B1). TARGET-AGNOSTIC: a plain numeric / boolean / string value
/// with no language rendering. <c>null</c> from <see cref="ConstantFolder.Fold"/> means "not a constant".
/// </summary>
internal abstract record ConstantValue
{
    /// <summary>A numeric constant (Int or Decimal). <see cref="IsInteger"/> records whether it is integral.</summary>
    public sealed record Num(decimal Value, bool IsInteger) : ConstantValue;

    /// <summary>A boolean constant.</summary>
    public sealed record Bool(bool Value) : ConstantValue;

    /// <summary>A string constant (verbatim, without surrounding quotes).</summary>
    public sealed record Text(string Value) : ConstantValue;
}

/// <summary>
/// Folds the constant sub-language of the bound IR (B1): <see cref="BoundBinary"/> / <see cref="BoundUnary"/>
/// over <see cref="BoundLiteral"/> leaves to a <see cref="ConstantValue"/>, or <c>null</c> when the
/// expression is not a constant (an unfoldable form, a non-constant operand, or an undefined operation).
///
/// <para>It NEVER throws — overflow and division/modulo by zero yield <c>null</c> ("not constant"),
/// mirroring <see cref="Koine.Compiler.Ast.TypeResolver"/>'s never-throw discipline. TARGET-AGNOSTIC: it
/// reasons over values, not over any emitted C#/TS form. The <see cref="SatisfiabilityChecker"/> uses it
/// to compare invariant bounds.</para>
/// </summary>
internal static class ConstantFolder
{
    /// <summary>The constant value of <paramref name="expr"/>, or <c>null</c> when it is not constant.</summary>
    public static ConstantValue? Fold(BoundExpression expr) => expr switch
    {
        BoundLiteral lit => FromLiteral(lit),
        BoundUnary u => FoldUnary(u),
        BoundBinary b => FoldBinary(b),
        _ => null
    };

    private static ConstantValue? FromLiteral(BoundLiteral lit)
    {
        switch (lit.Kind)
        {
            case LiteralKind.Int:
                return decimal.TryParse(lit.Text, NumberStyles.Integer | NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out decimal i)
                    ? new ConstantValue.Num(i, IsInteger: true)
                    : null;
            case LiteralKind.Decimal:
                return decimal.TryParse(lit.Text, NumberStyles.Number, CultureInfo.InvariantCulture, out decimal d)
                    ? new ConstantValue.Num(d, IsInteger: false)
                    : null;
            case LiteralKind.Bool:
                return bool.TryParse(lit.Text, out bool b) ? new ConstantValue.Bool(b) : null;
            case LiteralKind.String:
                return new ConstantValue.Text(lit.Text);
            default:
                return null;
        }
    }

    private static ConstantValue? FoldUnary(BoundUnary u) => Fold(u.Operand) switch
    {
        ConstantValue.Bool b when u.Op == UnaryOp.Not => new ConstantValue.Bool(!b.Value),
        ConstantValue.Num n when u.Op == UnaryOp.Negate => new ConstantValue.Num(-n.Value, n.IsInteger),
        _ => null
    };

    private static ConstantValue? FoldBinary(BoundBinary b)
    {
        ConstantValue? left = Fold(b.Left);
        ConstantValue? right = Fold(b.Right);
        if (left is null || right is null)
        {
            return null;
        }

        // Logical connectives over two booleans.
        if (left is ConstantValue.Bool lb && right is ConstantValue.Bool rb)
        {
            return b.Op switch
            {
                BinaryOp.And => new ConstantValue.Bool(lb.Value && rb.Value),
                BinaryOp.Or => new ConstantValue.Bool(lb.Value || rb.Value),
                BinaryOp.Eq => new ConstantValue.Bool(lb.Value == rb.Value),
                BinaryOp.Neq => new ConstantValue.Bool(lb.Value != rb.Value),
                _ => null
            };
        }

        // Arithmetic and comparison over two numbers.
        if (left is ConstantValue.Num ln && right is ConstantValue.Num rn)
        {
            return FoldNumeric(b.Op, ln, rn);
        }

        // String (in)equality.
        if (left is ConstantValue.Text lt && right is ConstantValue.Text rt)
        {
            return b.Op switch
            {
                BinaryOp.Eq => new ConstantValue.Bool(string.Equals(lt.Value, rt.Value, StringComparison.Ordinal)),
                BinaryOp.Neq => new ConstantValue.Bool(!string.Equals(lt.Value, rt.Value, StringComparison.Ordinal)),
                _ => null
            };
        }

        return null;
    }

    private static ConstantValue? FoldNumeric(BinaryOp op, ConstantValue.Num l, ConstantValue.Num r)
    {
        bool integral = l.IsInteger && r.IsInteger;
        try
        {
            switch (op)
            {
                case BinaryOp.Add:
                    return new ConstantValue.Num(l.Value + r.Value, integral);
                case BinaryOp.Sub:
                    return new ConstantValue.Num(l.Value - r.Value, integral);
                case BinaryOp.Mul:
                    return new ConstantValue.Num(l.Value * r.Value, integral);
                case BinaryOp.Div:
                    if (r.Value == 0m)
                    {
                        return null; // division by zero is "not constant", not an exception
                    }

                    decimal quotient = l.Value / r.Value;
                    return new ConstantValue.Num(quotient, integral && quotient == decimal.Truncate(quotient));
                case BinaryOp.Lt:
                    return new ConstantValue.Bool(l.Value < r.Value);
                case BinaryOp.Le:
                    return new ConstantValue.Bool(l.Value <= r.Value);
                case BinaryOp.Gt:
                    return new ConstantValue.Bool(l.Value > r.Value);
                case BinaryOp.Ge:
                    return new ConstantValue.Bool(l.Value >= r.Value);
                case BinaryOp.Eq:
                    return new ConstantValue.Bool(l.Value == r.Value);
                case BinaryOp.Neq:
                    return new ConstantValue.Bool(l.Value != r.Value);
                default:
                    return null;
            }
        }
        catch (OverflowException)
        {
            return null; // an overflowing fold is "not constant", never an exception
        }
    }
}
