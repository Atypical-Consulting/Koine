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

    /// <summary>
    /// PHP rendering for each nullary value builtin — the PHP counterpart of the C#
    /// (<c>DateTimeOffset.UtcNow</c>) / Python / TypeScript (<c>Instant.now()</c>) tables. The
    /// dependency-free stdlib <c>new \DateTimeImmutable('now')</c> matches the <c>Instant</c> →
    /// <c>\DateTimeImmutable</c> mapping in <see cref="PhpTypeMapper"/>.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> NullaryValueOpsPhp =
        new Dictionary<string, string>(StringComparer.Ordinal) { ["now"] = @"new \DateTimeImmutable('now')" };

    private NameMode _mode = NameMode.Property;

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

    // The receiver a `NameMode.Property` member renders against — `$this` inside a class body,
    // or a supplied parameter name (e.g. `src`) for a read-model projection rooted at the source.
    private readonly string _memberReceiver;

    public PhpExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        string? context = null,
        string memberReceiver = "this")
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _scope = TypeScope.FromMembers(members, index);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType;
        _memberReceiver = memberReceiver;
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
            case BinaryExpr bin when FlipOp(bin.Op) is { } flippedOp:
                // A Decimal/value-object comparison can't be flipped with a native operator (PHP has
                // no operator overloading); render the logically-negated comparison as a method call.
                if (TryWriteValueBinary(new BinaryExpr(flippedOp, bin.Left, bin.Right), sb, parenthesize: false))
                {
                    break;
                }
                WriteOperand(bin.Left, sb, EnumTypeName(bin.Right));
                sb.Append(' ').Append(OperatorOf(flippedOp)).Append(' ');
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

    /// <summary>The logically-negated comparison operator, or <c>null</c> for a non-comparison op.</summary>
    private static BinaryOp? FlipOp(BinaryOp op) => op switch
    {
        BinaryOp.Eq => BinaryOp.Neq,
        BinaryOp.Neq => BinaryOp.Eq,
        BinaryOp.Lt => BinaryOp.Ge,
        BinaryOp.Le => BinaryOp.Gt,
        BinaryOp.Gt => BinaryOp.Le,
        BinaryOp.Ge => BinaryOp.Lt,
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
        // PHP has NO operator overloading, so a native operator on a runtime Decimal or a value
        // object is invalid — those lower to method calls (compareTo/equals/add/sub/mul/div, or the
        // VO's own add/subtract/multipliedBy/dividedBy). Plain primitives keep native operators.
        if (TryWriteValueBinary(bin, sb, parenthesize))
        {
            return;
        }

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

    /// <summary>
    /// Renders a binary expression whose operand(s) are a runtime <c>Decimal</c> or a value object,
    /// lowering it to method calls (PHP has no operator overloading). Returns <c>false</c> when both
    /// operands are plain primitives, leaving the native-operator path to the caller.
    /// </summary>
    private bool TryWriteValueBinary(BinaryExpr bin, StringBuilder sb, bool parenthesize)
    {
        TypeRef? left = InferType(bin.Left);
        TypeRef? right = InferType(bin.Right);

        if (IsDecimal(left) || IsDecimal(right))
        {
            // Decimal arithmetic/comparison. Whichever side is the Decimal is the receiver; the
            // other operand is coerced to a Decimal expression.
            bool leftIsDecimal = IsDecimal(left);
            Expr receiver = leftIsDecimal ? bin.Left : bin.Right;
            Expr operand = leftIsDecimal ? bin.Right : bin.Left;
            WriteDecimalBinary(bin.Op, receiver, operand, leftIsDecimal, sb, parenthesize);
            return true;
        }

        if (IsArithmeticValueObject(left) || IsArithmeticValueObject(right))
        {
            WriteValueObjectBinary(bin, left, sb, parenthesize);
            return true;
        }

        return false;
    }

    /// <summary>
    /// Lowers a binary op where one operand is a runtime <c>Decimal</c>. Comparisons go through
    /// <c>compareTo(...) OP 0</c>, equality through <c>equals(...)</c>, arithmetic through
    /// <c>add/sub/mul/div</c>. A non-Decimal operand is wrapped via <see cref="WriteAsDecimal"/>.
    /// </summary>
    private void WriteDecimalBinary(
        BinaryOp op, Expr receiver, Expr operand, bool receiverIsLeft, StringBuilder sb, bool parenthesize)
    {
        switch (op)
        {
            case BinaryOp.Eq:
            case BinaryOp.Neq:
                if (op == BinaryOp.Neq)
                {
                    sb.Append('!');
                }
                WriteReceiver(receiver, sb);
                sb.Append("->equals(");
                WriteAsDecimal(operand, sb);
                sb.Append(')');
                return;

            case BinaryOp.Lt:
            case BinaryOp.Le:
            case BinaryOp.Gt:
            case BinaryOp.Ge:
                // compareTo returns sign; keep the operator's orientation relative to the receiver.
                if (parenthesize)
                {
                    sb.Append('(');
                }
                WriteReceiver(receiver, sb);
                sb.Append("->compareTo(");
                WriteAsDecimal(operand, sb);
                sb.Append(") ").Append(CompareOperator(op, receiverIsLeft)).Append(" 0");
                if (parenthesize)
                {
                    sb.Append(')');
                }
                return;

            default:
                // Arithmetic: add/sub/mul/div. These are non-commutative for sub/div, so respect side.
                Expr left = receiverIsLeft ? receiver : operand;
                Expr right = receiverIsLeft ? operand : receiver;
                WriteAsDecimal(left, sb);
                sb.Append("->").Append(DecimalArithMethod(op)).Append('(');
                WriteAsDecimal(right, sb);
                sb.Append(')');
                return;
        }
    }

    /// <summary>
    /// Lowers a binary op where one operand is a value object that exposes arithmetic methods.
    /// VO+VO -&gt; <c>add</c>, VO-VO -&gt; <c>subtract</c>, VO*scalar -&gt; <c>multipliedBy</c>,
    /// VO/scalar -&gt; <c>dividedBy</c>, equality -&gt; <c>equals</c>, comparison -&gt; compare the
    /// underlying <c>amount</c> accessor (no comparison method is generated on the VO).
    /// </summary>
    private void WriteValueObjectBinary(
        BinaryExpr bin, TypeRef? left, StringBuilder sb, bool parenthesize)
    {
        bool leftIsVo = IsArithmeticValueObject(left);
        Expr vo = leftIsVo ? bin.Left : bin.Right;
        Expr other = leftIsVo ? bin.Right : bin.Left;

        switch (bin.Op)
        {
            case BinaryOp.Eq:
            case BinaryOp.Neq:
                if (bin.Op == BinaryOp.Neq)
                {
                    sb.Append('!');
                }
                WriteReceiver(vo, sb);
                sb.Append("->equals(");
                Write(other, sb);
                sb.Append(')');
                return;

            case BinaryOp.Add:
                // Receiver is the value object (whichever side it is on); the other operand is the
                // argument. Using bin.Left unconditionally would emit `1->add(...)` for a VO on the
                // right — a fatal PHP error.
                WriteReceiver(vo, sb);
                sb.Append("->add(");
                Write(other, sb);
                sb.Append(')');
                return;

            case BinaryOp.Sub:
                WriteReceiver(vo, sb);
                sb.Append("->subtract(");
                Write(other, sb);
                sb.Append(')');
                return;

            case BinaryOp.Mul:
                WriteReceiver(vo, sb);
                sb.Append("->multipliedBy(");
                WriteAsDecimal(other, sb);
                sb.Append(')');
                return;

            case BinaryOp.Div:
                WriteReceiver(vo, sb);
                sb.Append("->dividedBy(");
                WriteAsDecimal(other, sb);
                sb.Append(')');
                return;

            default:
                // Comparison: no comparison method is generated on the VO, so compare the underlying
                // Decimal `amount` accessor. Both operands are the same VO type here.
                if (parenthesize)
                {
                    sb.Append('(');
                }
                WriteReceiver(bin.Left, sb);
                sb.Append("->amount->compareTo(");
                WriteReceiver(bin.Right, sb);
                sb.Append("->amount) ").Append(CompareOperator(bin.Op, receiverIsLeft: true)).Append(" 0");
                if (parenthesize)
                {
                    sb.Append(')');
                }
                return;
        }
    }

    /// <summary>Writes an operand as a method receiver, parenthesizing a compound expression.</summary>
    private void WriteReceiver(Expr expr, StringBuilder sb)
    {
        if (expr is IdentifierExpr or MemberAccessExpr or CallExpr)
        {
            Write(expr, sb);
        }
        else
        {
            sb.Append('(');
            Write(expr, sb);
            sb.Append(')');
        }
    }

    /// <summary>
    /// Writes an operand coerced to a runtime <c>Decimal</c> expression. A Decimal operand is
    /// emitted as-is; an integer literal <c>n</c> becomes <c>new \Koine\Runtime\Decimal('n')</c>;
    /// any other (e.g. an <c>Int</c> member) is wrapped as <c>new \Koine\Runtime\Decimal(e)</c>.
    /// </summary>
    private void WriteAsDecimal(Expr expr, StringBuilder sb)
    {
        if (IsDecimal(InferType(expr)))
        {
            Write(expr, sb);
            return;
        }

        if (expr is LiteralExpr { Kind: LiteralKind.Int } lit)
        {
            sb.Append(@"new \Koine\Runtime\Decimal('").Append(lit.Text).Append("')");
            return;
        }

        sb.Append(@"new \Koine\Runtime\Decimal(");
        Write(expr, sb);
        sb.Append(')');
    }

    private TypeRef? InferType(Expr expr) => _resolver.Infer(expr, EffectiveScope());

    private static bool IsDecimal(TypeRef? t) => t is { Name: "Decimal", IsOptional: false };

    /// <summary>
    /// True when the type is a value object (or quantity) that exposes arithmetic methods — i.e. a
    /// declared <c>value</c>/<c>quantity</c>. (ID value objects do not get arithmetic.)
    /// </summary>
    private bool IsArithmeticValueObject(TypeRef? t)
    {
        if (t is null || t.IsOptional)
        {
            return false;
        }

        return _index.Classify(t.Name) == TypeKind.Value;
    }

    /// <summary>The comparison operator to place after <c>compareTo(...)</c>, oriented to the receiver.</summary>
    private static string CompareOperator(BinaryOp op, bool receiverIsLeft)
    {
        BinaryOp effective = receiverIsLeft ? op : Mirror(op);
        return effective switch
        {
            BinaryOp.Lt => "<",
            BinaryOp.Le => "<=",
            BinaryOp.Gt => ">",
            BinaryOp.Ge => ">=",
            _ => "?"
        };
    }

    /// <summary>Mirrors a comparison when the Decimal receiver is on the right-hand side.</summary>
    private static BinaryOp Mirror(BinaryOp op) => op switch
    {
        BinaryOp.Lt => BinaryOp.Gt,
        BinaryOp.Le => BinaryOp.Ge,
        BinaryOp.Gt => BinaryOp.Lt,
        BinaryOp.Ge => BinaryOp.Le,
        _ => op
    };

    private static string DecimalArithMethod(BinaryOp op) => op switch
    {
        BinaryOp.Add => "add",
        BinaryOp.Sub => "sub",
        BinaryOp.Mul => "mul",
        BinaryOp.Div => "div",
        _ => throw new InvalidOperationException($"Not a Decimal arithmetic operator: {op}")
    };

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

        // (2) Nullary value builtin such as `now` (unless shadowed by a real member). Without this
        // the bare identifier falls through to (6) and renders an undefined `$now` (issue #395).
        if (BuiltinOps.IsNullaryValueOp(name) && !_memberNames.Contains(name)
            && NullaryValueOpsPhp.TryGetValue(name, out var php))
        {
            sb.Append(php);
            return;
        }

        // (3) Enum member reference -> EnumName::UPPER_SNAKE.
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

        // (4) Member of the enclosing type: `$this->camel` (or `$<receiver>->camel`) in a body,
        // `$camel` in a constructor/invariant (where the member is still the local parameter, not yet
        // a field). The receiver is `this` by default; a custom receiver (e.g. `src` for a read-model
        // projection) is set via the constructor parameter.
        if (_memberNames.Contains(name))
        {
            var camel = PhpNaming.EscapeIdentifier(PhpNaming.PropertyName(name));
            if (_mode == NameMode.Property)
            {
                sb.Append('$').Append(_memberReceiver).Append("->").Append(camel);
            }
            else
            {
                sb.Append('$').Append(camel);
            }
            return;
        }

        // (5) An enum *type* reference (the qualifier of `OrderStatus.Draft`): the PascalCase class.
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(PhpNaming.ClassName(name));
            return;
        }

        // (6) Unknown identifier: emit as $camelCase (best effort).
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
                case '/':
                    // Escape the PCRE delimiter so a `/` in the pattern doesn't close `/.../` early.
                    sb.Append("\\/");
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
