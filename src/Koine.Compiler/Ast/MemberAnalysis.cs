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

    /// <summary>The factory parameters whose declared type IS the entity's identity type
    /// (a simple, non-optional ref to <see cref="EntityDecl.IdentityName"/>). On a non-generatable
    /// (non-Guid) identity these are the caller-supplied identity candidates for an explicit-id
    /// create factory (#324); on a Guid identity a factory mints its own id, so such a parameter is
    /// an ordinary identity reference (e.g. <c>reply(parent: CommentId, …)</c>), NOT the new id.</summary>
    public static IReadOnlyList<Param> IdentityParameters(EntityDecl entity, FactoryDecl factory) =>
        factory.Parameters.Where(p => IsIdentityTypeRef(p.Type, entity.IdentityName)).ToList();

    /// <summary>True iff the factory supplies its own identity via exactly one identity-typed
    /// parameter instead of minting it (#324). Only a non-generatable (non-Guid) identity can —
    /// a Guid factory always auto-generates, so an identity-typed parameter there is an ordinary
    /// reference, never the new id. Drives the relaxed KOI0808 and every emitter's
    /// generate-vs-use-parameter branch.</summary>
    public static bool FactoryProvidesExplicitId(EntityDecl entity, FactoryDecl factory) =>
        entity.IdStrategy != IdentityStrategy.Guid && IdentityParameters(entity, factory).Count == 1;

    /// <summary>The single explicit identity parameter the factory supplies its identity through,
    /// or null. Always null for a Guid entity (it mints its id; an identity-typed parameter there is
    /// an ordinary reference) and when the factory provides zero or more than one (#324). The
    /// emitters bind the synthetic <c>id</c> to this parameter.</summary>
    public static Param? ExplicitIdParameter(EntityDecl entity, FactoryDecl factory)
    {
        if (entity.IdStrategy == IdentityStrategy.Guid)
        {
            return null;
        }

        IReadOnlyList<Param> ids = IdentityParameters(entity, factory);
        return ids.Count == 1 ? ids[0] : null;
    }

    /// <summary>True when <paramref name="type"/> is a simple, non-optional reference to the
    /// identity type named <paramref name="identityName"/> (no generic element/value, not nullable)
    /// — i.e. it denotes the entity's identity, so the parameter is an explicit-id candidate (#324).</summary>
    internal static bool IsIdentityTypeRef(TypeRef type, string identityName) =>
        string.Equals(type.Name, identityName, StringComparison.Ordinal)
        && type.Element is null && type.Value is null && !type.IsOptional;

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
