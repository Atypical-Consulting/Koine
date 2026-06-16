namespace Koine.Compiler.Ast;

/// <summary>
/// Shared, target-agnostic analysis of member initializers. Both the semantic
/// validator and the emitter rely on this so they classify members identically.
/// </summary>
public static class MemberAnalysis
{
    /// <summary>
    /// A member with an initializer is <b>derived</b> (a computed, get-only
    /// property excluded from the constructor) when its initializer references
    /// any sibling member; otherwise the initializer is a constant
    /// <b>default</b> (a default constructor argument), e.g. <c>status = Draft</c>.
    /// Members with no initializer are neither.
    /// </summary>
    public static bool IsDerived(Member member, IEnumerable<string> siblingMemberNames)
    {
        if (member.Initializer is null)
            return false;

        var siblings = siblingMemberNames as ISet<string> ?? new HashSet<string>(siblingMemberNames);
        foreach (var name in ReferencedIdentifiers(member.Initializer))
        {
            if (name != member.Name && siblings.Contains(name))
                return true;
        }
        return false;
    }

    /// <summary>
    /// Structural equality of two type references, ignoring optionality and recursing
    /// into generic arguments. Used to decide whether a factory parameter auto-binds
    /// to a same-named member (so the validator and emitter agree).
    /// </summary>
    public static bool TypeShapeEquals(TypeRef a, TypeRef b)
    {
        if (a.Name != b.Name)
            return false;
        if ((a.Element is null) != (b.Element is null))
            return false;
        if (a.Element is not null && !TypeShapeEquals(a.Element, b.Element!))
            return false;
        if ((a.Value is null) != (b.Value is null))
            return false;
        if (a.Value is not null && !TypeShapeEquals(a.Value, b.Value!))
            return false;
        return true;
    }

    /// <summary>
    /// True when a factory parameter <paramref name="param"/> implicitly initializes
    /// a same-named constructor member <paramref name="member"/>: identical names and
    /// type shapes, and the parameter is not optional where the member is required.
    /// </summary>
    public static bool AutoBinds(Param param, Member member) =>
        param.Name == member.Name
        && TypeShapeEquals(param.Type, member.Type)
        && (!param.Type.IsOptional || member.Type.IsOptional);

    /// <summary>
    /// Directional assignability (value -&gt; target): same type shape, or an implicit
    /// numeric widening (<c>Int</c> -&gt; <c>Decimal</c>). Ignores optionality.
    /// </summary>
    public static bool IsAssignable(TypeRef value, TypeRef target) =>
        TypeShapeEquals(value, target) || (value.Name == "Int" && target.Name == "Decimal");

    /// <summary>Enumerates every identifier name referenced inside an expression.</summary>
    public static IEnumerable<string> ReferencedIdentifiers(Expr expr)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                yield return id.Name;
                break;
            case MemberAccessExpr ma:
                foreach (var n in ReferencedIdentifiers(ma.Target))
                    yield return n;
                break;
            case CallExpr call:
                foreach (var n in ReferencedIdentifiers(call.Target))
                    yield return n;
                foreach (var arg in call.Args)
                    foreach (var n in ReferencedIdentifiers(arg))
                        yield return n;
                break;
            case LambdaExpr lambda:
                // The lambda parameter is a bound variable, not a free reference;
                // exclude it (and any shadowed use) from the referenced set.
                foreach (var n in ReferencedIdentifiers(lambda.Body))
                    if (n != lambda.Parameter)
                        yield return n;
                break;
            case ConditionalExpr cond:
                foreach (var n in ReferencedIdentifiers(cond.Condition))
                    yield return n;
                foreach (var n in ReferencedIdentifiers(cond.Then))
                    yield return n;
                foreach (var n in ReferencedIdentifiers(cond.Else))
                    yield return n;
                break;
            case CoalesceExpr coalesce:
                foreach (var n in ReferencedIdentifiers(coalesce.Left))
                    yield return n;
                foreach (var n in ReferencedIdentifiers(coalesce.Right))
                    yield return n;
                break;
            case BinaryExpr b:
                foreach (var n in ReferencedIdentifiers(b.Left))
                    yield return n;
                foreach (var n in ReferencedIdentifiers(b.Right))
                    yield return n;
                break;
            case UnaryExpr u:
                foreach (var n in ReferencedIdentifiers(u.Operand))
                    yield return n;
                break;
            case MatchExpr m:
                foreach (var n in ReferencedIdentifiers(m.Target))
                    yield return n;
                break;
            case GuardExpr g:
                foreach (var n in ReferencedIdentifiers(g.Body))
                    yield return n;
                foreach (var n in ReferencedIdentifiers(g.Condition))
                    yield return n;
                break;
            case LetExpr let:
                {
                    // Binding names are bound variables, not free references: a value sees
                    // earlier bindings, and the body sees them all, so yield only the FREE
                    // identifiers (those not introduced by an earlier-or-current binding).
                    var boundNames = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var binding in let.Bindings)
                    {
                        foreach (var n in ReferencedIdentifiers(binding.Value))
                            if (!boundNames.Contains(n))
                                yield return n;
                        boundNames.Add(binding.Name);
                    }
                    foreach (var n in ReferencedIdentifiers(let.Body))
                        if (!boundNames.Contains(n))
                            yield return n;
                    break;
                }
            case LiteralExpr:
                break;
        }
    }
}
