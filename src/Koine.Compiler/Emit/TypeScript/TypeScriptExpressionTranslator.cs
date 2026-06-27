using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

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

    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);

    // When set, a member identifier renders as `receiver.<camelCase>` (e.g. a read-model projection
    // whose members read off the `src` parameter), the TS analogue of the C# translator's
    // memberReceiver. Overrides the `this.`/bare NameMode rendering for members.
    private readonly string? _memberReceiver;

    // The enum type the whole expression is expected to produce; qualifies a bare shared
    // enum member where a comparison hint does not reach.
    private string? _expectedEnum;

    private int _sumCounter;

    public TypeScriptExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        TypeScriptTypeMapper typeMapper,
        string? context = null,
        string? memberReceiver = null)
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _typeMapper = typeMapper;
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
                sb.Append('(');
                Write(cond.Condition, sb);
                sb.Append(" ? ");
                Write(cond.Then, sb);
                sb.Append(" : ");
                Write(cond.Else, sb);
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
                // raw matches /pat/  ->  /pat/.test(raw)
                sb.Append("/").Append(m.Pattern).Append("/.test(");
                Write(m.Target, sb);
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

        WriteOperand(bin.Left, sb, EnumTypeName(bin.Right));
        sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
        WriteOperand(bin.Right, sb, EnumTypeName(bin.Left));
        if (parenthesize)
        {
            sb.Append(')');
        }
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
    /// (<c>.add</c>/<c>.subtract</c>/<c>.multiply</c>) instead of a JS operator. Equality and
    /// comparison still use the inline operators. Returns false for ordinary numeric arithmetic.
    /// </summary>
    private bool TryWriteValueArithmetic(BinaryExpr bin, StringBuilder sb)
    {
        if (bin.Op is not (BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul))
        {
            return false;
        }

        TypeScope scope = EffectiveScope();
        TypeRef? left = _resolver.Infer(bin.Left, scope);
        var leftDecimal = left?.Name == "Decimal";
        var leftValue = _resolver.IsValueLike(left);

        if (!leftDecimal && !leftValue)
        {
            return false;
        }

        var method = bin.Op switch
        {
            BinaryOp.Add => "add",
            BinaryOp.Sub => "subtract",
            _ => "multiply"
        };

        Write(bin.Left, sb);
        sb.Append('.').Append(method).Append('(');
        // A value-object scalar multiply (Money * quantity) takes a plain `number`, so a Decimal
        // literal scalar (e.g. 0.9) renders as a bare number, not a `new Decimal(...)`. A Decimal *
        // Decimal/Int (true decimal arithmetic) passes the operand through unchanged.
        if (bin.Op == BinaryOp.Mul && leftValue && bin.Right is LiteralExpr { Kind: LiteralKind.Int or LiteralKind.Decimal } scalarLit)
        {
            sb.Append(scalarLit.Text);
        }
        else
        {
            Write(bin.Right, sb);
        }
        sb.Append(')');
        return true;
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
        if (_locals.Contains(name))
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
            && !_locals.Contains(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(TypeScriptNaming.ToPascalCase(qualifier.Name)).Append('.')
              .Append(TypeScriptNaming.ToPascalCase(ma.MemberName));
            return;
        }

        var target = new StringBuilder();
        Write(ma.Target, target);
        var t = target.ToString();
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
    /// / <c>Decimal</c> selector — all emitted as classes with a structural <c>equals</c> — two
    /// structurally-equal-but-distinct instances would survive as separate entries and the invariant
    /// would never fire, diverging from C#'s structural <c>Distinct()</c> (issue #609). For those
    /// selectors we count distinct projections structurally via the runtime <c>structuralEquals</c>
    /// (keeping each value's first occurrence, O(n²) like <c>structuralEquals</c> is used elsewhere;
    /// invariant collections are small). A primitive selector (<c>string</c>/<c>number</c>/
    /// <c>boolean</c>) already dedupes by value under SameValueZero, so it keeps the fast Set path.
    /// </summary>
    private void WriteDistinctBy(CallExpr call, string target, StringBuilder sb)
    {
        TypeRef? selectorType = InferSelectorType(call);
        if (_resolver.IsValueLike(selectorType) || selectorType?.Name == "Decimal")
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

        var wasPresent = _locals.Contains(lambda.Parameter);
        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        PushLocal(lambda.Parameter, element);
        var body = new StringBuilder();
        Write(lambda.Body, body);
        if (!wasPresent)
        {
            PopLocal(lambda.Parameter);
        }

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
