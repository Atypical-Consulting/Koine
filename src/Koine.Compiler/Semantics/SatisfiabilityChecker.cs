using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// DSL-native invariant satisfiability analysis (issue #73, thread B). Over each value object's lowered
/// <see cref="BoundInvariant"/>s it folds the constant sub-language (<see cref="ConstantFolder"/>) and
/// builds per-field interval/equality facts, then reports invariants that can never hold:
/// <list type="bullet">
/// <item><see cref="DiagnosticCodes.ContradictoryInvariant"/> (KOI0310) — the whole condition folds to a constant <c>false</c>;</item>
/// <item><see cref="DiagnosticCodes.InvertedBound"/> (KOI0311) — a field's inclusive bounds are inverted (low &gt; high);</item>
/// <item><see cref="DiagnosticCodes.BoundOutsideConstraint"/> (KOI0312) — a field's constant default lies outside its required range;</item>
/// <item><see cref="DiagnosticCodes.UnsatisfiableInvariantPair"/> (KOI0313) — two bounds on one field have an empty intersection.</item>
/// </list>
///
/// <para>It is a pure analysis over the TARGET-AGNOSTIC bound IR — it never emits, and a guarded
/// invariant (<see cref="BoundGuard"/>) is conditional, so it is left alone. Diagnostics are warnings:
/// the generated code still compiles; the value just can never satisfy the invariant. Exhaustiveness is
/// deliberately NOT analysed here — that stays compile-enforced by the smart-enum <c>Match</c> codegen.</para>
/// </summary>
internal static class SatisfiabilityChecker
{
    public static void Validate(SemanticModel semantic, List<Diagnostic> diagnostics)
    {
        foreach (ContextNode ctx in semantic.Model.Contexts)
        {
            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                if (type is ValueObjectDecl vo)
                {
                    CheckValueObject(vo, semantic, diagnostics);
                }
            }
        }
    }

    private static void CheckValueObject(ValueObjectDecl vo, SemanticModel semantic, List<Diagnostic> diagnostics)
    {
        // Accumulate every field's constant bounds across all (unguarded) invariants, for the
        // default-outside-range check; per-invariant bounds drive the inverted/unsatisfiable checks.
        var allBounds = new Dictionary<Symbol, List<Bound>>(SymbolEqualityComparer.Default);

        foreach (BoundInvariant inv in semantic.BoundInvariantsFor(vo))
        {
            BoundExpression cond = inv.Condition;

            // A `when`-guarded invariant only has to hold when its guard is true — never a hard contradiction.
            if (cond is BoundGuard)
            {
                continue;
            }

            // The whole condition is a constant that can never hold.
            if (ConstantFolder.Fold(cond) is ConstantValue.Bool { Value: false })
            {
                diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.ContradictoryInvariant,
                    "invariant condition is always false and can never hold", inv.Syntax.Span));
                continue;
            }

            var perInvariant = new Dictionary<Symbol, List<Bound>>(SymbolEqualityComparer.Default);
            foreach (BoundExpression conjunct in Conjuncts(cond))
            {
                if (TryBound(conjunct, out Symbol? field, out Bound bound))
                {
                    Add(perInvariant, field!, bound);
                    Add(allBounds, field!, bound);
                }
            }

            foreach ((Symbol field, List<Bound> bounds) in perInvariant)
            {
                if (IsEmptyInterval(bounds, out bool inclusiveInverted))
                {
                    string name = field.Name;
                    diagnostics.Add(inclusiveInverted
                        ? Diagnostic.Warning(DiagnosticCodes.InvertedBound,
                            $"the bounds on '{name}' are inverted: its required lower bound exceeds its upper bound", inv.Syntax.Span)
                        : Diagnostic.Warning(DiagnosticCodes.UnsatisfiableInvariantPair,
                            $"the bounds on '{name}' cannot both hold; their intersection is empty", inv.Syntax.Span));
                }
            }
        }

        CheckDefaultsWithinBounds(vo, allBounds, semantic, diagnostics);
    }

    /// <summary>Flags a field whose constant numeric default lies outside the range its invariants require (KOI0312).</summary>
    private static void CheckDefaultsWithinBounds(
        ValueObjectDecl vo, IReadOnlyDictionary<Symbol, List<Bound>> allBounds, SemanticModel semantic, List<Diagnostic> diagnostics)
    {
        foreach (Member m in vo.Members)
        {
            if (m.Initializer is null || !TryLiteralNumber(m.Initializer, out decimal value))
            {
                continue;
            }

            if (semantic.GetDeclaredSymbol(m) is not { } sym
                || !allBounds.TryGetValue(sym, out List<Bound>? bounds))
            {
                continue;
            }

            if (Violates(bounds, value))
            {
                diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.BoundOutsideConstraint,
                    $"the default for '{m.Name}' lies outside the range its invariants require", m.Span));
            }
        }
    }

    /// <summary>A single constant bound on a field: a comparison operator against a constant value.</summary>
    private readonly record struct Bound(BinaryOp Op, decimal Value);

    private static void Add(Dictionary<Symbol, List<Bound>> map, Symbol field, Bound bound)
    {
        if (!map.TryGetValue(field, out List<Bound>? list))
        {
            list = new List<Bound>();
            map[field] = list;
        }

        list.Add(bound);
    }

    /// <summary>Flattens the top-level <c>and</c> spine of a condition into its conjuncts.</summary>
    private static IEnumerable<BoundExpression> Conjuncts(BoundExpression expr)
    {
        if (expr is BoundBinary { Op: BinaryOp.And } and)
        {
            foreach (BoundExpression left in Conjuncts(and.Left))
            {
                yield return left;
            }

            foreach (BoundExpression right in Conjuncts(and.Right))
            {
                yield return right;
            }
        }
        else
        {
            yield return expr;
        }
    }

    /// <summary>A <c>field OP constant</c> (or <c>constant OP field</c>) comparison, normalised to field-on-the-left.</summary>
    private static bool TryBound(BoundExpression expr, out Symbol? field, out Bound bound)
    {
        field = null;
        bound = default;
        if (expr is not BoundBinary bin || !IsComparison(bin.Op))
        {
            return false;
        }

        if (bin.Left is BoundReference { Symbol: MemberSymbol fl } && ConstantFolder.Fold(bin.Right) is ConstantValue.Num nr)
        {
            field = fl;
            bound = new Bound(bin.Op, nr.Value);
            return true;
        }

        if (bin.Right is BoundReference { Symbol: MemberSymbol fr } && ConstantFolder.Fold(bin.Left) is ConstantValue.Num nl)
        {
            field = fr;
            bound = new Bound(Flip(bin.Op), nl.Value);
            return true;
        }

        return false;
    }

    private static bool IsComparison(BinaryOp op) =>
        op is BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge or BinaryOp.Eq;

    private static BinaryOp Flip(BinaryOp op) => op switch
    {
        BinaryOp.Lt => BinaryOp.Gt,
        BinaryOp.Le => BinaryOp.Ge,
        BinaryOp.Gt => BinaryOp.Lt,
        BinaryOp.Ge => BinaryOp.Le,
        _ => op // Eq is symmetric
    };

    /// <summary>
    /// True when the constant bounds on one field have an empty feasible set. <paramref name="inclusiveInverted"/>
    /// distinguishes an inverted inclusive range (<c>&gt;=</c>/<c>&lt;=</c> with low &gt; high → KOI0311) from any
    /// other empty intersection (a strict or equality conflict → KOI0313).
    /// </summary>
    private static bool IsEmptyInterval(IReadOnlyList<Bound> bounds, out bool inclusiveInverted)
    {
        inclusiveInverted = false;

        decimal? lo = null;
        bool loStrict = false;
        decimal? hi = null;
        bool hiStrict = false;
        decimal? eq = null;
        bool twoDistinctEq = false;

        foreach (Bound b in bounds)
        {
            switch (b.Op)
            {
                case BinaryOp.Gt or BinaryOp.Ge:
                    bool gStrict = b.Op == BinaryOp.Gt;
                    if (lo is null || b.Value > lo || (b.Value == lo && gStrict))
                    {
                        lo = b.Value;
                        loStrict = gStrict;
                    }

                    break;
                case BinaryOp.Lt or BinaryOp.Le:
                    bool lStrict = b.Op == BinaryOp.Lt;
                    if (hi is null || b.Value < hi || (b.Value == hi && lStrict))
                    {
                        hi = b.Value;
                        hiStrict = lStrict;
                    }

                    break;
                case BinaryOp.Eq:
                    if (eq is { } prev && prev != b.Value)
                    {
                        twoDistinctEq = true;
                    }

                    eq = b.Value;
                    break;
            }
        }

        // Conflicting equalities, or an equality outside its own range.
        if (twoDistinctEq)
        {
            return true;
        }

        if (eq is { } e)
        {
            if ((lo is { } l && (e < l || (e == l && loStrict))) || (hi is { } h && (e > h || (e == h && hiStrict))))
            {
                return true;
            }
        }

        if (lo is { } low && hi is { } high)
        {
            if (low > high)
            {
                inclusiveInverted = !loStrict && !hiStrict;
                return true;
            }

            if (low == high && (loStrict || hiStrict))
            {
                return true; // e.g. x > 5 and x <= 5
            }
        }

        return false;
    }

    /// <summary>True when <paramref name="value"/> violates any of the constant bounds.</summary>
    private static bool Violates(IReadOnlyList<Bound> bounds, decimal value)
    {
        foreach (Bound b in bounds)
        {
            bool ok = b.Op switch
            {
                BinaryOp.Gt => value > b.Value,
                BinaryOp.Ge => value >= b.Value,
                BinaryOp.Lt => value < b.Value,
                BinaryOp.Le => value <= b.Value,
                BinaryOp.Eq => value == b.Value,
                _ => true
            };
            if (!ok)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>Reads a numeric literal default (with optional unary minus); false for non-numeric/non-literal initializers.</summary>
    private static bool TryLiteralNumber(Expr expr, out decimal value)
    {
        value = 0m;
        (LiteralExpr? lit, bool negate) = expr switch
        {
            LiteralExpr l => (l, false),
            UnaryExpr { Op: UnaryOp.Negate, Operand: LiteralExpr l } => (l, true),
            _ => (null, false)
        };

        if (lit is null || lit.Kind is not (LiteralKind.Int or LiteralKind.Decimal)
            || !decimal.TryParse(lit.Text, System.Globalization.NumberStyles.Number, System.Globalization.CultureInfo.InvariantCulture, out value))
        {
            return false;
        }

        if (negate)
        {
            value = -value;
        }

        return true;
    }
}
