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
        {
            return false;
        }

        ISet<string> siblings = siblingMemberNames as ISet<string> ?? new HashSet<string>(siblingMemberNames);
        foreach (var name in ReferencedIdentifiers(member.Initializer))
        {
            if (name != member.Name && siblings.Contains(name))
            {
                return true;
            }
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
        {
            return false;
        }

        if ((a.Element is null) != (b.Element is null))
        {
            return false;
        }

        if (a.Element is not null && !TypeShapeEquals(a.Element, b.Element!))
        {
            return false;
        }

        if ((a.Value is null) != (b.Value is null))
        {
            return false;
        }

        if (a.Value is not null && !TypeShapeEquals(a.Value, b.Value!))
        {
            return false;
        }

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

    /// <summary>Enumerates every FREE identifier name referenced inside an expression (in
    /// depth-first, left-to-right order, with duplicates). Lambda parameters and let-bound names
    /// are bound variables, so they are excluded from the body that introduces them.</summary>
    public static IEnumerable<string> ReferencedIdentifiers(Expr expr)
    {
        var walker = new FreeIdentifierWalker();
        walker.Visit(expr);
        return walker.Result;
    }

    /// <summary>
    /// Collects free identifiers, tracking the names currently bound by an enclosing lambda
    /// parameter or let binding (with save/restore so shadowing is handled correctly).
    /// </summary>
    private sealed class FreeIdentifierWalker : ExprWalker
    {
        private readonly HashSet<string> _bound = new(StringComparer.Ordinal);

        public List<string> Result { get; } = new();

        protected override void VisitIdentifier(IdentifierExpr n)
        {
            if (!_bound.Contains(n.Name))
            {
                Result.Add(n.Name);
            }
        }

        protected override void VisitLambda(LambdaExpr n)
        {
            // The parameter is bound within the body; restore on exit so a same-named outer
            // binding stays visible to siblings.
            var added = _bound.Add(n.Parameter);
            Visit(n.Body);
            if (added)
            {
                _bound.Remove(n.Parameter);
            }
        }

        protected override void VisitLet(LetExpr n)
        {
            // Sequential scoping: a binding value sees only EARLIER bindings (register the name
            // AFTER visiting its value, so a value cannot see its own name); the body sees all.
            var added = new List<string>();
            foreach (LetBinding binding in n.Bindings)
            {
                Visit(binding.Value);
                if (_bound.Add(binding.Name))
                {
                    added.Add(binding.Name);
                }
            }

            Visit(n.Body);
            foreach (var name in added)
            {
                _bound.Remove(name);
            }
        }
    }
}
