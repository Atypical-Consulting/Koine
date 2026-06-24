namespace Koine.Compiler.Ast;

/// <summary>
/// A lexical scope mapping in-scope identifier names (members, plus lambda
/// parameters and let bindings) to their resolved <see cref="KoineType"/>.
/// </summary>
public sealed class TypeScope
{
    private readonly Dictionary<string, KoineType> _names;

    public TypeScope(IEnumerable<KeyValuePair<string, KoineType>> names)
    {
        // Tolerate duplicate names (e.g. an invalid model with a repeated member):
        // last writer wins, and the duplicate is reported elsewhere.
        _names = new Dictionary<string, KoineType>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, KoineType> pair in names)
        {
            _names[pair.Key] = pair.Value;
        }
    }

    /// <summary>A scope over a type's members, resolved against <paramref name="index"/>.</summary>
    public static TypeScope FromMembers(IEnumerable<Member> members, ModelIndex index) =>
        new(members.Select(m => new KeyValuePair<string, KoineType>(m.Name, KoineType.From(m.Type, index))));

    /// <summary>A scope over operation/command parameters, resolved against <paramref name="index"/>.</summary>
    public static TypeScope FromParams(IEnumerable<Param> parameters, ModelIndex index) =>
        new(parameters.Select(p => new KeyValuePair<string, KoineType>(p.Name, KoineType.From(p.Type, index))));

    /// <summary>A scope over name→syntactic-type pairs, each resolved against <paramref name="index"/>.</summary>
    public static TypeScope FromRefPairs(IEnumerable<KeyValuePair<string, TypeRef>> pairs, ModelIndex index) =>
        new(pairs.Select(kv => new KeyValuePair<string, KoineType>(kv.Key, KoineType.From(kv.Value, index))));

    public bool TryGet(string name, out KoineType type) => _names.TryGetValue(name, out type!);

    public bool Contains(string name) => _names.ContainsKey(name);

    public IEnumerable<string> Names => _names.Keys;

    /// <summary>Returns a new scope with <paramref name="name"/> bound to <paramref name="type"/>.</summary>
    public TypeScope With(string name, KoineType type)
    {
        var copy = new Dictionary<string, KoineType>(_names, StringComparer.Ordinal) { [name] = type };
        return new TypeScope(copy);
    }

    /// <summary>Convenience: bind <paramref name="name"/> to a syntactic type resolved against <paramref name="index"/>.</summary>
    public TypeScope WithRef(string name, TypeRef type, ModelIndex index) => With(name, KoineType.From(type, index));
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
    private static readonly KoineType Bool = new PrimitiveType("Bool");
    private static readonly KoineType Int = new PrimitiveType("Int");
    private static readonly KoineType Decimal = new PrimitiveType("Decimal");
    private static readonly KoineType String = new PrimitiveType("String");

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

    /// <summary>
    /// The resolved type of an expression as a <see cref="KoineType"/> (never <c>null</c>; an
    /// undeterminable type is <see cref="ErrorType"/>). The structural-type entry point consumers
    /// should prefer.
    /// </summary>
    public KoineType TypeOf(Expr expr, TypeScope scope) => new InferVisitor(this, scope).Visit(expr);

    /// <summary>
    /// A <c>TypeRef?</c> shim over <see cref="TypeOf"/> for consumers not yet migrated to
    /// <see cref="KoineType"/>: an <see cref="ErrorType"/> result maps back to <c>null</c>.
    /// </summary>
    public TypeRef? Infer(Expr expr, TypeScope scope) => TypeOf(expr, scope).ToTypeRef();

    /// <summary>
    /// The exhaustive expression-type inference. Carries the lexical <see cref="TypeScope"/> as a
    /// mutable field, pushed/restored around the sub-scopes introduced by <c>let</c> bindings and
    /// collection-aggregate lambdas. A fresh instance is created per call, so the mutable scope
    /// never leaks across the re-entrant callers (checker, translator, analyzer).
    /// </summary>
    private sealed class InferVisitor : ExprVisitor<KoineType>
    {
        private readonly TypeResolver _owner;
        private TypeScope _scope;

        public InferVisitor(TypeResolver owner, TypeScope scope)
        {
            _owner = owner;
            _scope = scope;
        }

        private ModelIndex Index => _owner._index;

        protected override KoineType VisitLiteral(LiteralExpr n) => n.Kind switch
        {
            LiteralKind.Int => Int,
            LiteralKind.Decimal => Decimal,
            LiteralKind.String => String,
            LiteralKind.Bool => Bool,
            _ => ErrorType.Instance
        };

        protected override KoineType VisitIdentifier(IdentifierExpr n)
        {
            // A name bound to ErrorType (e.g. a let binding / lambda parameter whose type couldn't
            // be determined) propagates as unknown.
            if (_scope.TryGet(n.Name, out KoineType bound))
            {
                return bound;
            }

            if (BuiltinOps.NullaryValueOps.TryGetValue(n.Name, out var builtinType))
            {
                return KoineType.From(new TypeRef(builtinType), Index);
            }

            return Index.EnumMemberToType.TryGetValue(n.Name, out var en)
                ? new NamedType(en, TypeKind.Enum)
                : ErrorType.Instance;
        }

        protected override KoineType VisitUnary(UnaryExpr n) =>
            n.Op == UnaryOp.Not ? Bool : Visit(n.Operand);

        protected override KoineType VisitMatch(MatchExpr n) => Bool;

        protected override KoineType VisitGuard(GuardExpr n) => Visit(n.Body);

        protected override KoineType VisitBinary(BinaryExpr n)
        {
            switch (n.Op)
            {
                case BinaryOp.Or or BinaryOp.And
                  or BinaryOp.Eq or BinaryOp.Neq
                  or BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge:
                    return Bool;
                default: // arithmetic
                    KoineType l = Visit(n.Left);
                    KoineType r = Visit(n.Right);
                    var optional = l.IsOptional || r.IsOptional;
                    KoineType arithmetic =
                        l.IsValueLike ? l :                               // value-object scalar arithmetic (Money * qty)
                        r.IsValueLike ? r :
                        l.Name == "Decimal" || r.Name == "Decimal" ? Decimal :
                        l.Name == "Int" && r.Name == "Int" ? Int :
                        !l.IsError ? l : r;                               // was `l ?? r`
                    return arithmetic.IsError ? ErrorType.Instance : arithmetic.WithOptional(optional);
            }
        }

        protected override KoineType VisitConditional(ConditionalExpr n)
        {
            // The result is optional if EITHER branch is optional.
            KoineType then = Visit(n.Then);
            KoineType @else = Visit(n.Else);
            KoineType result = !then.IsError ? then : @else;
            return result.IsError ? ErrorType.Instance : result.WithOptional(then.IsOptional || @else.IsOptional);
        }

        protected override KoineType VisitCoalesce(CoalesceExpr n)
        {
            // `a ?? b` is non-null only if the fallback `b` is non-null.
            KoineType left = Visit(n.Left);
            KoineType right = Visit(n.Right);
            KoineType result = !left.IsError ? left : right;
            return result.IsError ? ErrorType.Instance : result.WithOptional(right.IsError || right.IsOptional);
        }

        protected override KoineType VisitMemberAccess(MemberAccessExpr n)
        {
            // Qualified enum reference: `EnumType.Member` -> the enum type.
            if (n.Target is IdentifierExpr typeId && Index.IsEnumType(typeId.Name))
            {
                return new NamedType(typeId.Name, TypeKind.Enum);
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
            KoineType target = Visit(n.Target);
            if (!target.IsError && Index.TryGetMemberType(target.Qualifier ?? _owner.Context, target.Name!, op, out TypeRef mt))
            {
                return KoineType.From(mt, Index);
            }

            return ErrorType.Instance;
        }

        protected override KoineType VisitCall(CallExpr n)
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
                if (Visit(n.Target).SequenceElement is { } element && n.Args is [LambdaExpr lambda])
                {
                    TypeScope saved = _scope;
                    _scope = _scope.With(lambda.Parameter, element);
                    KoineType result = Visit(lambda.Body);
                    _scope = saved;
                    return result;
                }
            }

            // A 0-arg call whose receiver type declares a spec by this name is a spec invocation
            // (R10.1): a spec is a boolean predicate, so the call's type is Bool. This stays
            // target-agnostic — a spec is a Koine construct, not a C# extension method.
            if (n.Args.Count == 0)
            {
                KoineType receiver = Visit(n.Target);
                if (!receiver.IsError && Index.TryGetSpec(receiver.Name!, op, out _))
                {
                    return Bool;
                }
            }

            return ErrorType.Instance;
        }

        protected override KoineType VisitLet(LetExpr n)
        {
            // Fold bindings into the scope in order (each sees the previous; a value cannot see
            // its own name, since it is registered AFTER inference), then infer the body in the
            // extended scope. Restore on exit. An undeterminable binding value is ErrorType.
            TypeScope saved = _scope;
            foreach (LetBinding b in n.Bindings)
            {
                _scope = _scope.With(b.Name, Visit(b.Value));
            }

            KoineType result = Visit(n.Body);
            _scope = saved;
            return result;
        }

        // LambdaExpr only has meaning inside a CallExpr.
        protected override KoineType VisitLambda(LambdaExpr n) => ErrorType.Instance;
    }

    /// <summary>The element type of a <c>List&lt;T&gt;</c> or <c>Set&lt;T&gt;</c> receiver, else <c>null</c>.</summary>
    public static TypeRef? ElementOf(TypeRef? type) =>
        type is { Name: ModelIndex.ListTypeName or ModelIndex.SetTypeName, Element: { } element } ? element : null;
}
