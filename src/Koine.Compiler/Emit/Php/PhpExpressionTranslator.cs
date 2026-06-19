using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// Translates the target-agnostic <see cref="Expr"/> sublanguage into PHP 8.1+ expression source,
/// the PHP counterpart of <see cref="Python.PythonExpressionTranslator"/> and
/// <see cref="TypeScript.TypeScriptExpressionTranslator"/>.
/// <para>
/// PHP uses NATIVE operators throughout: <c>&amp;&amp;</c>, <c>||</c>, <c>!</c>,
/// <c>===</c>/<c>!==</c> for equality, <c>&lt;</c>/<c>&lt;=</c>/<c>&gt;</c>/<c>&gt;=</c>
/// for ordering, and standard arithmetic operators. Decimal literals construct via the runtime
/// <c>\Koine\Runtime\Decimal</c> class (never a float literal).
/// </para>
/// <para>
/// Member identifiers render as <c>$this-&gt;camelProp</c> in <see cref="NameMode.Property"/>
/// (instance bodies: getters, computed properties, commands) or <c>$camelParam</c> in
/// <see cref="NameMode.Parameter"/> (constructor/invariant context). Enum members render as
/// <c>EnumName::UPPER_SNAKE</c>. Collection reductions use PHP's <c>array_reduce</c> /
/// <c>array_sum</c> / runtime <c>\Koine\Runtime\Decimal::sum</c> as appropriate.
/// Regex <c>matches</c> lowers to <c>preg_match</c>; <c>let…in</c> lowers to nested immediately-
/// invoked closures (<c>fn($x) =&gt; …</c>). All emitted member/param/local identifiers are run
/// through <see cref="PhpNaming.EscapeIdentifier"/> so reserved words get a trailing <c>_</c>.
/// </para>
/// </summary>
internal sealed class PhpExpressionTranslator
{
    /// <summary>How a member identifier should be rendered.</summary>
    public enum NameMode
    {
        /// <summary>Constructor/invariant context: a member renders as <c>$camelParam</c>.</summary>
        Parameter,
        /// <summary>Instance-body context (getters, commands): a member renders as <c>$this-&gt;camelProp</c>.</summary>
        Property
    }

    private NameMode _mode = NameMode.Property;

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly PhpTypeMapper _typeMapper;
    private readonly TypeScope _scope;
    private readonly ISet<string> _memberNames;
    private readonly IReadOnlyDictionary<string, string> _enumMemberToType;

    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);

    // The enum type the whole expression is expected to produce; qualifies a bare shared
    // enum member where a comparison hint does not reach.
    private string? _expectedEnum;

    public PhpExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        PhpTypeMapper typeMapper,
        string? context = null)
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _typeMapper = typeMapper;
        _scope = TypeScope.FromMembers(members, index);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType;
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

    /// <summary>Translates an expression to a PHP expression string (members render as <c>$this-&gt;x</c>).</summary>
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
    /// assertion's failure is tested. Peels a leading <c>!</c>, flips a top-level comparison,
    /// simplifies a bool-literal ternary, else wraps once in <c>!(...)</c>.
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
                WriteUnary(un, sb);
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
                // PHP ternary: `(cond ? then : else)`.
                sb.Append('(');
                Write(cond.Condition, sb);
                sb.Append(" ? ");
                Write(cond.Then, sb);
                sb.Append(" : ");
                Write(cond.Else, sb);
                sb.Append(')');
                break;
            case CoalesceExpr co:
                // PHP null-coalescing operator: `($l ?? $r)`.
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
                // `raw matches /pat/` -> `(bool)preg_match('/pat/', $raw)`.
                sb.Append("(bool)preg_match('/").Append(EscapeRegex(m.Pattern)).Append("/', ");
                Write(m.Target, sb);
                sb.Append(')');
                break;
            case GuardExpr g:
                // The `when` condition is applied at the invariant/emit level; emit the body only.
                Write(g.Body, sb);
                break;
            case LetExpr let:
                WriteLet(let, sb);
                break;
            default:
                sb.Append("null /* unsupported expression */");
                break;
        }
    }

    private void WriteUnary(UnaryExpr un, StringBuilder sb)
    {
        if (un.Op == UnaryOp.Not)
        {
            // `!(operand)` — always parenthesize for safe precedence.
            sb.Append("!(");
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
        if (parenthesize)
        {
            sb.Append('(');
        }

        WriteOperand(bin.Left, sb, EnumTypeName(bin.Right));
        sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
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
        // `let x = e1, y = e2 in body` -> nested immediately-invoked closures:
        //   (fn($x) => (fn($y) => <body>)(e2))(e1)
        var pushed = new List<string>();
        var argValues = new List<Expr>();

        foreach (LetBinding b in let.Bindings)
        {
            var camel = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(b.Name));
            sb.Append("(fn($").Append(camel).Append(") => ");
            argValues.Add(b.Value);
            PushLocal(b.Name, _resolver.Infer(b.Value, EffectiveScope()));
            pushed.Add(b.Name);
        }

        Write(let.Body, sb);

        // Close each closure and apply it to its argument, innermost (last binding) first.
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
        // (1) Local (lambda/command/factory parameter, let binding): $camelCase.
        if (_locals.Contains(name))
        {
            sb.Append('$').Append(PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(name)));
            return;
        }

        // (2) Enum member reference -> EnumName::UPPER_SNAKE.
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
                sb.Append(PhpNaming.ClassName(enumType)).Append("::").Append(PhpNaming.ConstName(name));
                return;
            }
        }

        // (3) Member of the enclosing type: `$this->camel` in a body, `$camel` in a
        // constructor/invariant (where the member is still the local parameter, not yet a field).
        if (_memberNames.Contains(name))
        {
            var camel = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(name));
            if (_mode == NameMode.Property)
            {
                sb.Append("$this->").Append(camel);
            }
            else
            {
                sb.Append('$').Append(camel);
            }
            return;
        }

        // (4) An enum *type* reference (the qualifier of `OrderStatus.Draft`): the PascalCase class.
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(PhpNaming.ClassName(name));
            return;
        }

        // (5) Unknown identifier: emit as $camelCase (best effort).
        sb.Append('$').Append(PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(name)));
    }

    private void WriteMemberAccess(MemberAccessExpr ma, StringBuilder sb)
    {
        // Qualified enum-member access: `OrderStatus::Cancelled` -> `OrderStatus::CANCELLED`.
        if (ma.Target is IdentifierExpr qualifier && !_memberNames.Contains(qualifier.Name)
            && !_locals.Contains(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(PhpNaming.ClassName(qualifier.Name)).Append("::")
              .Append(PhpNaming.ConstName(ma.MemberName));
            return;
        }

        var target = new StringBuilder();
        Write(ma.Target, target);
        var t = target.ToString();

        // Determine whether the target is a String type (to pick strlen vs count).
        TypeRef? targetType = _resolver.Infer(ma.Target, EffectiveScope());
        bool isString = targetType?.Name == "String";

        switch (ma.MemberName)
        {
            case "isEmpty":
                sb.Append("count(").Append(t).Append(") === 0");
                return;
            case "isNotEmpty":
                sb.Append("count(").Append(t).Append(") !== 0");
                return;
            case "count":
                sb.Append("count(").Append(t).Append(')');
                return;
            case "length":
                // String length uses strlen(); array/collection uses count().
                if (isString)
                {
                    sb.Append("strlen(").Append(t).Append(')');
                }
                else
                {
                    sb.Append("count(").Append(t).Append(')');
                }
                return;
            case "trim":
                sb.Append("trim(").Append(t).Append(')');
                return;
            case "lower":
                sb.Append("strtolower(").Append(t).Append(')');
                return;
            case "upper":
                sb.Append("strtoupper(").Append(t).Append(')');
                return;
            case "isBlank":
                // Empty string or whitespace-only.
                sb.Append("(trim(").Append(t).Append(") === '')");
                return;
            case "isPresent":
                sb.Append(t).Append(" !== null");
                return;
            case "isNone":
            case "isAbsent":
                sb.Append(t).Append(" === null");
                return;
            default:
                // Fallthrough: `$target->camelMember` — treat as a PHP object property.
                var member = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(ma.MemberName));
                // If target is a local/var, use -> ; if it's already a $this-> or function call, -> as well.
                sb.Append(t).Append("->").Append(member);
                return;
        }
    }

    private void WriteCall(CallExpr call, StringBuilder sb)
    {
        var target = new StringBuilder();
        Write(call.Target, target);
        var t = target.ToString();

        // Determine if the target is a string type (to pick str_contains vs in_array).
        TypeRef? targetType = _resolver.Infer(call.Target, EffectiveScope());
        bool isStringTarget = targetType?.Name == "String";

        switch (call.Method)
        {
            case "startsWith":
                sb.Append("str_starts_with(").Append(t).Append(", ");
                Write(call.Args[0], sb);
                sb.Append(')');
                return;
            case "endsWith":
                sb.Append("str_ends_with(").Append(t).Append(", ");
                Write(call.Args[0], sb);
                sb.Append(')');
                return;
            case "contains":
                if (isStringTarget)
                {
                    // String membership: str_contains($str, $needle).
                    sb.Append("str_contains(").Append(t).Append(", ");
                    Write(call.Args[0], sb);
                    sb.Append(')');
                }
                else
                {
                    // Collection membership: in_array($needle, $arr, true) — strict.
                    sb.Append("in_array(");
                    Write(call.Args[0], sb);
                    sb.Append(", ").Append(t).Append(", true)");
                }
                return;
            case "all":
                sb.Append("array_reduce(").Append(t).Append(", ");
                WriteReduceLambda(call, sb, "&&", "true");
                sb.Append(')');
                return;
            case "any":
                sb.Append("array_reduce(").Append(t).Append(", ");
                WriteReduceLambda(call, sb, "||", "false");
                sb.Append(')');
                return;
            case "none":
                sb.Append("!array_reduce(").Append(t).Append(", ");
                WriteReduceLambda(call, sb, "||", "false");
                sb.Append(')');
                return;
            case "min":
                sb.Append(@"\Koine\Runtime\Decimal::min(").Append(RenderArrayMap(call, t)).Append(')');
                return;
            case "max":
                sb.Append(@"\Koine\Runtime\Decimal::max(").Append(RenderArrayMap(call, t)).Append(')');
                return;
            case "sum":
                WriteSum(call, t, sb);
                return;
            case "distinctBy":
                var mapped = RenderArrayMap(call, t);
                sb.Append("count(array_unique(").Append(mapped).Append(")) === count(").Append(t).Append(')');
                return;
            default:
                sb.Append("null /* unsupported call '").Append(call.Method).Append("' */");
                return;
        }
    }

    /// <summary>
    /// Writes an <c>fn($carry, $item) =&gt; $carry &lt;op&gt; &lt;predicate&gt;, &lt;seed&gt;</c>
    /// inline for <c>array_reduce</c>-based all/any/none.
    /// </summary>
    private void WriteReduceLambda(CallExpr call, StringBuilder sb, string op, string seed)
    {
        if (call.Args is not [LambdaExpr lambda])
        {
            sb.Append("fn($carry, $item) => null /* expected lambda */, ").Append(seed);
            return;
        }

        var wasPresent = _locals.Contains(lambda.Parameter);
        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        PushLocal(lambda.Parameter, element);

        var param = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(lambda.Parameter));
        sb.Append("fn($carry, $").Append(param).Append(") => $carry ").Append(op).Append(' ');

        var body = new StringBuilder();
        Write(lambda.Body, body);
        sb.Append(body);

        if (!wasPresent)
        {
            PopLocal(lambda.Parameter);
        }

        sb.Append(", ").Append(seed);
    }

    /// <summary>
    /// Lowers a <c>.sum(p =&gt; body)</c> call.
    /// When the projected element type is a bare <c>Int</c>, PHP's <c>array_sum</c> is used.
    /// For <c>Decimal</c> or value-object projections the runtime
    /// <c>\Koine\Runtime\Decimal::sum</c> is used (guards empty collection).
    /// </summary>
    private void WriteSum(CallExpr call, string target, StringBuilder sb)
    {
        TypeRef? selectorType = InferSelectorType(call);
        var mapped = RenderArrayMap(call, target);
        if (selectorType?.Name == "Int")
        {
            sb.Append("array_sum(").Append(mapped).Append(')');
        }
        else
        {
            sb.Append(@"\Koine\Runtime\Decimal::sum(").Append(mapped).Append(')');
        }
    }

    /// <summary>
    /// Infers the type produced by the lambda body inside a <c>sum</c>/<c>min</c>/<c>max</c>
    /// call. Mirrors the identical method in <see cref="Python.PythonExpressionTranslator"/>.
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
    /// Renders <c>array_map(fn($param) =&gt; body, $target)</c> for collection projections.
    /// The lambda parameter is pushed as a local while its body is written.
    /// </summary>
    private string RenderArrayMap(CallExpr call, string target)
    {
        if (call.Args is not [LambdaExpr lambda])
        {
            return "null /* expected lambda */";
        }

        var wasPresent = _locals.Contains(lambda.Parameter);
        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        PushLocal(lambda.Parameter, element);

        var param = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(lambda.Parameter));
        var body = new StringBuilder();
        Write(lambda.Body, body);

        if (!wasPresent)
        {
            PopLocal(lambda.Parameter);
        }

        return $"array_map(fn(${param}) => {body}, {target})";
    }

    private static void WriteLiteral(LiteralExpr lit, StringBuilder sb)
    {
        switch (lit.Kind)
        {
            case LiteralKind.Int:
                sb.Append(lit.Text);
                break;
            case LiteralKind.Bool:
                // Koine `true`/`false` -> PHP `true`/`false` (lowercase).
                sb.Append(lit.Text == "true" ? "true" : "false");
                break;
            case LiteralKind.Decimal:
                // A Decimal literal is constructed from its exact textual form (money-safe, never float).
                sb.Append(@"new \Koine\Runtime\Decimal('").Append(lit.Text).Append("')");
                break;
            case LiteralKind.String:
                sb.Append('"').Append(EscapeString(lit.Text)).Append('"');
                break;
        }
    }

    /// <summary>
    /// Escapes a regex pattern for use inside a PHP single-quoted PCRE delimiter pattern
    /// <c>'/pattern/'</c>. Escapes single quotes and backslashes.
    /// </summary>
    private static string EscapeRegex(string pattern)
    {
        var sb = new StringBuilder(pattern.Length + 2);
        foreach (var c in pattern)
        {
            switch (c)
            {
                case '\'':
                    sb.Append("\\'");
                    break;
                case '\\':
                    sb.Append("\\\\");
                    break;
                default:
                    sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
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
