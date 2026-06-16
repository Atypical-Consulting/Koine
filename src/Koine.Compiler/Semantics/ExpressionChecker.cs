using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Scope- and type-aware validation of a single expression. Reports unknown
/// identifiers (honouring lambda-bound parameters), unknown/misapplied built-in
/// operations, conditional branch type mismatches, and Instant comparison
/// mismatches. Type knowledge is best-effort: when a sub-expression's type can't
/// be inferred, no type diagnostic is raised (avoiding false positives).
/// </summary>
internal sealed class ExpressionChecker
{
    private static readonly TypeRef UnknownType = new("?");

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly IReadOnlySet<string> _enumMembers;
    private readonly List<Diagnostic> _diagnostics;
    // Names of specs valid in the current expression's target type (R10.1); a bare
    // reference to one resolves (as a boolean) rather than being an unknown field.
    private readonly IReadOnlySet<string> _specNames;

    // Optional field names currently known to be non-null via a guard/condition
    // (flow narrowing). Saved/restored around guarded sub-expressions.
    private HashSet<string> _present = new(StringComparer.Ordinal);

    public ExpressionChecker(
        ModelIndex index,
        TypeResolver resolver,
        IReadOnlySet<string> enumMembers,
        List<Diagnostic> diagnostics,
        IReadOnlySet<string>? specNames = null)
    {
        _index = index;
        _resolver = resolver;
        _enumMembers = enumMembers;
        _diagnostics = diagnostics;
        _specNames = specNames ?? EmptySet;
    }

    private static readonly IReadOnlySet<string> EmptySet = new HashSet<string>();

    public void Check(Expr expr, TypeScope scope, TypeRef? expected = null)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                if (!scope.Contains(id.Name) && !_enumMembers.Contains(id.Name) && !BuiltinOps.IsNullaryValueOp(id.Name)
                    && !_specNames.Contains(id.Name))
                {
                    // A name that is a spec — just not one valid here — gets a clearer message.
                    if (_index.IsAnySpec(id.Name))
                        Report(DiagnosticCodes.SpecTargetMismatch,
                            $"spec '{id.Name}' is not defined on the enclosing type", id);
                    else
                        Report(DiagnosticCodes.UnknownField,
                            $"unknown field '{id.Name}'{Suggestions.For(id.Name, scope.Names.Concat(_enumMembers).Concat(_specNames))}", id);
                }
                break;

            case LiteralExpr:
                break;

            case UnaryExpr u:
                Check(u.Operand, scope);
                break;

            case MatchExpr m:
                Check(m.Target, scope);
                break;

            case GuardExpr g:
                // `body when cond`: the body is only evaluated when cond holds, so a
                // presence check in cond narrows the body's optional fields.
                Check(g.Condition, scope);
                CheckNarrowed(g.Body, scope, g.Condition, positive: true, expected);
                break;

            case BinaryExpr b:
                Check(b.Left, scope);
                Check(b.Right, scope);
                CheckComparison(b, scope, expected);
                CheckArithmeticNullSafety(b, scope);
                break;

            case CoalesceExpr co:
                Check(co.Left, scope, expected);
                Check(co.Right, scope, expected);
                // Resolve a bare shared enum member against the other side / expected type.
                CheckEnumMemberResolvable(co.Left, ConcreteEnumType(co.Right, scope) ?? expected, scope);
                CheckEnumMemberResolvable(co.Right, ConcreteEnumType(co.Left, scope) ?? expected, scope);
                break;

            case ConditionalExpr c:
                Check(c.Condition, scope);
                // `if cond then a else b`: cond narrows a (true) / b (false).
                CheckNarrowed(c.Then, scope, c.Condition, positive: true, expected);
                CheckNarrowed(c.Else, scope, c.Condition, positive: false, expected);

                // Resolve each branch against the other branch's concrete enum type
                // (or the expected type) so a shared enum member doesn't depend on
                // declaration order; flag genuinely unresolvable members (KOI0213).
                var thenCtx = ConcreteEnumType(c.Else, scope) ?? expected;
                var elseCtx = ConcreteEnumType(c.Then, scope) ?? expected;
                CheckEnumMemberResolvable(c.Then, thenCtx, scope);
                CheckEnumMemberResolvable(c.Else, elseCtx, scope);
                var thenType = ResolveEnumOperand(c.Then, thenCtx, scope) ?? _resolver.Infer(c.Then, scope);
                var elseType = ResolveEnumOperand(c.Else, elseCtx, scope) ?? _resolver.Infer(c.Else, scope);
                if (thenType is not null && elseType is not null && !Compatible(thenType, elseType))
                    Report(DiagnosticCodes.IncompatibleConditionalBranches,
                        $"conditional branches have incompatible types '{thenType.Name}' and '{elseType.Name}'", c);
                break;

            case MemberAccessExpr ma:
                CheckMember(ma, scope);
                break;

            case CallExpr call:
                CheckCall(call, scope);
                break;

            case LetExpr let:
                CheckLet(let, scope, expected);
                break;
        }
    }

    /// <summary>
    /// Checks a <c>let x = e (, y = e)* in body</c>: each binding's value is checked
    /// in the accumulating scope (so it sees earlier bindings but not itself or later
    /// ones), then the body is checked in the fully-extended scope. A binding name that
    /// repeats within the same <c>let</c> is reported as a duplicate.
    /// </summary>
    private void CheckLet(LetExpr let, TypeScope scope, TypeRef? expected)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var bound = scope;
        foreach (var binding in let.Bindings)
        {
            Check(binding.Value, bound);
            if (!seen.Add(binding.Name))
                Report(DiagnosticCodes.DuplicateLetBinding,
                    $"duplicate let binding '{binding.Name}'", let);
            // The binding's value is in scope for the bindings that follow and the body.
            bound = bound.With(binding.Name, _resolver.Infer(binding.Value, bound) ?? UnknownType);
        }
        Check(let.Body, bound, expected);
    }

    private void CheckComparison(BinaryExpr b, TypeScope scope, TypeRef? expected = null)
    {
        var isRelational = b.Op is BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge;
        if (!isRelational && b.Op is not (BinaryOp.Eq or BinaryOp.Neq))
            return;

        var rawLeft = _resolver.Infer(b.Left, scope);
        var rawRight = _resolver.Infer(b.Right, scope);

        // Disambiguating context must come from a CONCRETE enum source (a field, a
        // qualified ref, or an unambiguous member) — not another ambiguous member.
        var concreteLeft = ConcreteEnumType(b.Left, scope);
        var concreteRight = ConcreteEnumType(b.Right, scope);

        // A bare enum member shared by ≥2 enums must be resolvable from the other
        // operand's concrete type or, failing that, the expected type flowing in
        // (the enclosing default/return/transition enum). This matches the
        // conditional/coalesce paths and the emitter; KOI0213 fires only when
        // neither context selects exactly one declaring enum.
        CheckEnumMemberResolvable(b.Left, concreteRight ?? expected, scope);
        CheckEnumMemberResolvable(b.Right, concreteLeft ?? expected, scope);

        // Resolve a bare enum member against the other operand's enum type (or the
        // expected type) so a shared member name (e.g. two enums with `Cancelled`)
        // compares correctly.
        var left = ResolveEnumOperand(b.Left, concreteRight ?? expected, scope) ?? rawLeft;
        var right = ResolveEnumOperand(b.Right, concreteLeft ?? expected, scope) ?? rawRight;

        // Operands must be comparable to each other: same type, or both numeric.
        // (Subsumes the Instant rule: Instant is only comparable to Instant.)
        if (left is not null && right is not null && !Compatible(left, right))
        {
            Report(DiagnosticCodes.IncomparableTypes, $"cannot compare '{left.Name}' with '{right.Name}'", b);
            return;
        }

        // Relational (< <= > >=) additionally requires an ordered operand type;
        // value objects, strings and bools have no relational operators in C#.
        if (isRelational)
        {
            // A lifted relational op on a null operand is silently false — a trap.
            if (IsUnguardedOptional(b.Left, left) || IsUnguardedOptional(b.Right, right))
            {
                Report(DiagnosticCodes.OptionalDereference,
                    "optional value may be null; guard with isPresent or use '??' before comparing", b);
                return;
            }

            var operand = !IsOrderable(left) ? left : !IsOrderable(right) ? right : null;
            if (operand is not null)
                Report(DiagnosticCodes.RelationalOnNonOrderable, $"relational operator cannot be applied to '{operand.Name}'", b);
        }
    }

    private void CheckArithmeticNullSafety(BinaryExpr b, TypeScope scope)
    {
        if (b.Op is not (BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div))
            return;

        var left = _resolver.Infer(b.Left, scope);
        var right = _resolver.Infer(b.Right, scope);
        if (IsUnguardedOptional(b.Left, left) || IsUnguardedOptional(b.Right, right))
            Report(DiagnosticCodes.OptionalDereference,
                "optional value may be null; guard with isPresent or use '??' before arithmetic", b);
    }

    /// <summary>
    /// Flags a bare enum member that belongs to more than one enum and cannot be
    /// resolved from the comparison's other operand type.
    /// </summary>
    private void CheckEnumMemberResolvable(Expr operand, TypeRef? otherType, TypeScope scope)
    {
        if (operand is not IdentifierExpr id || scope.Contains(id.Name))
            return; // a field reference, not a bare enum member

        var owners = _index.EnumsDeclaring(id.Name);
        if (owners.Count <= 1)
            return; // unambiguous (or not an enum member)

        if (otherType is not null && owners.Contains(otherType.Name))
            return; // resolved by the other operand's enum type

        Report(DiagnosticCodes.AmbiguousEnumMember,
            $"ambiguous enum member '{id.Name}' (declared by {string.Join(", ", owners)}); qualify as Enum.{id.Name}", operand);
    }

    /// <summary>
    /// If <paramref name="operand"/> is a bare enum member that the other operand's
    /// enum type declares, resolves it to that enum type; otherwise <c>null</c>.
    /// </summary>
    private TypeRef? ResolveEnumOperand(Expr operand, TypeRef? otherType, TypeScope scope)
    {
        if (operand is IdentifierExpr id && !scope.Contains(id.Name)
            && otherType is not null && _index.EnumsDeclaring(id.Name).Contains(otherType.Name))
            return otherType;
        return null;
    }

    /// <summary>
    /// The enum type an operand concretely denotes for disambiguation purposes: a
    /// field's enum type, a qualified <c>Enum.Member</c>, or an UNAMBIGUOUS bare
    /// member. An ambiguous bare member denotes no concrete type (returns null).
    /// </summary>
    private TypeRef? ConcreteEnumType(Expr operand, TypeScope scope)
    {
        if (operand is IdentifierExpr id)
        {
            if (scope.Contains(id.Name))
            {
                var t = _resolver.Infer(operand, scope);
                return t is not null && _index.IsEnumType(t.Name) ? t : null;
            }
            var owners = _index.EnumsDeclaring(id.Name);
            return owners.Count == 1 ? new TypeRef(owners[0]) : null;
        }

        if (operand is MemberAccessExpr { Target: IdentifierExpr typeId } && _index.IsEnumType(typeId.Name))
            return new TypeRef(typeId.Name);

        var inferred = _resolver.Infer(operand, scope);
        return inferred is not null && _index.IsEnumType(inferred.Name) ? inferred : null;
    }

    /// <summary>True when a type supports the C# relational operators (or is unknown).</summary>
    private static bool IsOrderable(TypeRef? t) =>
        t is null || TypeResolver.IsNumeric(t) || t.Name == "Instant";

    /// <summary>An optional operand that has not been narrowed to present by a guard.</summary>
    private bool IsUnguardedOptional(Expr expr, TypeRef? type) =>
        type is { IsOptional: true } && !IsNarrowed(expr);

    /// <summary>True when the expression is a field already proven present in this scope.</summary>
    private bool IsNarrowed(Expr expr) => expr is IdentifierExpr id && _present.Contains(id.Name);

    /// <summary>Checks <paramref name="body"/> with the fields proven present by <paramref name="cond"/> narrowed.</summary>
    private void CheckNarrowed(Expr body, TypeScope scope, Expr cond, bool positive, TypeRef? expected = null)
    {
        var saved = _present;
        _present = new HashSet<string>(saved, StringComparer.Ordinal);
        foreach (var name in CollectPresent(cond, positive))
            _present.Add(name);
        Check(body, scope, expected);
        _present = saved;
    }

    /// <summary>
    /// The optional field names proven non-null when <paramref name="cond"/> evaluates
    /// to <paramref name="positive"/>, from <c>isPresent</c>/<c>isNone</c> guards
    /// (and their <c>&amp;&amp;</c>/<c>||</c>/<c>!</c> combinations).
    /// </summary>
    private static IEnumerable<string> CollectPresent(Expr cond, bool positive)
    {
        switch (cond)
        {
            case MemberAccessExpr { Target: IdentifierExpr id, MemberName: "isPresent" } when positive:
                yield return id.Name;
                break;
            case MemberAccessExpr { Target: IdentifierExpr id, MemberName: "isNone" } when !positive:
                yield return id.Name;
                break;
            case UnaryExpr { Op: UnaryOp.Not } u:
                foreach (var n in CollectPresent(u.Operand, !positive))
                    yield return n;
                break;
            case BinaryExpr { Op: BinaryOp.And } b when positive:
                foreach (var n in CollectPresent(b.Left, true))
                    yield return n;
                foreach (var n in CollectPresent(b.Right, true))
                    yield return n;
                break;
            case BinaryExpr { Op: BinaryOp.Or } b when !positive:
                foreach (var n in CollectPresent(b.Left, false))
                    yield return n;
                foreach (var n in CollectPresent(b.Right, false))
                    yield return n;
                break;
        }
    }

    private void CheckMember(MemberAccessExpr ma, TypeScope scope)
    {
        // Qualified enum reference `EnumType.Member`: validate the member, don't
        // treat the enum type name as a field.
        if (ma.Target is IdentifierExpr typeId && _index.IsEnumType(typeId.Name))
        {
            if (!_index.EnumsDeclaring(ma.MemberName).Contains(typeId.Name))
                Report(DiagnosticCodes.UnknownEnumMemberForType,
                    $"unknown enum member '{ma.MemberName}' for type '{typeId.Name}'", ma);
            return;
        }

        Check(ma.Target, scope);
        var op = ma.MemberName;
        var target = _resolver.Infer(ma.Target, scope);

        // Presence checks require an optional receiver (else they are meaningless,
        // and `is null` on a non-nullable value type does not even compile).
        if (BuiltinOps.OptionalMemberOps.Contains(op))
        {
            if (target is not null && !target.IsOptional)
                Report(DiagnosticCodes.PresenceOnNonOptional,
                    $"'{op}' can only be applied to an optional value; '{target.Name}' is not optional", ma);
            return;
        }

        // Any other access on an optional value (not narrowed to present) risks null.
        if (IsUnguardedOptional(ma.Target, target))
        {
            Report(DiagnosticCodes.OptionalDereference,
                $"optional value may be null; guard with isPresent or use '??' before '.{op}'", ma);
            return;
        }

        if (BuiltinOps.StringMemberOps.Contains(op))
        {
            if (target is not null && target.Name != "String")
                Report(DiagnosticCodes.StringOperationOnNonString, $"string operation '{op}' cannot be applied to '{target.Name}'", ma);
        }
        else if (BuiltinOps.CollectionMemberOps.Contains(op))
        {
            if (target is not null && !IsCollection(target))
                Report(DiagnosticCodes.CollectionOperationOnNonCollection, $"collection operation '{op}' cannot be applied to '{target.Name}'", ma);
        }
        else
        {
            // A plain field access. If the receiver is known we can be strict.
            if (target is null)
                return;
            if (target.Name == "String")
                Report(DiagnosticCodes.UnknownStringOperation, $"unknown string operation '{op}'", ma);
            else if (IsCollection(target))
                Report(DiagnosticCodes.UnknownCollectionOperation, $"unknown collection operation '{op}'", ma);
            else if (_resolver.IsUserType(target) && !_index.TryGetMemberType(target.Qualifier ?? _resolver.Context, target.Name, op, out _))
                Report(DiagnosticCodes.UnknownMember,
                    $"unknown member '{op}' on type '{target.Name}'{Suggestions.For(op, _index.MemberNames(target.Name))}", ma);
            else if (_index.Classify(target.Name) == TypeKind.Primitive)
                // A primitive (Int/Decimal/Bool/Instant) has no accessible members.
                Report(DiagnosticCodes.UnknownMember, $"unknown member '{op}' on type '{target.Name}'", ma);
        }
    }

    /// <summary>List/Set/Map — types that expose count/isEmpty/isNotEmpty.</summary>
    private bool IsCollection(TypeRef t) =>
        _index.Classify(t.Name) is TypeKind.List or TypeKind.Set or TypeKind.Map;

    /// <summary>List/Set — iterable collections that support lambda ops and <c>contains</c>.</summary>
    private bool IsIterable(TypeRef t) =>
        _index.Classify(t.Name) is TypeKind.List or TypeKind.Set;

    private void CheckCall(CallExpr call, TypeScope scope)
    {
        Check(call.Target, scope);
        var op = call.Method;
        var target = _resolver.Infer(call.Target, scope);

        // A call op on an optional receiver (not narrowed to present) risks null.
        if (IsUnguardedOptional(call.Target, target))
            Report(DiagnosticCodes.OptionalDereference,
                $"optional value may be null; guard with isPresent or use '??' before '.{op}'", call);

        if (BuiltinOps.TakesLambda(op))
        {
            if (target is not null && !IsIterable(target))
                Report(DiagnosticCodes.CollectionOperationOnNonCollection, $"collection operation '{op}' cannot be applied to '{target.Name}'", call);

            if (call.Args is [LambdaExpr lambda])
            {
                var element = TypeResolver.ElementOf(target);
                var inner = scope.With(lambda.Parameter, element ?? UnknownType);
                Check(lambda.Body, inner);
                CheckAggregateSelector(op, lambda, inner, call);
            }
            else
            {
                Report(DiagnosticCodes.OperationArgument, $"operation '{op}' expects a single lambda argument", call);
                foreach (var arg in call.Args)
                    Check(arg, scope);
            }
        }
        else if (BuiltinOps.StringCallOps.Contains(op) || BuiltinOps.CollectionElementCallOps.Contains(op))
        {
            foreach (var arg in call.Args)
                Check(arg, scope);
            var collectionContains = op == "contains" && target is not null && IsIterable(target);
            if (target is not null && target.Name != "String" && !collectionContains)
                Report(DiagnosticCodes.StringOperationOnNonString, $"string operation '{op}' cannot be applied to '{target.Name}'", call);

            if (call.Args.Count != 1)
                Report(DiagnosticCodes.OperationArgument, $"operation '{op}' expects a single argument", call);
            else
                CheckCallArgumentType(op, target, call.Args[0], collectionContains, scope, call);
        }
        else
        {
            Report(DiagnosticCodes.UnknownOperation, $"unknown operation '{op}'", call);
            foreach (var arg in call.Args)
                Check(arg, scope);
        }
    }

    /// <summary>
    /// Constrains aggregate selector result types: <c>sum</c> needs a numeric or
    /// value-object selector; <c>min</c>/<c>max</c> need a comparable scalar (value
    /// objects/entities are plain records and are not orderable in C#).
    /// </summary>
    private void CheckAggregateSelector(string op, LambdaExpr lambda, TypeScope inner, CallExpr call)
    {
        if (op is not ("sum" or "min" or "max"))
            return;

        var selector = _resolver.Infer(lambda.Body, inner);
        if (selector is null)
            return;

        if (op == "sum")
        {
            if (!TypeResolver.IsNumeric(selector) && _index.Classify(selector.Name) != TypeKind.Value)
                Report(DiagnosticCodes.AggregateSelector, $"sum requires a numeric or value-object selector, but got '{selector.Name}'", call);
        }
        else // min / max
        {
            var kind = _index.Classify(selector.Name);
            if (_resolver.IsValueLike(selector) || kind == TypeKind.Entity)
                Report(DiagnosticCodes.AggregateSelector, $"{op} requires a comparable selector; '{selector.Name}' is not orderable", call);
        }
    }

    /// <summary>Type-checks the argument of a string/collection call op.</summary>
    private void CheckCallArgumentType(string op, TypeRef? target, Expr arg, bool collectionContains, TypeScope scope, CallExpr call)
    {
        var argType = _resolver.Infer(arg, scope);
        if (argType is null)
            return;

        if (collectionContains)
        {
            var element = TypeResolver.ElementOf(target);
            if (element is not null && !Compatible(argType, element))
                Report(DiagnosticCodes.OperationArgument,
                    $"collection 'contains' expects an argument of type '{element.Name}', but got '{argType.Name}'", call);
        }
        else if (target?.Name == "String" && argType.Name != "String")
        {
            Report(DiagnosticCodes.OperationArgument,
                $"string operation '{op}' expects a string argument, but got '{argType.Name}'", call);
        }
    }

    /// <summary>
    /// Validates a state-transition value against the target field's type: the
    /// value's identifiers/ops are checked, a bare enum member is resolved against
    /// the field's enum, and an incompatible or unsafely-optional value is reported.
    /// </summary>
    public void CheckTransitionValue(Expr value, TypeRef field, string fieldName, TypeScope scope)
    {
        Check(value, scope, field);

        var type = ResolveEnumOperand(value, field, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
            return;

        if (type is { IsOptional: true } && !field.IsOptional)
            Report(DiagnosticCodes.OptionalAssignedToNonOptional,
                $"optional value assigned to non-optional field '{fieldName}'; provide a fallback with '??'", value);
        else if (!Assignable(type, field))
            Report(DiagnosticCodes.TransitionTypeMismatch,
                $"cannot assign a value of type '{FullName(type)}' to field '{fieldName}' of type '{FullName(field)}'", value);
    }

    /// <summary>
    /// Validates a factory initialization value (<c>field &lt;- value</c>) against the
    /// target member's declared type: identifiers/ops are checked, a bare enum member
    /// is resolved against the field's enum, and an incompatible or unsafely-optional
    /// value is reported.
    /// </summary>
    public void CheckInitializationValue(Expr value, TypeRef field, string fieldName, TypeScope scope)
    {
        Check(value, scope, field);

        var type = ResolveEnumOperand(value, field, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
            return;

        if (type is { IsOptional: true } && !field.IsOptional)
            Report(DiagnosticCodes.OptionalAssignedToNonOptional,
                $"optional value assigned to non-optional field '{fieldName}'; provide a fallback with '??'", value);
        else if (!Assignable(type, field))
            Report(DiagnosticCodes.InitializationTypeMismatch,
                $"cannot initialize field '{fieldName}' of type '{FullName(field)}' with a value of type '{FullName(type)}'", value);
    }

    /// <summary>Validates a domain-service operation body against its declared return type.</summary>
    public void CheckOperationReturn(Expr body, TypeRef returnType, TypeScope scope)
    {
        Check(body, scope, returnType);

        var type = ResolveEnumOperand(body, returnType, scope) ?? _resolver.Infer(body, scope);
        if (type is null)
            return;

        if (type is { IsOptional: true } && !returnType.IsOptional)
            Report(DiagnosticCodes.ServiceReturnMismatch,
                $"operation returns an optional value, but its return type '{returnType.Name}' is not optional", body);
        else if (!Assignable(type, returnType))
            Report(DiagnosticCodes.ServiceReturnMismatch,
                $"operation body of type '{FullName(type)}' is not assignable to return type '{FullName(returnType)}'", body);
    }

    /// <summary>Validates a command's <c>result</c> expression against its declared return type.</summary>
    public void CheckCommandResult(Expr value, TypeRef returnType, string commandName, TypeScope scope)
    {
        Check(value, scope, returnType);

        var type = ResolveEnumOperand(value, returnType, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
            return;

        if (type is { IsOptional: true } && !returnType.IsOptional)
            Report(DiagnosticCodes.CommandResultMismatch,
                $"command '{commandName}' returns an optional value, but its return type '{returnType.Name}' is not optional", value);
        else if (!Assignable(type, returnType))
            Report(DiagnosticCodes.CommandResultMismatch,
                $"command '{commandName}' result of type '{FullName(type)}' is not assignable to return type '{FullName(returnType)}'", value);
    }

    /// <summary>Validates an emit payload value against the event field's declared type.</summary>
    public void CheckEmitArg(Expr value, TypeRef field, string eventName, string fieldName, TypeScope scope)
    {
        Check(value, scope, field);

        var type = ResolveEnumOperand(value, field, scope) ?? _resolver.Infer(value, scope);
        if (type is null)
            return;

        if (type is { IsOptional: true } && !field.IsOptional)
            Report(DiagnosticCodes.EmitPayloadMismatch,
                $"event '{eventName}' field '{fieldName}' is not optional, but the value may be null", value);
        else if (!Assignable(type, field))
            Report(DiagnosticCodes.EmitPayloadMismatch,
                $"event '{eventName}' field '{fieldName}' expects '{FullName(field)}', but got '{FullName(type)}'", value);
    }

    /// <summary>Renders a type reference in Koine source syntax for diagnostics.</summary>
    private static string FullName(TypeRef t)
    {
        var s = t switch
        {
            { Value: not null, Element: not null } => $"{t.Name}<{FullName(t.Element)}, {FullName(t.Value)}>",
            { Element: not null } => $"{t.Name}<{FullName(t.Element)}>",
            _ => t.Name
        };
        return t.IsOptional ? s + "?" : s;
    }

    /// <summary>Symmetric comparability (for ==/!= and conditional branches): same shape or both numeric.</summary>
    private static bool Compatible(TypeRef a, TypeRef b) =>
        SameShape(a, b) || (TypeResolver.IsNumeric(a) && TypeResolver.IsNumeric(b));

    /// <summary>
    /// Directional assignability (value -> field, for transitions/emit payloads):
    /// same shape, or an implicit numeric widening (<c>Int</c> -> <c>Decimal</c>).
    /// Unlike <see cref="Compatible"/> it does NOT allow numeric narrowing.
    /// </summary>
    private static bool Assignable(TypeRef value, TypeRef field) =>
        SameShape(value, field) || (value.Name == "Int" && field.Name == "Decimal");

    /// <summary>Structural type equivalence, recursing into generic arguments (ignores optionality).</summary>
    private static bool SameShape(TypeRef a, TypeRef b)
    {
        if (a.Name != b.Name)
            return false;
        if ((a.Element is null) != (b.Element is null))
            return false;
        if (a.Element is not null && !SameShape(a.Element, b.Element!))
            return false;
        if ((a.Value is null) != (b.Value is null))
            return false;
        if (a.Value is not null && !SameShape(a.Value, b.Value!))
            return false;
        return true;
    }

    private void Report(string code, string message, KoineNode node) =>
        _diagnostics.Add(Diagnostic.Error(code, message, node.Span));
}
