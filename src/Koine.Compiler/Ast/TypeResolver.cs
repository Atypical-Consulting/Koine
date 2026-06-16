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
        foreach (var pair in names)
            _names[pair.Key] = pair.Value;
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

    public TypeRef? Infer(Expr expr, TypeScope scope)
    {
        switch (expr)
        {
            case LiteralExpr lit:
                return lit.Kind switch
                {
                    LiteralKind.Int => Int,
                    LiteralKind.Decimal => Decimal,
                    LiteralKind.String => String,
                    LiteralKind.Bool => Bool,
                    _ => null
                };

            case IdentifierExpr id:
                // A name bound to the "?" sentinel (e.g. a lambda parameter whose
                // element type couldn't be determined) is treated as unknown.
                if (scope.TryGet(id.Name, out var bound))
                    return bound.Name == "?" ? null : bound;
                if (BuiltinOps.NullaryValueOps.TryGetValue(id.Name, out var builtinType))
                    return new TypeRef(builtinType);
                return _index.EnumMemberToType.TryGetValue(id.Name, out var en) ? new TypeRef(en) : null;

            case UnaryExpr u:
                return u.Op == UnaryOp.Not ? Bool : Infer(u.Operand, scope);

            case BinaryExpr b:
                return InferBinary(b, scope);

            case MatchExpr:
                return Bool;

            case GuardExpr g:
                return Infer(g.Body, scope);

            case ConditionalExpr c:
                {
                    // The result is optional if EITHER branch is optional.
                    var then = Infer(c.Then, scope);
                    var @else = Infer(c.Else, scope);
                    var result = then ?? @else;
                    return result is null
                        ? null
                        : result with { IsOptional = (then?.IsOptional ?? false) || (@else?.IsOptional ?? false) };
                }

            case CoalesceExpr co:
                {
                    // `a ?? b` is non-null only if the fallback `b` is non-null.
                    var left = Infer(co.Left, scope);
                    var right = Infer(co.Right, scope);
                    var result = left ?? right;
                    return result is null
                        ? null
                        : result with { IsOptional = right is null || right.IsOptional };
                }

            case MemberAccessExpr ma:
                return InferMember(ma, scope);

            case CallExpr call:
                return InferCall(call, scope);

            case LetExpr let:
                {
                    // Fold bindings into the scope in order (each sees the previous), then
                    // infer the body in the extended scope.
                    var letScope = scope;
                    foreach (var b in let.Bindings)
                        letScope = letScope.With(b.Name, Infer(b.Value, letScope) ?? new TypeRef("?"));
                    return Infer(let.Body, letScope);
                }

            default:
                return null; // LambdaExpr only has meaning inside a CallExpr
        }
    }

    private TypeRef? InferBinary(BinaryExpr b, TypeScope scope)
    {
        switch (b.Op)
        {
            case BinaryOp.Or or BinaryOp.And
              or BinaryOp.Eq or BinaryOp.Neq
              or BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge:
                return Bool;
            default: // arithmetic
                var l = Infer(b.Left, scope);
                var r = Infer(b.Right, scope);
                var optional = (l?.IsOptional ?? false) || (r?.IsOptional ?? false);
                TypeRef? arithmetic =
                    IsValueLike(l) ? l :                              // value-object scalar arithmetic (Money * qty)
                    IsValueLike(r) ? r :
                    l?.Name == "Decimal" || r?.Name == "Decimal" ? Decimal :
                    l?.Name == "Int" && r?.Name == "Int" ? Int :
                    l ?? r;
                return arithmetic is null ? null : arithmetic with { IsOptional = optional };
        }
    }

    private TypeRef? InferMember(MemberAccessExpr ma, TypeScope scope)
    {
        // Qualified enum reference: `EnumType.Member` -> the enum type.
        if (ma.Target is IdentifierExpr typeId && _index.IsEnumType(typeId.Name))
            return new TypeRef(typeId.Name);

        var op = ma.MemberName;
        if (op == "length")
            return Int;
        if (op is "trim" or "lower" or "upper")
            return String;
        if (op == "isBlank")
            return Bool;
        if (op == "count")
            return Int;
        if (op is "isEmpty" or "isNotEmpty")
            return Bool;
        if (op is "isPresent" or "isNone")
            return Bool;

        // Otherwise a field access on a value/entity type — resolved in the receiver's
        // qualifier context, else this resolver's context (R13.2).
        var target = Infer(ma.Target, scope);
        if (target is not null && _index.TryGetMemberType(target.Qualifier ?? Context, target.Name, op, out var mt))
            return mt;
        return null;
    }

    private TypeRef? InferCall(CallExpr call, TypeScope scope)
    {
        var op = call.Method;
        if (BuiltinOps.StringCallOps.Contains(op))
            return Bool;          // startsWith/endsWith/contains
        if (BuiltinOps.CollectionPredicateOps.Contains(op))
            return Bool; // all/any/none/distinctBy

        if (BuiltinOps.CollectionAggregateOps.Contains(op))             // sum/min/max
        {
            var element = ElementOf(Infer(call.Target, scope));
            if (element is not null && call.Args is [LambdaExpr lambda])
                return Infer(lambda.Body, scope.With(lambda.Parameter, element));
        }
        return null;
    }

    /// <summary>The element type of a <c>List&lt;T&gt;</c> or <c>Set&lt;T&gt;</c> receiver, else <c>null</c>.</summary>
    public static TypeRef? ElementOf(TypeRef? type) =>
        type is { Name: ModelIndex.ListTypeName or ModelIndex.SetTypeName, Element: { } element } ? element : null;
}
