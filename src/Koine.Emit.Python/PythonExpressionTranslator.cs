using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Translates the target-agnostic <see cref="Expr"/> sublanguage into Python expression source,
/// the Python counterpart of <see cref="CSharp.CSharpExpressionTranslator"/> and
/// <see cref="TypeScript.TypeScriptExpressionTranslator"/>.
/// <para>
/// Unlike the TypeScript translator — which lowers Decimal/value-object arithmetic and comparison
/// to runtime method calls (<c>.add</c>/<c>.compareTo</c>) because a string-backed JS Decimal can't
/// use native operators — Python uses NATIVE operators throughout: <c>decimal.Decimal</c> and the
/// emitted frozen-dataclass value objects support <c>+ - * / &lt; &lt;= == &gt;= …</c> directly.
/// So arithmetic and comparison render as the obvious infix Python.
/// </para>
/// <para>
/// Member identifiers render as <c>self.&lt;snake&gt;</c> in <see cref="NameMode.Property"/>
/// (instance bodies: getters, computed properties, commands) or bare <c>&lt;snake&gt;</c> in
/// <see cref="NameMode.Parameter"/> (constructor/invariant context, where the member is still the
/// incoming parameter, not yet a field). Enum members render as <c>EnumName.UPPER_SNAKE</c>.
/// Decimal-safe folds (<c>sum</c>/<c>min</c>/<c>max</c>) route through the runtime helpers
/// (<c>koine_sum</c>/<c>koine_min</c>/<c>koine_max</c>), which empty-guard and stay Decimal-safe.
/// Regex <c>matches</c> lowers to <c>re.search</c> (unanchored, mirroring the TS <c>.test</c>);
/// <c>let…in</c> lowers to nested IIFE lambdas. All emitted member/param/local identifiers are run
/// through <see cref="PythonNaming.EscapeIdentifier"/> so a member like <c>type</c> becomes
/// <c>type_</c>.
/// </para>
/// </summary>
internal sealed class PythonExpressionTranslator
{
    /// <summary>How a member identifier should be rendered.</summary>
    public enum NameMode
    {
        /// <summary>Constructor/invariant context: a member renders as its bare parameter (snake_case).</summary>
        Parameter,
        /// <summary>Instance-body context (getters, commands): a member renders as <c>self.&lt;snake&gt;</c>.</summary>
        Property
    }

    private NameMode _mode = NameMode.Property;

    /// <summary>Python rendering for each nullary value builtin (e.g. <c>now</c> -&gt; <c>Instant.now()</c>).</summary>
    private static readonly IReadOnlyDictionary<string, string> NullaryValueOpsPython =
        new Dictionary<string, string>(StringComparer.Ordinal) { ["now"] = "Instant.now()" };

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly TypeScope _scope;
    private readonly ISet<string> _memberNames;
    private readonly IReadOnlyDictionary<string, string> _enumMemberToType;

    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);

    // The enum type the whole expression is expected to produce; qualifies a bare shared
    // enum member where a comparison hint does not reach.
    private string? _expectedEnum;

    // The receiver a `NameMode.Property` member renders against — `self` inside an entity body,
    // or a supplied parameter name (e.g. `src`) for a read-model projection rooted at the source.
    private readonly string _memberReceiver;

    // The neutral RegexMatchTimeoutMs author intent (#794/#812). null ⇒ stdlib `re.search` (today,
    // unbounded — CPython's `re` has no per-call timeout); set ⇒ the third-party `regex` module's
    // `regex.search(..., timeout=<ms/1000>)`, the one Python path that can honor a per-call bound.
    private readonly int? _regexMatchTimeoutMs;

    public PythonExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        // Accepted for constructor parity with the TypeScript/Rust expression translators (whose
        // type-driven lowering needs it); the Python translator uses native operators, so it does
        // not retain the mapper.
        PythonTypeMapper typeMapper,
        string? context = null,
        string memberReceiver = "self",
        int? regexMatchTimeoutMs = null)
    {
        _ = typeMapper;
        _index = index;
        _resolver = new TypeResolver(index, context);
        _scope = TypeScope.FromMembers(members, index);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType;
        _memberReceiver = memberReceiver;
        _regexMatchTimeoutMs = regexMatchTimeoutMs;
    }

    public void PushLocal(string name, TypeRef? type = null)
    {
        _locals.Add(name);
        if (type is not null)
        {
            _localTypes[name] = type;
        }
    }

    public void PopLocal(string name)
    {
        _locals.Remove(name);
        _localTypes.Remove(name);
    }

    private TypeScope EffectiveScope()
    {
        TypeScope scope = _scope;
        foreach (KeyValuePair<string, TypeRef> kv in _localTypes)
        {
            scope = scope.WithRef(kv.Key, kv.Value, _index);
        }

        return scope;
    }

    /// <summary>Translates an expression to a Python expression string (members render as <c>self.x</c>).</summary>
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
    /// assertion's failure is tested. Mirrors the sibling translators: peel a leading <c>not</c>,
    /// flip a top-level comparison, simplify a bool-literal ternary, else wrap once in
    /// <c>not (...)</c>. Python value-object/Decimal comparisons CAN be flipped with a plain
    /// operator (they support native <c>&lt;</c>/<c>==</c>), so no special value-comparison case
    /// is needed here.
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
            case BinaryExpr bin when Flip(bin.Op) is { } flipped:
                WriteOperand(bin.Left, sb, EnumTypeName(bin.Right));
                sb.Append(' ').Append(flipped).Append(' ');
                WriteOperand(bin.Right, sb, EnumTypeName(bin.Left));
                break;
            case ConditionalExpr c when TryBoolLiterals(c, out var whenTrue):
                if (whenTrue)
                {
                    sb.Append("not (");
                    Write(c.Condition, sb);
                    sb.Append(')');
                }
                else
                {
                    Write(c.Condition, sb);
                }
                break;
            default:
                sb.Append("not (");
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
        BinaryOp.Eq => "!=",
        BinaryOp.Neq => "==",
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
                WriteUnary(un, sb);
                break;
            case ConditionalExpr cond when TryBoolLiterals(cond, out var whenTrue):
                if (whenTrue)
                {
                    Write(cond.Condition, sb);
                }
                else
                {
                    sb.Append("not (");
                    Write(cond.Condition, sb);
                    sb.Append(')');
                }
                break;
            case ConditionalExpr cond:
                // Python conditional expression: `(<then> if <cond> else <else>)`.
                sb.Append('(');
                WriteReconciledBranch(cond.Then, cond.Else, sb);
                sb.Append(" if ");
                Write(cond.Condition, sb);
                sb.Append(" else ");
                WriteReconciledBranch(cond.Else, cond.Then, sb);
                sb.Append(')');
                break;
            case CoalesceExpr co:
                // `l ?? r` -> `(<l> if <l> is not None else <r>)`. The left side is written twice;
                // it is a pure expression in this sublanguage so duplication is safe.
                sb.Append('(');
                Write(co.Left, sb);
                sb.Append(" if ");
                Write(co.Left, sb);
                sb.Append(" is not None else ");
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
                // `raw matches /pat/` -> `(re.search(r"pat", raw) is not None)`. Unanchored search,
                // the same semantics as the other targets. The per-file header (Task 5) imports `re`.
                // ReDoS note (#641): CPython's stdlib `re` has NO per-call match timeout, so the default
                // form is unbounded. When the neutral RegexMatchTimeoutMs key is set (#794/#812) we instead
                // lower to the third-party `regex` module's `regex.search(..., timeout=<ms/1000>)` — the one
                // Python path that honors a per-call bound (the import header adds `import regex`). The key
                // is opt-in, so users who never set it take on no new dependency.
                if (_regexMatchTimeoutMs is { } ms)
                {
                    sb.Append("(regex.search(").Append(RawRegexLiteral(m.Pattern)).Append(", ");
                    Write(m.Target, sb);
                    sb.Append(", timeout=").Append(FormatTimeoutSeconds(ms)).Append(") is not None)");
                }
                else
                {
                    sb.Append("(re.search(").Append(RawRegexLiteral(m.Pattern)).Append(", ");
                    Write(m.Target, sb);
                    sb.Append(") is not None)");
                }

                break;
            case GuardExpr g:
                // The `when` condition is applied at the invariant/emit level; emit the body only.
                Write(g.Body, sb);
                break;
            case LetExpr let:
                WriteLet(let, sb);
                break;
            default:
                sb.Append("None  # unsupported expression");
                break;
        }
    }

    /// <summary>
    /// Writes one <c>ConditionalExpr</c> branch, individually widened to <c>Decimal</c> when its own
    /// inferred type is a non-optional <c>Int</c> while the SIBLING branch is <c>Decimal</c>
    /// (<c>Decimal(...)</c>), or null-check-widened when its own inferred type is an OPTIONAL <c>Int</c>
    /// while the SIBLING branch is <c>Decimal</c> (<c>(Decimal(__koine_v) if (__koine_v := x) is not None
    /// else None)</c> — Python has no <c>Option.map</c>, so the widen is an inline conditional expression
    /// that passes <c>None</c> through and widens the present value, bound via a walrus so <c>x</c> is
    /// evaluated exactly once and <c>mypy --strict</c> can narrow it — narrowing only works on a simple
    /// name/attribute chain, not a duplicated arbitrary sub-expression, so a compound branch like a nested
    /// conditional needs the binding regardless of the single-evaluation win). <see cref="TypeResolver"/>
    /// already widens the conditional's
    /// own aggregate type to the wider/optional-joined type of the two branches (#975), so an unreconciled
    /// pair emits two disagreeing types in the same ternary — a real <c>mypy --strict</c> "Incompatible
    /// return value type" (issue #1344; the numeric-only case, the optional-numeric case, and both at
    /// once). Reconciling per-branch (rather than a single wrap around the whole conditional) is required
    /// because the branches disagree with EACH OTHER, not with an externally supplied target type. Fixed
    /// here in the emitter (not the semantic validator): a widened or optional-joined conditional is a
    /// legitimate, cross-target-sanctioned pattern (#975) — this is a Python-only rendering gap, not a
    /// modeling error.
    /// <para>
    /// Unlike the Rust/Java siblings, Python has NO analogue of <c>Some(...)</c>/<c>Optional.of(...)</c>
    /// wrapping: a Koine optional type maps to a plain PEP&#160;604 union with <c>None</c>
    /// (<c>T | None</c>), and a bare, non-optional <c>T</c> value is already structurally assignable
    /// wherever <c>T | None</c> is expected — verified under <c>mypy --strict</c> — so a non-optional
    /// branch against an optional sibling needs no rendering change at all (mirrors the TypeScript/Kotlin
    /// conclusion for their own structural-union optional shapes).
    /// </para>
    /// <c>needsWiden</c> and <c>needsOptionalWiden</c> are mutually exclusive (they key off the same
    /// branch's own optionality).
    /// </summary>
    private void WriteReconciledBranch(Expr branch, Expr sibling, StringBuilder sb)
    {
        TypeScope scope = EffectiveScope();
        TypeRef? branchType = _resolver.Infer(branch, scope);
        TypeRef? siblingType = _resolver.Infer(sibling, scope);
        var needsWiden = branchType is { Name: "Int", IsOptional: false } && siblingType?.Name == "Decimal";
        var needsOptionalWiden = branchType is { Name: "Int", IsOptional: true } && siblingType?.Name == "Decimal";

        if (needsWiden)
        {
            sb.Append("Decimal(");
            Write(branch, sb);
            sb.Append(')');
            return;
        }

        if (needsOptionalWiden)
        {
            // A walrus binding (not a duplicated `<branch>`, unlike the CoalesceExpr lowering above) —
            // `is not None` can only type-narrow a simple name/attribute chain under `mypy --strict`, not
            // an arbitrary re-occurring sub-expression, so a compound branch (e.g. a nested conditional)
            // needs a name to narrow on regardless of the double-evaluation cost.
            sb.Append("(Decimal(__koine_v) if (__koine_v := ");
            Write(branch, sb);
            sb.Append(") is not None else None)");
            return;
        }

        Write(branch, sb);
    }

    private void WriteUnary(UnaryExpr un, StringBuilder sb)
    {
        if (un.Op == UnaryOp.Not)
        {
            // `not (operand)` — always parenthesize for safe precedence.
            sb.Append("not (");
            Write(un.Operand, sb);
            sb.Append(')');
            return;
        }

        // Negate: `-operand`; parenthesize a compound operand for safe precedence.
        sb.Append('-');
        if (un.Operand is IdentifierExpr or LiteralExpr or MemberAccessExpr or CallExpr)
        {
            Write(un.Operand, sb);
        }
        else
        {
            sb.Append('(');
            Write(un.Operand, sb);
            sb.Append(')');
        }
    }

    private void WriteBinary(BinaryExpr bin, StringBuilder sb, bool parenthesize)
    {
        // Python uses native operators for arithmetic AND comparison: decimal.Decimal and the
        // emitted frozen-dataclass value objects support `+ - * / < <= == >= …` directly, so there
        // is no `.add`/`.compareTo` lowering (the TypeScript translator needs that; Python does not).
        if (parenthesize)
        {
            sb.Append('(');
        }

        WriteOperand(bin.Left, sb, EnumTypeName(bin.Right));
        sb.Append(' ').Append(BinaryOperatorFor(bin)).Append(' ');
        WriteOperand(bin.Right, sb, EnumTypeName(bin.Left));

        if (parenthesize)
        {
            sb.Append(')');
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
        // `let x = e1, y = e2 in body` -> nested IIFE lambdas:
        //   (lambda x: (lambda y: <body>)(<e2>))(<e1>)
        // Each binding name is pushed into locals (so body / later bindings resolve it as a bare
        // local) and popped after. mypy infers each lambda's parameter type from its call argument.
        var pushed = new List<string>();
        var argValues = new List<Expr>();

        foreach (LetBinding b in let.Bindings)
        {
            sb.Append("(lambda ").Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(b.Name))).Append(": ");
            // The binding's value is evaluated in the scope BEFORE this binding is in scope, so
            // capture it (and the binding's type) now, then push the local for the remainder.
            argValues.Add(b.Value);
            PushLocal(b.Name, _resolver.Infer(b.Value, EffectiveScope()));
            pushed.Add(b.Name);
        }

        Write(let.Body, sb);

        // Close each lambda and apply it to its argument, innermost (last binding) first.
        for (var i = let.Bindings.Count - 1; i >= 0; i--)
        {
            sb.Append(")(");
            Write(argValues[i], sb);
            sb.Append(')');
        }

        for (var i = pushed.Count - 1; i >= 0; i--)
        {
            PopLocal(pushed[i]);
        }
    }

    private void WriteIdentifier(string name, StringBuilder sb, string? enumHint = null)
    {
        // (1) Local (lambda/command/factory parameter, let binding): verbatim snake_case.
        if (_locals.Contains(name))
        {
            sb.Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(name)));
            return;
        }

        // (2) Nullary value builtin such as `now` (unless shadowed by a real member).
        if (BuiltinOps.IsNullaryValueOp(name) && !_memberNames.Contains(name)
            && NullaryValueOpsPython.TryGetValue(name, out var py))
        {
            sb.Append(py);
            return;
        }

        // (3) Enum member reference -> EnumName.UPPER_SNAKE (the enum member).
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
                sb.Append(PythonNaming.ToPascalCase(enumType)).Append('.').Append(PythonNaming.ToUpperSnake(name));
                return;
            }
        }

        // (4) Member of the enclosing type: `self.<snake>` in a body, bare `<snake>` in a
        // constructor/invariant (where the member is still the local parameter, not yet a field).
        if (_memberNames.Contains(name))
        {
            if (_mode == NameMode.Property)
            {
                sb.Append(_memberReceiver).Append('.');
            }
            sb.Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(name)));
            return;
        }

        // (5) An enum *type* reference (the qualifier of `OrderStatus.Draft`): the PascalCase class.
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(PythonNaming.ToPascalCase(name));
            return;
        }

        // (6) Unknown identifier: emit verbatim snake (best effort).
        sb.Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(name)));
    }

    private void WriteMemberAccess(MemberAccessExpr ma, StringBuilder sb)
    {
        // Qualified enum-member access: `OrderStatus.Cancelled` -> `OrderStatus.CANCELLED`.
        if (ma.Target is IdentifierExpr qualifier && !_memberNames.Contains(qualifier.Name)
            && !_locals.Contains(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(PythonNaming.ToPascalCase(qualifier.Name)).Append('.')
              .Append(PythonNaming.ToUpperSnake(ma.MemberName));
            return;
        }

        var target = new StringBuilder();
        Write(ma.Target, target);
        var t = target.ToString();

        // A user type that declares a member named after a built-in member-op (isEmpty/trim/…)
        // shadows the op shortcut — emit a plain attribute access, exactly mirroring the #605
        // semantic resolution one layer down. Without this, a field named e.g. `isEmpty` would
        // resolve correctly yet still emit `len(t) == 0`, which is wrong Python (#672).
        if (_resolver.Infer(ma.Target, EffectiveScope()) is { } receiverType
            && _index.TryGetMemberType(receiverType.Qualifier ?? _resolver.Context, receiverType.Name, ma.MemberName, out _))
        {
            sb.Append(t).Append('.')
              .Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(ma.MemberName)));
            return;
        }

        switch (ma.MemberName)
        {
            case "isEmpty":
                sb.Append("len(").Append(t).Append(") == 0");
                return;
            case "isNotEmpty":
                sb.Append("len(").Append(t).Append(") != 0");
                return;
            case "count":
            case "length":
                // String/list/set/map length all use len(...) in Python.
                sb.Append("len(").Append(t).Append(')');
                return;
            case "trim":
                sb.Append(t).Append(".strip()");
                return;
            case "lower":
                sb.Append(t).Append(".lower()");
                return;
            case "upper":
                sb.Append(t).Append(".upper()");
                return;
            case "isBlank":
                sb.Append("(not ").Append(t).Append(" or ").Append(t).Append(".isspace())");
                return;
            case "isPresent":
                sb.Append(t).Append(" is not None");
                return;
            case "isNone":
            case "isAbsent":
                sb.Append(t).Append(" is None");
                return;
            default:
                sb.Append(t).Append('.').Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(ma.MemberName)));
                return;
        }
    }

    private void WriteCall(CallExpr call, StringBuilder sb)
    {
        var target = new StringBuilder();
        Write(call.Target, target);
        var t = target.ToString();

        switch (call.Method)
        {
            case "startsWith":
                sb.Append(t).Append(".startswith(");
                Write(call.Args[0], sb);
                sb.Append(')');
                return;
            case "endsWith":
                sb.Append(t).Append(".endswith(");
                Write(call.Args[0], sb);
                sb.Append(')');
                return;
            case "contains":
                // String membership and collection membership both use the `in` operator.
                sb.Append('(');
                Write(call.Args[0], sb);
                sb.Append(" in ").Append(t).Append(')');
                return;
            case "all":
                sb.Append("all(").Append(RenderComprehension(call, t)).Append(')');
                return;
            case "any":
                sb.Append("any(").Append(RenderComprehension(call, t)).Append(')');
                return;
            case "none":
                sb.Append("not any(").Append(RenderComprehension(call, t)).Append(')');
                return;
            case "min":
                sb.Append("koine_min(").Append(RenderComprehension(call, t)).Append(')');
                return;
            case "max":
                sb.Append("koine_max(").Append(RenderComprehension(call, t)).Append(')');
                return;
            case "sum":
                WriteSum(call, t, sb);
                return;
            case "distinctBy":
                sb.Append("len({").Append(RenderComprehension(call, t)).Append("}) == len(").Append(t).Append(')');
                return;
            default:
                sb.Append("None  # unsupported call '").Append(call.Method).Append('\'');
                return;
        }
    }

    /// <summary>
    /// Lowers a <c>.sum(p =&gt; body)</c> call.
    /// <para>
    /// When the projected element type is a bare <c>Int</c>, Python's builtin <c>sum(...)</c>
    /// is used — it defaults to <c>start=0</c>, so an empty collection returns <c>0</c>,
    /// exactly matching the C# and TypeScript emitters' behaviour.
    /// </para>
    /// <para>
    /// For <c>Decimal</c> or value-object projections there is no domain zero, so the runtime
    /// helper <c>koine_sum</c> is kept — it raises <c>DomainInvariantViolationError</c> on an
    /// empty collection, mirroring the C#/TS seedless-fold behaviour.
    /// </para>
    /// </summary>
    private void WriteSum(CallExpr call, string target, StringBuilder sb)
    {
        TypeRef? selectorType = InferSelectorType(call);
        if (selectorType?.Name == "Int")
        {
            // Bare numeric Int: builtin sum(...) defaults start=0, so empty → 0.
            sb.Append("sum(").Append(RenderComprehension(call, target)).Append(')');
        }
        else
        {
            // Decimal or value-object: no zero value — guard emptiness via koine_sum.
            sb.Append("koine_sum(").Append(RenderComprehension(call, target)).Append(')');
        }
    }

    /// <summary>
    /// Infers the type produced by the lambda body inside a <c>sum</c>/<c>min</c>/<c>max</c>
    /// call (i.e., the type of each element after applying the selector projection). Mirrors
    /// the identical method in <see cref="TypeScript.TypeScriptExpressionTranslator"/>.
    /// </summary>
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

    /// <summary>
    /// Renders the generator-expression body of a collection operation:
    /// <c>&lt;lambda-body&gt; for &lt;param&gt; in &lt;target&gt;</c>. The lambda parameter is
    /// pushed as a local (typed to the receiver's element type) while its body is written.
    /// </summary>
    private string RenderComprehension(CallExpr call, string target)
    {
        if (call.Args is not [LambdaExpr lambda])
        {
            return "None  # expected lambda";
        }

        var wasPresent = _locals.Contains(lambda.Parameter);
        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        PushLocal(lambda.Parameter, element);
        var body = new StringBuilder();
        Write(lambda.Body, body);
        if (!wasPresent)
        {
            PopLocal(lambda.Parameter);
        }

        var param = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(lambda.Parameter));
        return $"{body} for {param} in {target}";
    }

    private static void WriteLiteral(LiteralExpr lit, StringBuilder sb)
    {
        switch (lit.Kind)
        {
            case LiteralKind.Int:
                sb.Append(lit.Text);
                break;
            case LiteralKind.Bool:
                // Koine `true`/`false` -> Python `True`/`False`.
                sb.Append(lit.Text == "true" ? "True" : "False");
                break;
            case LiteralKind.Decimal:
                // A Decimal literal is constructed from its exact textual form (money-safe, never float).
                sb.Append("Decimal(\"").Append(lit.Text).Append("\")");
                break;
            case LiteralKind.String:
                sb.Append('"').Append(EscapeString(lit.Text)).Append('"');
                break;
        }
    }

    /// <summary>
    /// Renders a regex pattern as a Python raw-string literal <c>r"…"</c>. A raw string can't end in
    /// an odd run of backslashes and can't contain an unescaped <c>"</c>, so when the pattern would
    /// break a raw literal we fall back to a regular double-quoted string with doubled backslashes.
    /// </summary>
    private static string RawRegexLiteral(string pattern)
    {
        var safeAsRaw = !pattern.Contains('"') && !EndsWithOddBackslashes(pattern);
        if (safeAsRaw)
        {
            return "r\"" + pattern + "\"";
        }

        var sb = new StringBuilder(pattern.Length + 3);
        sb.Append('"');
        foreach (var c in pattern)
        {
            switch (c)
            {
                case '\\':
                    sb.Append("\\\\");
                    break;
                case '"':
                    sb.Append("\\\"");
                    break;
                default:
                    sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }

    private static bool EndsWithOddBackslashes(string s)
    {
        var count = 0;
        for (var i = s.Length - 1; i >= 0 && s[i] == '\\'; i--)
        {
            count++;
        }
        return count % 2 == 1;
    }

    /// <summary>
    /// Renders a millisecond match-timeout budget as the seconds-float literal the <c>regex</c> module's
    /// <c>timeout=</c> keyword expects (e.g. <c>250 → "0.25"</c>, <c>1000 → "1"</c>, <c>1500 → "1.5"</c>).
    /// The division is exact <see cref="decimal"/> arithmetic (ms is a small integer, 1000 a power of ten)
    /// rendered with the invariant culture, so there is no lossy float truncation and the output is
    /// deterministic across machines.
    /// </summary>
    private static string FormatTimeoutSeconds(int milliseconds) =>
        (milliseconds / 1000m).ToString(System.Globalization.CultureInfo.InvariantCulture);

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
                case '"':
                    sb.Append("\\\"");
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

    // Pick the Python operator for a binary expression. Almost all ops are a pure `BinaryOp -> string`
    // map (OperatorOf), but division needs the operand TYPES: Koine types `Int / Int` as `Int`
    // (matching C# integer division), yet Python `/` is *true* division and yields a float. So when
    // both operands resolve to `Int`, lower to floor division (`//`) — keeping the result int-typed
    // and int-valued (and `mypy --strict`-clean). Decimal/value-object operands keep `/` (the correct
    // `decimal.Decimal` true division). This is the one place with both the operator and the operand
    // type context in scope, so the lowering lives here rather than in the type-blind OperatorOf. (#611)
    private string BinaryOperatorFor(BinaryExpr bin)
    {
        if (bin.Op == BinaryOp.Div)
        {
            TypeScope scope = EffectiveScope();
            if (_resolver.Infer(bin.Left, scope) is { Name: "Int" }
                && _resolver.Infer(bin.Right, scope) is { Name: "Int" })
            {
                return "//";
            }
        }
        return OperatorOf(bin.Op);
    }

    private static string OperatorOf(BinaryOp op) => op switch
    {
        BinaryOp.Or => "or",
        BinaryOp.And => "and",
        BinaryOp.Eq => "==",
        BinaryOp.Neq => "!=",
        BinaryOp.Lt => "<",
        BinaryOp.Le => "<=",
        BinaryOp.Gt => ">",
        BinaryOp.Ge => ">=",
        BinaryOp.Add => "+",
        BinaryOp.Sub => "-",
        BinaryOp.Mul => "*",
        // `Int / Int` floor-divides — see BinaryOperatorFor, which lowers it to `//` before this map
        // is reached; Div here is the true-division fall-through for Decimal/value-object operands.
        BinaryOp.Div => "/",
        _ => "?"
    };
}
