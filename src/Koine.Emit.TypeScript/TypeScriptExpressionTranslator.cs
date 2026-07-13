using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Translates the target-agnostic <see cref="Expr"/> sublanguage into TypeScript expression
/// source, the TS counterpart of <see cref="CSharp.CSharpExpressionTranslator"/>. Member
/// identifiers render as <c>this.&lt;camelCase&gt;</c> (a TS instance property has no
/// parameter/property split — fields ARE the constructor parameters), command/factory
/// parameters and lambda/let bindings render verbatim (camelCase), and enum members render as
/// the string-literal member object access (<c>EnumName.Member</c>). Regex <c>matches</c>
/// lowers to <c>RegExp.test</c>, <c>sum</c>/folds to <c>reduce</c>, and <c>let…in</c> to an IIFE.
/// </summary>
internal sealed class TypeScriptExpressionTranslator
{
    /// <summary>How a member identifier should be rendered.</summary>
    public enum NameMode
    {
        /// <summary>Constructor/invariant context: a member renders as its bare parameter (camelCase).</summary>
        Parameter,
        /// <summary>Instance-body context (getters, commands): a member renders as <c>this.&lt;camelCase&gt;</c>.</summary>
        Property
    }

    private NameMode _mode = NameMode.Property;

    /// <summary>TS rendering for each nullary value builtin (e.g. <c>now</c> -&gt; <c>Instant.now()</c>).</summary>
    private static readonly IReadOnlyDictionary<string, string> NullaryValueOpsTypeScript =
        new Dictionary<string, string>(StringComparer.Ordinal) { ["now"] = "Instant.now()" };

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly TypeScriptTypeMapper _typeMapper;
    private readonly TypeScope _scope;
    private readonly ISet<string> _memberNames;
    private readonly IReadOnlyDictionary<string, string> _enumMemberToType;

    // Per-name shadow stack: pushing a name that's already bound stacks the new binding on top rather
    // than evicting the outer one, so popping it back off restores whatever was there before (#1497).
    private readonly LocalScopeStack _locals = new();

    // When set, a member identifier renders as `receiver.<camelCase>` (e.g. a read-model projection
    // whose members read off the `src` parameter), the TS analogue of the C# translator's
    // memberReceiver. Overrides the `this.`/bare NameMode rendering for members.
    private readonly string? _memberReceiver;

    // The enum type the whole expression is expected to produce; qualifies a bare shared
    // enum member where a comparison hint does not reach.
    private string? _expectedEnum;

    private int _sumCounter;

    // The neutral RegexMatchTimeoutMs author intent (#794/#812). JS `RegExp` has no synchronous per-call
    // timeout, so this is ADVISORY: when set, the call site passes it to the runtime `regexMatch` seam's
    // `timeoutMs?` parameter (the documented RE2/linear-engine swap point); null ⇒ today's two-arg call.
    private readonly int? _regexMatchTimeoutMs;

    public TypeScriptExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        TypeScriptTypeMapper typeMapper,
        string? context = null,
        string? memberReceiver = null,
        int? regexMatchTimeoutMs = null)
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _typeMapper = typeMapper;
        _scope = TypeScope.FromMembers(members, index);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType;
        _memberReceiver = memberReceiver;
        _regexMatchTimeoutMs = regexMatchTimeoutMs;
    }

    public void PushLocal(string name, TypeRef? type = null) => _locals.PushLocal(name, type);

    public void PopLocal(string name) => _locals.PopLocal(name);

    private TypeScope EffectiveScope()
    {
        TypeScope scope = _scope;
        foreach (KeyValuePair<string, TypeRef> kv in _locals.ActiveBindings)
        {
            scope = scope.WithRef(kv.Key, kv.Value, _index);
        }

        return scope;
    }

    /// <summary>Translates an expression to a TS expression string (members render as <c>this.x</c>).</summary>
    public string Translate(Expr expr, string? expectedEnum = null) => Translate(expr, NameMode.Property, expectedEnum);

    /// <summary>Translates an expression with an explicit member-rendering mode.</summary>
    public string Translate(Expr expr, NameMode mode, string? expectedEnum = null)
    {
        var prevMode = _mode;
        _mode = mode;
        _expectedEnum = expectedEnum;
        var sb = new StringBuilder();
        Write(expr, sb);
        _expectedEnum = null;
        _mode = prevMode;
        return sb.ToString();
    }

    /// <summary>
    /// Renders the logical negation of a boolean condition, for guard emission where the
    /// assertion's failure is tested. Mirrors the C# translator: peel a leading <c>!</c>,
    /// flip a top-level comparison, else wrap once in <c>!(...)</c>.
    /// </summary>
    public string TranslateNegated(Expr expr, NameMode mode = NameMode.Property, string? expectedEnum = null)
    {
        var prevMode = _mode;
        _mode = mode;
        _expectedEnum = expectedEnum;
        var sb = new StringBuilder();
        switch (expr)
        {
            case UnaryExpr { Op: UnaryOp.Not } un:
                Write(un.Operand, sb);
                break;
            // A Decimal/value-object comparison cannot be flipped with a plain operator (it lowers
            // to `.compareTo`/`.equals`), so negate it by wrapping the positive form once.
            case BinaryExpr vbin when Flip(vbin.Op) is not null && IsValueComparison(vbin):
                sb.Append("!(");
                WriteBinary(vbin, sb, parenthesize: false);
                sb.Append(')');
                break;
            case BinaryExpr bin when Flip(bin.Op) is { } flipped:
                WriteOperand(bin.Left, sb, EnumTypeName(bin.Right));
                sb.Append(' ').Append(flipped).Append(' ');
                WriteOperand(bin.Right, sb, EnumTypeName(bin.Left));
                break;
            case ConditionalExpr c when TryBoolLiterals(c, out var whenTrue):
                if (whenTrue)
                {
                    sb.Append("!(");
                    Write(c.Condition, sb);
                    sb.Append(')');
                }
                else
                {
                    Write(c.Condition, sb);
                }
                break;
            default:
                sb.Append("!(");
                Write(expr, sb);
                sb.Append(')');
                break;
        }
        _expectedEnum = null;
        _mode = prevMode;
        return sb.ToString();
    }

    private static string? Flip(BinaryOp op) => op switch
    {
        BinaryOp.Eq => "!==",
        BinaryOp.Neq => "===",
        BinaryOp.Lt => ">=",
        BinaryOp.Le => ">",
        BinaryOp.Gt => "<=",
        BinaryOp.Ge => "<",
        _ => null
    };

    private string? EnumTypeName(Expr expr)
    {
        TypeRef? type = _resolver.Infer(expr, EffectiveScope());
        return type is not null && _index.Classify(type.Name) == TypeKind.Enum ? type.Name : null;
    }

    private void Write(Expr expr, StringBuilder sb)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                WriteIdentifier(id.Name, sb);
                break;
            case LiteralExpr lit:
                WriteLiteral(lit, sb);
                break;
            case BinaryExpr bin:
                WriteBinary(bin, sb, parenthesize: true);
                break;
            case UnaryExpr un:
                sb.Append(un.Op == UnaryOp.Not ? "!" : "-");
                if (un.Operand is IdentifierExpr or LiteralExpr or BinaryExpr or ConditionalExpr or CoalesceExpr)
                {
                    Write(un.Operand, sb);
                }
                else
                {
                    sb.Append('(');
                    Write(un.Operand, sb);
                    sb.Append(')');
                }
                break;
            case ConditionalExpr cond when TryBoolLiterals(cond, out var whenTrue):
                if (whenTrue)
                {
                    Write(cond.Condition, sb);
                }
                else
                {
                    sb.Append("!(");
                    Write(cond.Condition, sb);
                    sb.Append(')');
                }
                break;
            case ConditionalExpr cond:
                TypeScope condScope = EffectiveScope();
                TypeRef? thenType = _resolver.Infer(cond.Then, condScope);
                TypeRef? elseType = _resolver.Infer(cond.Else, condScope);
                sb.Append('(');
                Write(cond.Condition, sb);
                sb.Append(" ? ");
                WriteReconciledBranch(cond.Then, thenType, cond.Else, elseType, sb);
                sb.Append(" : ");
                WriteReconciledBranch(cond.Else, elseType, cond.Then, thenType, sb);
                sb.Append(')');
                break;
            case CoalesceExpr co:
                sb.Append('(');
                Write(co.Left, sb);
                sb.Append(" ?? ");
                Write(co.Right, sb);
                sb.Append(')');
                break;
            case MemberAccessExpr ma:
                WriteMemberAccess(ma, sb);
                break;
            case CallExpr call:
                WriteCall(call, sb);
                break;
            case MatchExpr m:
                // raw matches /pat/  ->  regexMatch(/pat/, raw)   (or `…, raw, <ms>)` when the key is set)
                // Routed through the runtime `regexMatch` seam (not an inline `/pat/.test(...)`) so an
                // author-supplied pattern over untrusted input has a single ReDoS chokepoint (#641).
                // The seam preserves `matches` semantics exactly (it IS `.test`) — JS has no synchronous
                // per-call regex timeout — and is the one place to swap in a linear-time engine (RE2).
                // When the neutral RegexMatchTimeoutMs key is set (#794/#812) the author's intent is
                // threaded into the seam's advisory `timeoutMs?` parameter so the future RE2 swap can honor
                // it; the default engine ignores it, so matching behavior is unchanged.
                sb.Append("regexMatch(/").Append(m.Pattern).Append("/, ");
                Write(m.Target, sb);
                if (_regexMatchTimeoutMs is { } ms)
                {
                    sb.Append(", ").Append(ms.ToString(System.Globalization.CultureInfo.InvariantCulture));
                }

                sb.Append(')');
                break;
            case GuardExpr g:
                Write(g.Body, sb);
                break;
            case LetExpr let:
                WriteLet(let, sb);
                break;
            default:
                sb.Append("/* unsupported expression */ undefined");
                break;
        }
    }

    /// <summary>
    /// Writes one <c>ConditionalExpr</c> branch, individually widened to <c>Decimal</c> when its own
    /// inferred type is a non-optional <c>Int</c> while the SIBLING branch is <c>Decimal</c>
    /// (<c>Decimal.fromInt(...)</c>), or null-check-widened when its own inferred type is an OPTIONAL
    /// <c>Int</c> while the SIBLING branch is <c>Decimal</c> — a JS <c>number | undefined</c> has no
    /// <c>Option.map</c>, so the widen is an inline arrow function that passes <c>undefined</c> through
    /// and widens the present value (<see cref="TsRuntime"/>'s <c>Decimal</c> has no <c>number</c>
    /// overload). <see cref="TypeResolver"/> already widens the conditional's own aggregate type to the
    /// wider/optional-joined type of the two branches (#975), so an unreconciled pair emits two
    /// disagreeing types in the same ternary — a real <c>tsc --strict</c> TS2322 (issue #1344; the
    /// numeric-only case, the optional-numeric case, and both at once). Reconciling per-branch (rather
    /// than a single wrap around the whole conditional) is required because the branches disagree with
    /// EACH OTHER, not with an externally supplied target type. Fixed here in the emitter (not the
    /// semantic validator): a widened or optional-joined conditional is a legitimate, cross-target-
    /// sanctioned pattern (#975) — this is a TypeScript-only rendering gap, not a modeling error.
    /// Unlike the Rust/Java siblings, TypeScript has NO analogue of <c>Some(...)</c>/<c>Optional.of(...)</c>
    /// wrapping: a Koine optional type maps to a plain union with <c>undefined</c> (<c>T | undefined</c>),
    /// and a bare, non-optional <c>T</c> value is already structurally assignable wherever
    /// <c>T | undefined</c> is expected — verified under <c>tsc --strict</c> — so a non-optional branch
    /// against an optional sibling needs no rendering change at all. <c>NeedsWiden</c> and
    /// <c>NeedsOptionalWiden</c> are mutually exclusive (they key off the same branch's own optionality).
    /// The DECISION — which dimensions apply — is the shared, cross-target
    /// <see cref="BranchReconciliation.Classify"/> (#1368); only the TypeScript RENDERING below is local
    /// (TS ignores the classifier's <see cref="BranchReconciliation.NeedsSomeWrap"/>, its optional being a
    /// plain <c>| undefined</c> union that needs no lift).
    /// <paramref name="branchType"/>/<paramref name="siblingType"/> are inferred once by the caller and
    /// passed in rather than re-inferred here — <c>Then</c>/<c>Else</c> would otherwise each be walked
    /// twice per conditional (#1369).
    /// </summary>
    private void WriteReconciledBranch(Expr branch, TypeRef? branchType, Expr sibling, TypeRef? siblingType, StringBuilder sb)
    {
        BranchReconciliation needs = BranchReconciliation.Classify(branchType, siblingType);

        if (needs.NeedsWiden)
        {
            sb.Append("Decimal.fromInt(");
            Write(branch, sb);
            sb.Append(')');
            return;
        }

        if (needs.NeedsOptionalWiden)
        {
            sb.Append("((__v: ").Append(_typeMapper.Map(branchType!))
              .Append(") => (__v === undefined ? undefined : Decimal.fromInt(__v)))(");
            Write(branch, sb);
            sb.Append(')');
            return;
        }

        Write(branch, sb);
    }

    private void WriteBinary(BinaryExpr bin, StringBuilder sb, bool parenthesize)
    {
        // Decimal arithmetic must go through the runtime methods (a JS `+`/`*` on a string-backed
        // Decimal is meaningless), as must value-object additive folds.
        if (TryWriteValueArithmetic(bin, sb))
        {
            return;
        }

        // Decimal / value-object comparison and equality go through `.compareTo`/`.equals`, since a
        // string-backed Decimal cannot be ordered with `<`/`>` nor equated with `===`.
        if (TryWriteValueComparison(bin, sb, parenthesize))
        {
            return;
        }

        if (parenthesize)
        {
            sb.Append('(');
        }

        // A String-typed `+` (string concatenation) routes Bool operands through
        // WriteStringConcatOperand so they are rendered as `String(boolExpr)` — an explicit
        // conversion that makes the canonical cross-target "true"/"false" choice visible in
        // the emitted code, matching PHP's ternary lowering and C#'s explicit ternary (#806).
        if (IsStringConcat(bin))
        {
            WriteStringConcatOperand(bin.Left, sb);
            sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
            WriteStringConcatOperand(bin.Right, sb);
        }
        else
        {
            WriteOperand(bin.Left, sb, EnumTypeName(bin.Right));
            sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
            WriteOperand(bin.Right, sb, EnumTypeName(bin.Left));
        }

        if (parenthesize)
        {
            sb.Append(')');
        }
    }

    /// <summary>
    /// True when <paramref name="bin"/> is a <c>+</c> whose inferred type is <c>String</c> —
    /// i.e. a string concatenation that may need Bool operand lowering (#806).
    /// </summary>
    private bool IsStringConcat(BinaryExpr bin)
        => bin.Op == BinaryOp.Add
        && _resolver.Infer(bin, EffectiveScope()) is { Name: "String" };

    /// <summary>
    /// Writes one operand of a String-typed <c>+</c>, lowering a non-optional <c>Bool</c>-typed
    /// operand to <c>String(boolExpr)</c> so the canonical cross-target <c>"true"</c>/<c>"false"</c>
    /// strings are produced explicitly (TypeScript's <c>+</c> already yields <c>"true"</c>/<c>"false"</c>
    /// implicitly, but the explicit <c>String()</c> call makes the lowering visible and consistent
    /// with PHP's ternary and C#'s ternary renderings) (#806).
    /// </summary>
    private void WriteStringConcatOperand(Expr expr, StringBuilder sb)
    {
        if (_resolver.Infer(expr, EffectiveScope()) is { Name: "Bool", IsOptional: false })
        {
            sb.Append("String(");
            Write(expr, sb);
            sb.Append(')');
            return;
        }

        WriteOperand(expr, sb, enumHint: null);
    }

    /// <summary>
    /// Renders ordering / equality of <c>Decimal</c> (and orderable value objects) via the runtime
    /// surface: <c>a.compareTo(b) &lt;op&gt; 0</c> for ordering, <c>a.equals(b)</c> for equality. A
    /// numeric literal on either side of a Decimal comparison is lifted to a <c>Decimal</c>.
    /// </summary>
    private bool TryWriteValueComparison(BinaryExpr bin, StringBuilder sb, bool parenthesize)
    {
        if (bin.Op is not (BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge or BinaryOp.Eq or BinaryOp.Neq))
        {
            return false;
        }

        TypeScope scope = EffectiveScope();
        TypeRef? left = _resolver.Infer(bin.Left, scope);
        TypeRef? right = _resolver.Infer(bin.Right, scope);
        var leftDecimal = left?.Name == "Decimal";
        var rightDecimal = right?.Name == "Decimal";
        var isDecimal = leftDecimal || rightDecimal;
        var isValue = _resolver.IsValueLike(left) || _resolver.IsValueLike(right);

        if (!isDecimal && !isValue)
        {
            return false;
        }

        if (parenthesize)
        {
            sb.Append('(');
        }

        // Equality maps to `.equals`; the receiver must be the value side (not a bare literal).
        if (bin.Op is BinaryOp.Eq or BinaryOp.Neq)
        {
            if (bin.Op == BinaryOp.Neq)
            {
                sb.Append('!');
            }
            WriteDecimalAware(bin.Left, isDecimal, sb);
            sb.Append(".equals(");
            WriteDecimalAware(bin.Right, isDecimal, sb);
            sb.Append(')');
        }
        else
        {
            WriteDecimalAware(bin.Left, isDecimal, sb);
            sb.Append(".compareTo(");
            WriteDecimalAware(bin.Right, isDecimal, sb);
            sb.Append(") ").Append(OperatorOf(bin.Op)).Append(" 0");
        }

        if (parenthesize)
        {
            sb.Append(')');
        }
        return true;
    }

    /// <summary>True when a binary comparison involves a <c>Decimal</c> or value-object operand (lowers to method calls).</summary>
    private bool IsValueComparison(BinaryExpr bin)
    {
        if (bin.Op is not (BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge or BinaryOp.Eq or BinaryOp.Neq))
        {
            return false;
        }
        TypeScope scope = EffectiveScope();
        TypeRef? left = _resolver.Infer(bin.Left, scope);
        TypeRef? right = _resolver.Infer(bin.Right, scope);
        return left?.Name == "Decimal" || right?.Name == "Decimal" || _resolver.IsValueLike(left) || _resolver.IsValueLike(right);
    }

    /// <summary>Writes an operand, lifting a bare numeric literal to a <c>Decimal</c> when the comparison is decimal-valued.</summary>
    private void WriteDecimalAware(Expr expr, bool isDecimal, StringBuilder sb)
    {
        if (isDecimal && expr is LiteralExpr { Kind: LiteralKind.Int or LiteralKind.Decimal } lit)
        {
            sb.Append("new Decimal('").Append(lit.Text).Append("')");
            return;
        }
        Write(expr, sb);
    }

    /// <summary>
    /// Renders Decimal / value-object arithmetic via the runtime's method surface
    /// (<c>.add</c>/<c>.subtract</c>/<c>.multiply</c>/<c>.divide</c>) instead of a JS operator.
    /// Equality and comparison still use the inline operators. Returns false for ordinary numeric
    /// arithmetic.
    /// </summary>
    private bool TryWriteValueArithmetic(BinaryExpr bin, StringBuilder sb)
    {
        if (bin.Op is not (BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div))
        {
            return false;
        }

        TypeScope scope = EffectiveScope();
        TypeRef? left = _resolver.Infer(bin.Left, scope);
        TypeRef? right = _resolver.Infer(bin.Right, scope);
        var leftDecimal = left?.Name == "Decimal";
        var leftValue = _resolver.IsValueLike(left);
        var rightValue = _resolver.IsValueLike(right);

        // Reversed operand order: `scalar * value-object` (the value object is on the RIGHT, e.g.
        // `0.9 * money`). A value object exposes its OWN scalar multiply, so it must be the receiver
        // regardless of which side it is on — mirroring PhpExpressionTranslator.TryWriteValueBinary's
        // value-object-first check (#778, the PHP Bug-2 fix). Without this the left-only inference
        // below takes the Decimal-receiver path and emits `new Decimal('0.9').multiply(this.money)`,
        // which treats the value object as a `Decimal | number` factor — a `tsc` type error and a
        // wrong runtime value (#788). Only `Mul` admits a scalar; `Decimal * Decimal` keeps its
        // left-receiver order via the path below, where neither side is value-like. Division is
        // non-commutative and the validator rejects `scalar / value-object` (#878), so `Div` never
        // takes this reversed branch.
        if (bin.Op == BinaryOp.Mul && rightValue && !leftValue)
        {
            Write(bin.Right, sb);
            sb.Append(".multiply(");
            WriteScalarArgument(bin.Left, sb);
            sb.Append(')');
            return true;
        }

        if (!leftDecimal && !leftValue)
        {
            return false;
        }

        var method = bin.Op switch
        {
            BinaryOp.Add => "add",
            BinaryOp.Sub => "subtract",
            BinaryOp.Div => "divide",
            _ => "multiply"
        };

        Write(bin.Left, sb);
        sb.Append('.').Append(method).Append('(');
        // A value-object scalar multiply/divide (Money * quantity, fee / 2) takes a plain `number`,
        // so a Decimal literal scalar (e.g. 0.9) renders as a bare number, not a `new Decimal(...)`.
        // Decimal * Decimal/Int or Decimal / Decimal/Int (true decimal arithmetic) passes the operand
        // through unchanged.
        if (bin.Op is BinaryOp.Mul or BinaryOp.Div && leftValue)
        {
            WriteScalarArgument(bin.Right, sb);
        }
        else
        {
            Write(bin.Right, sb);
        }
        sb.Append(')');
        return true;
    }

    /// <summary>
    /// Writes the scalar argument of a value-object scalar multiply. A numeric literal renders bare
    /// (the value object's <c>multiply</c> takes a plain <c>number</c>, not a <c>Decimal</c>); any
    /// other scalar expression renders through <see cref="Write"/>.
    /// </summary>
    private void WriteScalarArgument(Expr scalar, StringBuilder sb)
    {
        if (scalar is LiteralExpr { Kind: LiteralKind.Int or LiteralKind.Decimal } scalarLit)
        {
            sb.Append(scalarLit.Text);
        }
        else
        {
            Write(scalar, sb);
        }
    }

    private void WriteOperand(Expr expr, StringBuilder sb, string? enumHint)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                WriteIdentifier(id.Name, sb, enumHint);
                break;
            case BinaryExpr bin:
                // Sub-expression in operand position keeps its parentheses (cheap, always-correct).
                WriteBinary(bin, sb, parenthesize: true);
                break;
            default:
                Write(expr, sb);
                break;
        }
    }

    private void WriteLet(LetExpr let, StringBuilder sb)
    {
        sb.Append("(() => { ");
        var pushed = new List<string>();
        foreach (LetBinding b in let.Bindings)
        {
            sb.Append("const ").Append(TypeScriptNaming.ToCamelCase(b.Name)).Append(" = ");
            Write(b.Value, sb);
            sb.Append("; ");
            PushLocal(b.Name, _resolver.Infer(b.Value, EffectiveScope()));
            pushed.Add(b.Name);
        }

        sb.Append("return ");
        Write(let.Body, sb);
        sb.Append("; })()");

        for (var i = pushed.Count - 1; i >= 0; i--)
        {
            PopLocal(pushed[i]);
        }
    }

    private void WriteIdentifier(string name, StringBuilder sb, string? enumHint = null)
    {
        // Local (lambda/command/factory parameter, let binding): verbatim camelCase.
        if (_locals.IsLocal(name))
        {
            sb.Append(TypeScriptNaming.ToCamelCase(name));
            return;
        }

        // Nullary value builtin such as `now` (unless shadowed by a real member).
        if (BuiltinOps.IsNullaryValueOp(name) && !_memberNames.Contains(name)
            && NullaryValueOpsTypeScript.TryGetValue(name, out var ts))
        {
            sb.Append(ts);
            return;
        }

        // Enum member reference -> EnumName.Member (the const member object).
        if (!_memberNames.Contains(name))
        {
            IReadOnlyList<string> owners = _index.EnumsDeclaring(name);
            if (owners.Count > 0)
            {
                var hint = enumHint ?? _expectedEnum;
                var enumType = hint is not null && owners.Contains(hint)
                    ? hint
                    : owners.Count == 1
                        ? owners[0]
                        : _enumMemberToType.TryGetValue(name, out var fallback) ? fallback : owners[0];
                sb.Append(TypeScriptNaming.ToPascalCase(enumType)).Append('.').Append(TypeScriptNaming.ToPascalCase(name));
                return;
            }
        }

        // Member of the enclosing type. A configured receiver (e.g. a read-model projection over
        // `src`) makes every member a property access on it; otherwise `this.<camelCase>` in a body,
        // bare `<camelCase>` in a constructor/invariant (where the member is still the local
        // parameter, not yet a field).
        if (_memberNames.Contains(name))
        {
            if (_memberReceiver is not null)
            {
                sb.Append(_memberReceiver).Append('.').Append(TypeScriptNaming.ToCamelCase(name));
                return;
            }
            if (_mode == NameMode.Property)
            {
                sb.Append("this.");
            }
            sb.Append(TypeScriptNaming.ToCamelCase(name));
            return;
        }

        // An enum *type* reference (the qualifier of `OrderStatus.Draft`): the const member object.
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(TypeScriptNaming.ToPascalCase(name));
            return;
        }

        // Unknown identifier: emit verbatim (best effort).
        sb.Append(TypeScriptNaming.ToCamelCase(name));
    }

    private void WriteMemberAccess(MemberAccessExpr ma, StringBuilder sb)
    {
        // Qualified enum-member access: `OrderStatus.Cancelled` -> the PascalCase const member.
        if (ma.Target is IdentifierExpr qualifier && !_memberNames.Contains(qualifier.Name)
            && !_locals.IsLocal(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(TypeScriptNaming.ToPascalCase(qualifier.Name)).Append('.')
              .Append(TypeScriptNaming.ToPascalCase(ma.MemberName));
            return;
        }

        var target = new StringBuilder();
        Write(ma.Target, target);
        var t = target.ToString();

        // A user type that declares a member named after a built-in member-op (isEmpty/trim/…)
        // shadows the op shortcut — emit a plain property access, exactly mirroring the #605
        // semantic resolution one layer down. Without this, a field named e.g. `isEmpty` would
        // resolve correctly yet still emit `t.length === 0`, which is wrong TypeScript (#672).
        if (_resolver.Infer(ma.Target, EffectiveScope()) is { } receiverType
            && _index.TryGetMemberType(receiverType.Qualifier ?? _resolver.Context, receiverType.Name, ma.MemberName, out _))
        {
            sb.Append(t).Append('.').Append(TypeScriptNaming.ToCamelCase(ma.MemberName));
            return;
        }

        switch (ma.MemberName)
        {
            case "isEmpty":
                // List -> .length; Set/Map -> .size (ReadonlySet/ReadonlyMap have no .length).
                sb.Append(t).Append(IsSizeBacked(ma.Target) ? ".size === 0" : ".length === 0");
                return;
            case "isNotEmpty":
                sb.Append(t).Append(IsSizeBacked(ma.Target) ? ".size !== 0" : ".length !== 0");
                return;
            case "count":
                // List -> .length; Set/Map -> .size.
                sb.Append(t).Append(IsSizeBacked(ma.Target) ? ".size" : ".length");
                return;
            case "length":
                sb.Append(t).Append(".length");
                return;
            case "trim":
                sb.Append(t).Append(".trim()");
                return;
            case "lower":
                sb.Append(t).Append(".toLowerCase()");
                return;
            case "upper":
                sb.Append(t).Append(".toUpperCase()");
                return;
            case "isBlank":
                sb.Append("(").Append(t).Append(".trim().length === 0)");
                return;
            case "isPresent":
                sb.Append(t).Append(" !== undefined");
                return;
            case "isNone":
                sb.Append(t).Append(" === undefined");
                return;
            default:
                sb.Append(t).Append('.').Append(TypeScriptNaming.ToCamelCase(ma.MemberName));
                return;
        }
    }

    /// <summary>True when a collection target is a Set/Map (size-backed) rather than a list/string.</summary>
    private bool IsSizeBacked(Expr target)
    {
        TypeRef? type = _resolver.Infer(target, EffectiveScope());
        return type is not null && _index.Classify(type.Name) is TypeKind.Set or TypeKind.Map;
    }

    private void WriteCall(CallExpr call, StringBuilder sb)
    {
        var target = new StringBuilder();
        Write(call.Target, target);
        var t = target.ToString();

        // A Set maps to ReadonlySet<T>, which has none of the JS Array methods the lambda/aggregate
        // ops below lower to (every/some/map/reduce). Normalize a Set receiver to an array first so
        // those methods exist. The validator restricts these ops (and `contains`) to List/Set — never
        // Map — so a size-backed receiver here is always a Set; `[...set]` spreads its values.
        var sizeBacked = IsSizeBacked(call.Target);
        var iter = sizeBacked ? $"[...{t}]" : t;

        switch (call.Method)
        {
            case "startsWith":
                sb.Append(t).Append(".startsWith(");
                Write(call.Args[0], sb);
                sb.Append(')');
                return;
            case "endsWith":
                sb.Append(t).Append(".endsWith(");
                Write(call.Args[0], sb);
                sb.Append(')');
                return;
            case "contains":
                // String/List membership -> .includes; Set membership -> .has (ReadonlySet has no .includes).
                sb.Append(t).Append(sizeBacked ? ".has(" : ".includes(");
                Write(call.Args[0], sb);
                sb.Append(')');
                return;
            case "all":
                sb.Append(iter).Append(".every(").Append(RenderLambda(call)).Append(')');
                return;
            case "any":
                sb.Append(iter).Append(".some(").Append(RenderLambda(call)).Append(')');
                return;
            case "none":
                sb.Append('!').Append(iter).Append(".some(").Append(RenderLambda(call)).Append(')');
                return;
            case "min":
                WriteMinMax(call, iter, sb, isMin: true);
                return;
            case "max":
                WriteMinMax(call, iter, sb, isMin: false);
                return;
            case "sum":
                WriteSum(call, iter, sb);
                return;
            case "distinctBy":
                WriteDistinctBy(call, iter, sb);
                return;
            default:
                sb.Append("/* unsupported call '").Append(call.Method).Append("' */ undefined");
                return;
        }
    }

    private void WriteSum(CallExpr call, string target, StringBuilder sb)
    {
        TypeRef? selectorType = InferSelectorType(call);
        if (_resolver.IsValueLike(selectorType) || selectorType?.Name == "Decimal")
        {
            // No neutral zero for a value object/Decimal fold: guard emptiness with a clear
            // domain error, then reduce with the runtime additive op.
            var voName = selectorType!.Name;
            var rule = $"cannot sum an empty collection of {voName} (no zero value)";
            var bind = "__sum" + _sumCounter++;
            sb.Append('(').Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(") as readonly ").Append(_typeMapper.Map(selectorType)).Append("[]).length === 0\n")
              .Append("        ? (() => { throw new DomainInvariantViolationError('")
              .Append(voName).Append("', '").Append(rule.Replace("'", "\\'")).Append("'); })()\n")
              .Append("        : ").Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(").reduce((").Append(bind).Append("a, ").Append(bind).Append("b) => ")
              .Append(bind).Append("a.add(").Append(bind).Append("b))");
        }
        else
        {
            sb.Append(target).Append(".map(").Append(RenderLambda(call)).Append(").reduce((a, b) => a + b, 0)");
        }
    }

    /// <summary>
    /// <c>distinctBy</c> — "every projection is distinct", the TS counterpart of C#'s
    /// <c>.Select(selector).Distinct().Count() == .Count</c>. A JS <c>Set</c> dedupes by reference
    /// identity (SameValueZero) and cannot take a custom equality, so for a value-object / branded-Id
    /// / entity / <c>Decimal</c> selector — all emitted as classes carrying an <c>equals</c> method —
    /// two distinct instances that the type considers equal would survive as separate entries and the
    /// invariant would never fire, diverging from C#'s <c>Distinct()</c> (issue #609 for value objects,
    /// #712 for entities). For those selectors we count distinct projections via the runtime
    /// <c>structuralEquals</c>, which delegates to the element's own <c>equals</c> when present — so a
    /// value object compares structurally and an entity compares by id (<c>this.id.equals(other.id)</c>),
    /// each matching its C#/PHP counterpart. (Keeps each value's first occurrence, O(n²) like
    /// <c>structuralEquals</c> is used elsewhere; invariant collections are small.) A primitive selector
    /// (<c>string</c>/<c>number</c>/<c>boolean</c>) already dedupes by value under SameValueZero, so it
    /// keeps the fast Set path.
    /// </summary>
    private void WriteDistinctBy(CallExpr call, string target, StringBuilder sb)
    {
        TypeRef? selectorType = InferSelectorType(call);

        // A value object, branded Id, or entity selector all project to a class with an `equals`
        // method (value-likes structural, entities by id), so all three must dedupe via that method
        // through `structuralEquals` rather than a reference-identity Set. `IsValueLike` covers value
        // objects + Ids; `IsUserType` adds entities; their union (plus Decimal, whose runtime class
        // also exposes `equals`) is the structural set.
        if (_resolver.IsValueLike(selectorType) || _resolver.IsUserType(selectorType) || selectorType?.Name == "Decimal")
        {
            sb.Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(").filter((__x, __i, __xs) => __xs.findIndex((__y) => structuralEquals(__x, __y)) === __i).length === ")
              .Append(target).Append(".length");
        }
        else
        {
            sb.Append("new Set(").Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(")).size === ").Append(target).Append(".length");
        }
    }

    /// <summary>
    /// <c>min</c>/<c>max</c>. Both branches guard an empty collection (issue #610): a numeric (Int)
    /// selector maps to <c>number</c> then folds with a seedless <c>.reduce</c> over <c>Math.min/max</c>
    /// — never a bare <c>Math.min(...spread)</c>, which returns <c>±Infinity</c> on empty (and risks an
    /// arity <c>RangeError</c>); a <c>Decimal</c>/value-object selector would be both type-unsound
    /// (<c>Math.*</c> wants <c>number</c>) and money-lossy, so it reduces via <c>compareTo</c>. Either
    /// way the empty case throws <c>DomainInvariantViolationError</c>, matching the C#/Python targets.
    /// </summary>
    private void WriteMinMax(CallExpr call, string target, StringBuilder sb, bool isMin)
    {
        TypeRef? selectorType = InferSelectorType(call);
        if (_resolver.IsValueLike(selectorType) || selectorType?.Name == "Decimal")
        {
            var voName = selectorType!.Name;
            var op = isMin ? "min" : "max";
            var rule = $"cannot take {op} of an empty collection of {voName} (no value)";
            var cmp = isMin ? "<= 0" : ">= 0";
            var bind = "__mm" + _sumCounter++;
            sb.Append('(').Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(") as readonly ").Append(_typeMapper.Map(selectorType)).Append("[]).length === 0\n")
              .Append("        ? (() => { throw new DomainInvariantViolationError('")
              .Append(voName).Append("', '").Append(rule.Replace("'", "\\'")).Append("'); })()\n")
              .Append("        : ").Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(").reduce((").Append(bind).Append("a, ").Append(bind).Append("b) => ")
              .Append(bind).Append("a.compareTo(").Append(bind).Append("b) ").Append(cmp)
              .Append(" ? ").Append(bind).Append("a : ").Append(bind).Append("b)");
        }
        else
        {
            // Numeric (Int) selector. `Math.min(...[])` returns Infinity and `Math.max(...[])`
            // returns -Infinity, so a bare spread silently yields a nonsense extreme on an empty
            // collection (and risks the argument-arity RangeError on very large arrays). Mirror the
            // value-object branch above: map once, throw DomainInvariantViolationError when empty,
            // else fold with a seedless `.reduce` over Math.min/max — matching C#/Python semantics.
            var op = isMin ? "min" : "max";
            var fn = isMin ? "Math.min" : "Math.max";
            var rule = $"cannot take {op} of an empty collection (no value)";
            var ownerName = selectorType?.Name ?? "number";
            var elem = selectorType is null ? "number" : _typeMapper.Map(selectorType);
            var bind = "__mm" + _sumCounter++;
            sb.Append('(').Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(") as readonly ").Append(elem).Append("[]).length === 0\n")
              .Append("        ? (() => { throw new DomainInvariantViolationError('")
              .Append(ownerName).Append("', '").Append(rule.Replace("'", "\\'")).Append("'); })()\n")
              .Append("        : ").Append(target).Append(".map(").Append(RenderLambda(call))
              .Append(").reduce((").Append(bind).Append("a, ").Append(bind).Append("b) => ")
              .Append(fn).Append('(').Append(bind).Append("a, ").Append(bind).Append("b))");
        }
    }

    private TypeRef? InferSelectorType(CallExpr call)
    {
        TypeScope scope = EffectiveScope();
        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, scope));
        if (element is not null && call.Args is [LambdaExpr lambda])
        {
            return _resolver.Infer(lambda.Body, scope.With(lambda.Parameter, KoineType.From(element, _index)));
        }

        return null;
    }

    private string RenderLambda(CallExpr call)
    {
        if (call.Args is not [LambdaExpr lambda])
        {
            return "/* expected lambda */ () => undefined";
        }

        // Unconditional push/pop: the shadow stack restores whatever the parameter shadowed — an outer
        // `let`/parameter of the same name keeps BOTH its presence and its own type once the lambda
        // closes. The old name-only `wasPresent` guard preserved the name but left the parameter's
        // element type overwriting the outer binding's (#1497).
        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        PushLocal(lambda.Parameter, element);
        var body = new StringBuilder();
        Write(lambda.Body, body);
        PopLocal(lambda.Parameter);

        return $"({TypeScriptNaming.ToCamelCase(lambda.Parameter)}) => {body}";
    }

    private static void WriteLiteral(LiteralExpr lit, StringBuilder sb)
    {
        switch (lit.Kind)
        {
            case LiteralKind.Int:
            case LiteralKind.Bool:
                sb.Append(lit.Text);
                break;
            case LiteralKind.Decimal:
                // A Decimal literal is constructed from its exact textual form.
                sb.Append("new Decimal('").Append(lit.Text).Append("')");
                break;
            case LiteralKind.String:
                sb.Append('\'').Append(EscapeString(lit.Text)).Append('\'');
                break;
        }
    }

    private static string EscapeString(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '\'':
                    sb.Append("\\'");
                    break;
                case '\n':
                    sb.Append("\\n");
                    break;
                case '\r':
                    sb.Append("\\r");
                    break;
                case '\t':
                    sb.Append("\\t");
                    break;
                default:
                    sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    private static bool TryBoolLiterals(ConditionalExpr c, out bool whenTrue)
    {
        whenTrue = false;
        if (c.Then is LiteralExpr { Kind: LiteralKind.Bool } t
            && c.Else is LiteralExpr { Kind: LiteralKind.Bool } e
            && t.Text != e.Text)
        {
            whenTrue = t.Text == "true";
            return true;
        }
        return false;
    }

    private static string OperatorOf(BinaryOp op) => op switch
    {
        BinaryOp.Or => "||",
        BinaryOp.And => "&&",
        BinaryOp.Eq => "===",
        BinaryOp.Neq => "!==",
        BinaryOp.Lt => "<",
        BinaryOp.Le => "<=",
        BinaryOp.Gt => ">",
        BinaryOp.Ge => ">=",
        BinaryOp.Add => "+",
        BinaryOp.Sub => "-",
        BinaryOp.Mul => "*",
        BinaryOp.Div => "/",
        _ => "?"
    };
}
