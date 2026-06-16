namespace Koine.Compiler.Ast;

/// <summary>
/// A lexical scope mapping in-scope identifier names (members, plus lambda
/// parameters) to their declared <see cref="TypeRef"/>.
/// </summary>
public sealed class TypeScope
{
    private readonly Dictionary<string, TypeRef> _names;

    public TypeScope(IEnumerable<KeyValuePair<string, TypeRef>> names)
    {
        // Tolerate duplicate names (e.g. an invalid model with a repeated member):
        // last writer wins, and the duplicate is reported elsewhere.
        _names = new Dictionary<string, TypeRef>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, TypeRef> pair in names)
        {
            _names[pair.Key] = pair.Value;
        }
    }

    public static TypeScope FromMembers(IEnumerable<Member> members) =>
        new(members.Select(m => new KeyValuePair<string, TypeRef>(m.Name, m.Type)));

    public bool TryGet(string name, out TypeRef type) => _names.TryGetValue(name, out type!);

    public bool Contains(string name) => _names.ContainsKey(name);

    public IEnumerable<string> Names => _names.Keys;

    /// <summary>Returns a new scope with <paramref name="name"/> bound to <paramref name="type"/>.</summary>
    public TypeScope With(string name, TypeRef type)
    {
        var copy = new Dictionary<string, TypeRef>(_names, StringComparer.Ordinal) { [name] = type };
        return new TypeScope(copy);
    }
}

/// <summary>
/// Best-effort, target-agnostic inference of the resulting <see cref="TypeRef"/>
/// of an expression. Returns <c>null</c> when the type cannot be determined
/// (e.g. an unknown identifier); callers treat <c>null</c> as "don't constrain".
/// Used by the semantic checker (for type diagnostics) and by the C# emitter
/// (e.g. to tell a numeric <c>sum</c> from a value-object <c>sum</c>).
/// </summary>
public sealed class TypeResolver
{
    public static readonly TypeRef Bool = new("Bool");
    public static readonly TypeRef Int = new("Int");
    public static readonly TypeRef Decimal = new("Decimal");
    public static readonly TypeRef String = new("String");
    public static readonly TypeRef Instant = new("Instant");

    private readonly ModelIndex _index;

    /// <summary>The context this resolver reasons within (R13.2), so a type name shared across contexts resolves locally; null = global.</summary>
    public string? Context { get; }

    public TypeResolver(ModelIndex index, string? context = null)
    {
        _index = index;
        Context = context;
    }

    public static bool IsNumeric(TypeRef? t) => t is not null && t.Name is "Int" or "Decimal";

    public bool IsValueLike(TypeRef? t) =>
        t is not null && _index.Classify(t.Name) is TypeKind.Value or TypeKind.IdValueObject;

    public bool IsUserType(TypeRef? t) =>
        t is not null && _index.Classify(t.Name) is TypeKind.Value or TypeKind.Entity;

    public TypeRef? Infer(Expr expr, TypeScope scope) => new InferVisitor(this, scope).Visit(expr);

    /// <summary>
    /// The exhaustive expression-type inference. Carries the lexical <see cref="TypeScope"/> as a
    /// mutable field, pushed/restored around the sub-scopes introduced by <c>let</c> bindings and
    /// collection-aggregate lambdas. A fresh instance is created per <see cref="Infer"/> call, so
    /// the mutable scope never leaks across the re-entrant callers (checker, translator, analyzer).
    /// </summary>
    private sealed class InferVisitor : ExprVisitor<TypeRef?>
    {
        private readonly TypeResolver _owner;
        private TypeScope _scope;

        public InferVisitor(TypeResolver owner, TypeScope scope)
        {
            _owner = owner;
            _scope = scope;
        }

        private ModelIndex Index => _owner._index;

        protected override TypeRef? VisitLiteral(LiteralExpr n) => n.Kind switch
        {
            LiteralKind.Int => Int,
            LiteralKind.Decimal => Decimal,
            LiteralKind.String => String,
            LiteralKind.Bool => Bool,
            _ => null
        };

        protected override TypeRef? VisitIdentifier(IdentifierExpr n)
        {
            // A name bound to the "?" sentinel (e.g. a lambda parameter whose element type
            // couldn't be determined) is treated as unknown.
            if (_scope.TryGet(n.Name, out TypeRef bound))
            {
                return bound.Name == "?" ? null : bound;
            }

            if (BuiltinOps.NullaryValueOps.TryGetValue(n.Name, out var builtinType))
            {
                return new TypeRef(builtinType);
            }

            return Index.EnumMemberToType.TryGetValue(n.Name, out var en) ? new TypeRef(en) : null;
        }

        protected override TypeRef? VisitUnary(UnaryExpr n) =>
            n.Op == UnaryOp.Not ? Bool : Visit(n.Operand);

        protected override TypeRef? VisitMatch(MatchExpr n) => Bool;

        protected override TypeRef? VisitGuard(GuardExpr n) => Visit(n.Body);

        protected override TypeRef? VisitBinary(BinaryExpr n)
        {
            switch (n.Op)
            {
                case BinaryOp.Or or BinaryOp.And
                  or BinaryOp.Eq or BinaryOp.Neq
                  or BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge:
                    return Bool;
                default: // arithmetic
                    TypeRef? l = Visit(n.Left);
                    TypeRef? r = Visit(n.Right);
                    var optional = (l?.IsOptional ?? false) || (r?.IsOptional ?? false);
                    TypeRef? arithmetic =
                        _owner.IsValueLike(l) ? l :                       // value-object scalar arithmetic (Money * qty)
                        _owner.IsValueLike(r) ? r :
                        l?.Name == "Decimal" || r?.Name == "Decimal" ? Decimal :
                        l?.Name == "Int" && r?.Name == "Int" ? Int :
                        l ?? r;
                    return arithmetic is null ? null : arithmetic with { IsOptional = optional };
            }
        }

        protected override TypeRef? VisitConditional(ConditionalExpr n)
        {
            // The result is optional if EITHER branch is optional.
            TypeRef? then = Visit(n.Then);
            TypeRef? @else = Visit(n.Else);
            TypeRef? result = then ?? @else;
            return result is null
                ? null
                : result with { IsOptional = (then?.IsOptional ?? false) || (@else?.IsOptional ?? false) };
        }

        protected override TypeRef? VisitCoalesce(CoalesceExpr n)
        {
            // `a ?? b` is non-null only if the fallback `b` is non-null.
            TypeRef? left = Visit(n.Left);
            TypeRef? right = Visit(n.Right);
            TypeRef? result = left ?? right;
            return result is null
                ? null
                : result with { IsOptional = right is null || right.IsOptional };
        }

        protected override TypeRef? VisitMemberAccess(MemberAccessExpr n)
        {
            // Qualified enum reference: `EnumType.Member` -> the enum type.
            if (n.Target is IdentifierExpr typeId && Index.IsEnumType(typeId.Name))
            {
                return new TypeRef(typeId.Name);
            }

            var op = n.MemberName;
            if (op == "length")
            {
                return Int;
            }

            if (op is "trim" or "lower" or "upper")
            {
                return String;
            }

            if (op == "isBlank")
            {
                return Bool;
            }

            if (op == "count")
            {
                return Int;
            }

            if (op is "isEmpty" or "isNotEmpty")
            {
                return Bool;
            }

            if (op is "isPresent" or "isNone")
            {
                return Bool;
            }

            // Otherwise a field access on a value/entity type — resolved in the receiver's
            // qualifier context, else this resolver's context (R13.2).
            TypeRef? target = Visit(n.Target);
            if (target is not null && Index.TryGetMemberType(target.Qualifier ?? _owner.Context, target.Name, op, out TypeRef mt))
            {
                return mt;
            }

            return null;
        }

        protected override TypeRef? VisitCall(CallExpr n)
        {
            var op = n.Method;
            if (BuiltinOps.StringCallOps.Contains(op))
            {
                return Bool;          // startsWith/endsWith/contains
            }

            if (BuiltinOps.CollectionPredicateOps.Contains(op))
            {
                return Bool; // all/any/none/distinctBy
            }

            if (BuiltinOps.CollectionAggregateOps.Contains(op))             // sum/min/max
            {
                TypeRef? element = ElementOf(Visit(n.Target));
                if (element is not null && n.Args is [LambdaExpr lambda])
                {
                    TypeScope saved = _scope;
                    _scope = _scope.With(lambda.Parameter, element);
                    TypeRef? result = Visit(lambda.Body);
                    _scope = saved;
                    return result;
                }
            }

            return null;
        }

        protected override TypeRef? VisitLet(LetExpr n)
        {
            // Fold bindings into the scope in order (each sees the previous; a value cannot see
            // its own name, since it is registered AFTER inference), then infer the body in the
            // extended scope. Restore on exit.
            TypeScope saved = _scope;
            foreach (LetBinding b in n.Bindings)
            {
                _scope = _scope.With(b.Name, Visit(b.Value) ?? new TypeRef("?"));
            }

            TypeRef? result = Visit(n.Body);
            _scope = saved;
            return result;
        }

        // LambdaExpr only has meaning inside a CallExpr.
        protected override TypeRef? VisitLambda(LambdaExpr n) => null;
    }

    /// <summary>The element type of a <c>List&lt;T&gt;</c> or <c>Set&lt;T&gt;</c> receiver, else <c>null</c>.</summary>
    public static TypeRef? ElementOf(TypeRef? type) =>
        type is { Name: ModelIndex.ListTypeName or ModelIndex.SetTypeName, Element: { } element } ? element : null;
}
