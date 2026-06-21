using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// Translates the target-agnostic <see cref="Expr"/> sublanguage into Rust expression source — the
/// Rust counterpart of <see cref="CSharp.CSharpExpressionTranslator"/> and the Python/TS translators.
/// <para>
/// Member identifiers render as <c>self.&lt;snake&gt;</c> in <see cref="NameMode.Property"/> (instance
/// bodies: derived getters, commands) or as the bare <c>&lt;snake&gt;</c> parameter in
/// <see cref="NameMode.Parameter"/> (smart-constructor / invariant context, where the member is still
/// the incoming parameter). A member access <c>x.field</c> on another value lowers to the accessor call
/// <c>x.field()</c>. Enum members render as <c>EnumName::Variant</c>. Decimal literals route through the
/// runtime <c>dec("…")</c> helper (money-safe), and an <c>Int</c> literal/expression compared with or
/// added to a <c>Decimal</c> is coerced via <c>Decimal::from(…)</c>. Regex <c>matches</c> lowers to the
/// runtime <c>regex_is_match</c>; decimal-safe folds (<c>sum</c>/<c>min</c>/<c>max</c>) route through the
/// runtime helpers; <c>let…in</c> lowers to a Rust block expression.
/// </para>
/// </summary>
internal sealed class RustExpressionTranslator
{
    /// <summary>How a member identifier should be rendered.</summary>
    public enum NameMode
    {
        /// <summary>Smart-constructor / invariant context: a member renders as its bare parameter.</summary>
        Parameter,
        /// <summary>Instance-body context (getters, commands): a member renders as <c>self.&lt;snake&gt;</c>.</summary>
        Property
    }

    private NameMode _mode = NameMode.Property;

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly RustTypeMapper _typeMapper;
    private readonly TypeScope _scope;
    private readonly ISet<string> _memberNames;
    private readonly IReadOnlyDictionary<string, string> _enumMemberToType;

    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);

    private string? _expectedEnum;

    public RustExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        RustTypeMapper typeMapper,
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

    /// <summary>Translates an expression to a Rust expression string (members render as <c>self.x</c>).</summary>
    public string Translate(Expr expr, string? expectedEnum = null) => Translate(expr, NameMode.Property, expectedEnum);

    /// <summary>Translates an expression with an explicit member-rendering mode.</summary>
    public string Translate(Expr expr, NameMode mode, string? expectedEnum = null)
    {
        var prevMode = _mode;
        _mode = mode;
        _expectedEnum = expectedEnum;
        var sb = new StringBuilder();
        Write(expr, sb, null);
        _expectedEnum = null;
        _mode = prevMode;
        return sb.ToString();
    }

    private void Write(Expr expr, StringBuilder sb, TypeRef? coerceTo)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                WriteIdentifier(id.Name, sb, null, coerceTo);
                break;
            case LiteralExpr lit:
                WriteLiteral(lit, sb, coerceTo);
                break;
            case BinaryExpr bin:
                WriteBinary(bin, sb, parenthesize: true);
                break;
            case UnaryExpr un:
                WriteUnary(un, sb);
                break;
            case ConditionalExpr cond:
                // `if <cond> { <then> } else { <else> }` — a Rust block-form conditional expression.
                sb.Append("if ");
                Write(cond.Condition, sb, null);
                sb.Append(" { ");
                Write(cond.Then, sb, coerceTo);
                sb.Append(" } else { ");
                Write(cond.Else, sb, coerceTo);
                sb.Append(" }");
                break;
            case CoalesceExpr co:
                // `l ?? r` -> `l.clone().unwrap_or_else(|| r)` (l is an Option<T>; result is T).
                WriteOperandValue(co.Left, sb);
                sb.Append(".unwrap_or_else(|| ");
                WriteOperandValue(co.Right, sb);
                sb.Append(')');
                break;
            case MemberAccessExpr ma:
                WriteMemberAccess(ma, sb);
                break;
            case CallExpr call:
                WriteCall(call, sb);
                break;
            case MatchExpr m:
                // `raw matches /pat/` -> `crate::koine_runtime::regex_is_match(r"pat", &raw)`.
                sb.Append("crate::koine_runtime::regex_is_match(").Append(RawRegexLiteral(m.Pattern)).Append(", ");
                WriteStrRef(m.Target, sb);
                sb.Append(')');
                break;
            case GuardExpr g:
                Write(g.Body, sb, coerceTo);
                break;
            case LetExpr let:
                WriteLet(let, sb, coerceTo);
                break;
            default:
                sb.Append("/* unsupported expression */ false");
                break;
        }
    }

    private void WriteUnary(UnaryExpr un, StringBuilder sb)
    {
        if (un.Op == UnaryOp.Not)
        {
            sb.Append('!');
            WriteAtom(un.Operand, sb);
            return;
        }

        sb.Append('-');
        WriteAtom(un.Operand, sb);
    }

    /// <summary>Writes an operand, parenthesizing a compound expression for safe precedence.</summary>
    private void WriteAtom(Expr expr, StringBuilder sb)
    {
        if (expr is IdentifierExpr or LiteralExpr or MemberAccessExpr or CallExpr)
        {
            Write(expr, sb, null);
        }
        else
        {
            sb.Append('(');
            Write(expr, sb, null);
            sb.Append(')');
        }
    }

    private void WriteBinary(BinaryExpr bin, StringBuilder sb, bool parenthesize)
    {
        if (parenthesize)
        {
            sb.Append('(');
        }

        TypeScope scope = EffectiveScope();
        TypeRef? leftType = _resolver.Infer(bin.Left, scope);
        TypeRef? rightType = _resolver.Infer(bin.Right, scope);
        var isArithmetic = bin.Op is BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div;

        // Decimal coercion: an Int operand on the side opposite a Decimal becomes a Decimal.
        TypeRef? coerceLeft = rightType?.Name == "Decimal" && leftType?.Name == "Int" ? Decimal() : null;
        TypeRef? coerceRight = leftType?.Name == "Decimal" && rightType?.Name == "Int" ? Decimal() : null;

        // Value-object arithmetic (e.g. Money * quantity) consumes `self` via std::ops, so a non-Copy
        // place operand must be cloned; comparisons borrow and need no clone.
        var cloneLeft = isArithmetic && IsNonCopyPlace(bin.Left, leftType);
        var cloneRight = isArithmetic && IsNonCopyPlace(bin.Right, rightType);

        WriteOperand(bin.Left, sb, EnumTypeName(bin.Right), coerceLeft, cloneLeft);
        sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
        WriteOperand(bin.Right, sb, EnumTypeName(bin.Left), coerceRight, cloneRight);

        if (parenthesize)
        {
            sb.Append(')');
        }
    }

    private void WriteOperand(Expr expr, StringBuilder sb, string? enumHint, TypeRef? coerceTo, bool clone)
    {
        switch (expr)
        {
            case BinaryExpr bin:
                WriteBinary(bin, sb, parenthesize: true);
                break;
            case IdentifierExpr id:
                WriteIdentifier(id.Name, sb, enumHint, coerceTo);
                if (clone)
                {
                    sb.Append(".clone()");
                }
                break;
            default:
                Write(expr, sb, coerceTo);
                if (clone)
                {
                    sb.Append(".clone()");
                }
                break;
        }
    }

    /// <summary>Writes an expression as an owned value (used for coalesce arms): cloned when it is a place.</summary>
    private void WriteOperandValue(Expr expr, StringBuilder sb)
    {
        TypeRef? type = _resolver.Infer(expr, EffectiveScope());
        var clone = IsNonCopyPlace(expr, type) || (expr is MemberAccessExpr && type is { } t && !_typeMapper.IsCopy(t));
        Write(expr, sb, null);
        if (clone)
        {
            sb.Append(".clone()");
        }
    }

    private void WriteLet(LetExpr let, StringBuilder sb, TypeRef? coerceTo)
    {
        // `let x = e1, y = e2 in body` -> `{ let x = e1; let y = e2; body }` (a Rust block expression).
        var pushed = new List<string>();
        sb.Append("{ ");
        foreach (LetBinding b in let.Bindings)
        {
            sb.Append("let ").Append(RustNaming.Field(b.Name)).Append(" = ");
            Write(b.Value, sb, null);
            sb.Append("; ");
            PushLocal(b.Name, _resolver.Infer(b.Value, EffectiveScope()));
            pushed.Add(b.Name);
        }

        // The block's return value needs no outer parentheses (rustc warns on them), so render the
        // body to a buffer and drop one fully-enclosing pair.
        var bodyBuf = new StringBuilder();
        Write(let.Body, bodyBuf, coerceTo);
        sb.Append(StripOuterParens(bodyBuf.ToString()));
        sb.Append(" }");

        for (var i = pushed.Count - 1; i >= 0; i--)
        {
            PopLocal(pushed[i]);
        }
    }

    private void WriteIdentifier(string name, StringBuilder sb, string? enumHint, TypeRef? coerceTo)
    {
        // (1) Local (lambda/command/factory parameter, let binding): verbatim snake_case.
        if (_locals.Contains(name))
        {
            EmitCoerced(sb, coerceTo, () => sb.Append(RustNaming.Field(name)));
            return;
        }

        // (2) Nullary value builtin such as `now` (unless shadowed by a real member).
        if (BuiltinOps.IsNullaryValueOp(name) && !_memberNames.Contains(name) && name == "now")
        {
            sb.Append("crate::koine_runtime::now()");
            return;
        }

        // (3) Enum member reference -> EnumName::Variant.
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
                sb.Append(RustNaming.ToPascalCase(enumType)).Append("::").Append(RustNaming.Variant(name));
                return;
            }
        }

        // (4) Member of the enclosing type: `self.<snake>` in a body (a stored field reads directly;
        // a derived member reads via its accessor), bare `<snake>` in a constructor/invariant.
        if (_memberNames.Contains(name))
        {
            EmitCoerced(sb, coerceTo, () =>
            {
                if (_mode == NameMode.Property)
                {
                    sb.Append("self.").Append(RustNaming.Field(name));
                }
                else
                {
                    sb.Append(RustNaming.Field(name));
                }
            });
            return;
        }

        // (5) An enum *type* reference (qualifier of `OrderStatus.Draft`): the PascalCase type.
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(RustNaming.ToPascalCase(name));
            return;
        }

        // (6) Unknown identifier: best-effort snake.
        sb.Append(RustNaming.Field(name));
    }

    /// <summary>Wraps an emitted Int identifier in <c>Decimal::from(…)</c> when a Decimal is expected.</summary>
    private static void EmitCoerced(StringBuilder sb, TypeRef? coerceTo, Action emit)
    {
        if (coerceTo?.Name == "Decimal")
        {
            sb.Append("Decimal::from(");
            emit();
            sb.Append(')');
        }
        else
        {
            emit();
        }
    }

    private void WriteMemberAccess(MemberAccessExpr ma, StringBuilder sb)
    {
        // Qualified enum-member access: `OrderStatus.Cancelled` -> `OrderStatus::Cancelled`.
        if (ma.Target is IdentifierExpr qualifier && !_memberNames.Contains(qualifier.Name)
            && !_locals.Contains(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(RustNaming.ToPascalCase(qualifier.Name)).Append("::").Append(RustNaming.Variant(ma.MemberName));
            return;
        }

        var target = new StringBuilder();
        Write(ma.Target, target, null);
        var t = target.ToString();
        switch (ma.MemberName)
        {
            case "isEmpty":
                sb.Append(t).Append(".is_empty()");
                return;
            case "isNotEmpty":
                sb.Append('!').Append(t).Append(".is_empty()");
                return;
            case "count":
            case "length":
                // String/collection length; cast to i64 so it composes with Koine `Int` arithmetic.
                sb.Append('(').Append(t).Append(".len() as i64)");
                return;
            case "trim":
                sb.Append(t).Append(".trim()");
                return;
            case "lower":
                sb.Append(t).Append(".to_lowercase()");
                return;
            case "upper":
                sb.Append(t).Append(".to_uppercase()");
                return;
            case "isBlank":
                sb.Append(t).Append(".trim().is_empty()");
                return;
            case "isPresent":
                sb.Append(t).Append(".is_some()");
                return;
            case "isNone":
            case "isAbsent":
                sb.Append(t).Append(".is_none()");
                return;
            default:
                // A field/derived-member access on another value: call its accessor.
                sb.Append(t).Append('.').Append(RustNaming.Field(ma.MemberName)).Append("()");
                return;
        }
    }

    private void WriteCall(CallExpr call, StringBuilder sb)
    {
        var target = new StringBuilder();
        Write(call.Target, target, null);
        var t = target.ToString();

        switch (call.Method)
        {
            case "startsWith":
                sb.Append(t).Append(".starts_with(");
                WriteStrRef(call.Args[0], sb);
                sb.Append(')');
                return;
            case "endsWith":
                sb.Append(t).Append(".ends_with(");
                WriteStrRef(call.Args[0], sb);
                sb.Append(')');
                return;
            case "contains":
                sb.Append(t).Append(".contains(");
                WriteStrRef(call.Args[0], sb);
                sb.Append(')');
                return;
            case "all":
                sb.Append(t).Append(".iter().all(|").Append(LambdaParam(call)).Append("| ");
                WriteLambdaBody(call, sb);
                sb.Append(')');
                return;
            case "any":
                sb.Append(t).Append(".iter().any(|").Append(LambdaParam(call)).Append("| ");
                WriteLambdaBody(call, sb);
                sb.Append(')');
                return;
            case "none":
                sb.Append('!').Append(t).Append(".iter().any(|").Append(LambdaParam(call)).Append("| ");
                WriteLambdaBody(call, sb);
                sb.Append(')');
                return;
            case "sum":
                sb.Append("crate::koine_runtime::koine_sum(").Append(MapProjection(call, t)).Append(')');
                return;
            case "min":
                sb.Append("crate::koine_runtime::koine_min(").Append(MapProjection(call, t)).Append(')');
                return;
            case "max":
                sb.Append("crate::koine_runtime::koine_max(").Append(MapProjection(call, t)).Append(')');
                return;
            default:
                sb.Append("/* unsupported call '").Append(call.Method).Append("' */ false");
                return;
        }
    }

    /// <summary>The escaped Rust lambda parameter name for a collection-op call.</summary>
    private static string LambdaParam(CallExpr call) =>
        call.Args is [LambdaExpr lambda] ? RustNaming.Field(lambda.Parameter) : "_x";

    /// <summary>Writes a predicate lambda body with its parameter pushed as a local (element type).</summary>
    private void WriteLambdaBody(CallExpr call, StringBuilder sb)
    {
        if (call.Args is not [LambdaExpr lambda])
        {
            sb.Append("false");
            return;
        }

        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        var wasPresent = _locals.Contains(lambda.Parameter);
        PushLocal(lambda.Parameter, element);
        var bodyBuf = new StringBuilder();
        Write(lambda.Body, bodyBuf, null);
        sb.Append(StripOuterParens(bodyBuf.ToString()));
        if (!wasPresent)
        {
            PopLocal(lambda.Parameter);
        }
    }

    /// <summary>
    /// Renders the <c>iter().map(...)</c> projection feeding a sum/min/max fold: each element is mapped
    /// through the lambda body and cloned to an owned value (so a stored value-object field projects to
    /// an owned operand the fold can consume).
    /// </summary>
    private string MapProjection(CallExpr call, string target)
    {
        if (call.Args is not [LambdaExpr lambda])
        {
            return target + ".iter().cloned()";
        }

        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        var wasPresent = _locals.Contains(lambda.Parameter);
        PushLocal(lambda.Parameter, element);
        TypeRef? bodyType = _resolver.Infer(lambda.Body, EffectiveScope());
        var body = new StringBuilder();
        Write(lambda.Body, body, null);
        if (!wasPresent)
        {
            PopLocal(lambda.Parameter);
        }

        // A non-Copy projection (a value object) must be owned for the fold; `.clone()` makes a
        // stored-field reference owned (and is a harmless no-op shape on an already-owned temporary).
        var owned = bodyType is { } bt && !_typeMapper.IsCopy(bt) ? ".clone()" : string.Empty;
        return $"{target}.iter().map(|{RustNaming.Field(lambda.Parameter)}| {body}{owned})";
    }

    /// <summary>Writes a string-typed argument as a <c>&amp;str</c> reference for std string methods.</summary>
    private void WriteStrRef(Expr expr, StringBuilder sb)
    {
        if (expr is LiteralExpr { Kind: LiteralKind.String } lit)
        {
            WriteLiteral(lit, sb, null);
            return;
        }

        sb.Append('&');
        Write(expr, sb, null);
    }

    private void WriteLiteral(LiteralExpr lit, StringBuilder sb, TypeRef? coerceTo)
    {
        switch (lit.Kind)
        {
            case LiteralKind.Int:
                if (coerceTo?.Name == "Decimal")
                {
                    sb.Append("Decimal::from(").Append(lit.Text).Append("i64)");
                }
                else
                {
                    sb.Append(lit.Text);
                }
                break;
            case LiteralKind.Bool:
                sb.Append(lit.Text == "true" ? "true" : "false");
                break;
            case LiteralKind.Decimal:
                sb.Append("crate::koine_runtime::dec(\"").Append(lit.Text).Append("\")");
                break;
            case LiteralKind.String:
                sb.Append('"').Append(EscapeString(lit.Text)).Append('"');
                break;
        }
    }

    /// <summary>Drops one fully-enclosing parenthesis pair from <paramref name="s"/>, if present.</summary>
    internal static string StripOuterParens(string s)
    {
        if (s.Length < 2 || s[0] != '(' || s[^1] != ')')
        {
            return s;
        }

        var depth = 0;
        for (var i = 0; i < s.Length; i++)
        {
            if (s[i] == '(')
            {
                depth++;
            }
            else if (s[i] == ')')
            {
                depth--;
                if (depth == 0 && i != s.Length - 1)
                {
                    return s;
                }
            }
        }

        return s[1..^1];
    }

    private TypeRef Decimal() => new("Decimal");

    private string? EnumTypeName(Expr expr)
    {
        TypeRef? type = _resolver.Infer(expr, EffectiveScope());
        return type is not null && _index.Classify(type.Name) == TypeKind.Enum ? type.Name : null;
    }

    /// <summary>True when an expression is a place (member/local) of a non-Copy type — so a by-value op must clone it.</summary>
    private bool IsNonCopyPlace(Expr expr, TypeRef? type)
    {
        if (type is null || _typeMapper.IsCopy(type))
        {
            return false;
        }

        return expr is IdentifierExpr || expr is MemberAccessExpr;
    }

    private static string RawRegexLiteral(string pattern)
    {
        // A Rust raw string `r"..."` can't contain a `"`; fall back to an escaped regular string.
        if (!pattern.Contains('"'))
        {
            return "r\"" + pattern + "\"";
        }

        return "\"" + pattern.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
    }

    private static string EscapeString(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }

    private static string OperatorOf(BinaryOp op) => op switch
    {
        BinaryOp.Or => "||",
        BinaryOp.And => "&&",
        BinaryOp.Eq => "==",
        BinaryOp.Neq => "!=",
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
