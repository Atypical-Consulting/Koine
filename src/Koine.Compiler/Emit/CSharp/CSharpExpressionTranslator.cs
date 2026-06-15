using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// Translates the target-agnostic <see cref="Expr"/> sublanguage into C#
/// expression source. Two naming modes select whether a member identifier renders
/// as its constructor parameter (camelCase) or its property (PascalCase).
/// </summary>
internal sealed class CSharpExpressionTranslator
{
    /// <summary>How a member identifier should be rendered.</summary>
    public enum NameMode
    {
        /// <summary>Constructor/invariant context: member -> camelCase parameter.</summary>
        Parameter,
        /// <summary>Property-body context (derived props, defaults): member -> PascalCase property.</summary>
        Property
    }

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly TypeScope _scope;
    private readonly ISet<string> _memberNames;
    private readonly IReadOnlyDictionary<string, string> _enumMemberToType;

    // Local names currently in scope (lambda parameters, command parameters):
    // rendered verbatim (camelCase, escaped) rather than as members.
    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);

    /// <summary>Registers a local (e.g. a command parameter) for the body about to be translated.</summary>
    public void PushLocal(string name) => _locals.Add(name);

    /// <summary>Removes a previously-registered local.</summary>
    public void PopLocal(string name) => _locals.Remove(name);

    // The enum type the whole expression is expected to produce (a derived/default
    // member of enum type). Used to qualify a bare shared enum member in positions
    // a comparison hint doesn't reach (conditional/coalesce branches, a bare value).
    private string? _expectedEnum;

    /// <param name="members">The members of the type being emitted.</param>
    /// <param name="enumMemberToType">Map from an enum member name to its owning enum type name.</param>
    public CSharpExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType)
    {
        _index = index;
        _resolver = new TypeResolver(index);
        _scope = TypeScope.FromMembers(members);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType;
    }

    public string Translate(Expr expr, NameMode mode, string? expectedEnum = null)
    {
        _expectedEnum = expectedEnum;
        var result = Render(expr, mode);
        _expectedEnum = null;
        return result;
    }

    /// <summary>
    /// Translates an expression that already sits in a parenthesized position
    /// (e.g. the operand of <c>!(...)</c> or an <c>if</c> condition), omitting the
    /// redundant outer parentheses a top-level binary operator would otherwise add.
    /// </summary>
    public string TranslateTopLevel(Expr expr, NameMode mode, string? expectedEnum = null)
    {
        _expectedEnum = expectedEnum;
        var sb = new StringBuilder();
        // `cond ? true : false` is just `cond`; `cond ? false : true` is `!(cond)`.
        if (expr is ConditionalExpr c && TryBoolLiterals(c, out var whenTrue))
        {
            if (whenTrue)
            {
                WriteTopLevel(c.Condition, mode, sb);
            }
            else
            {
                sb.Append("!(");
                Write(c.Condition, mode, sb);
                sb.Append(')');
            }
        }
        else
        {
            WriteTopLevel(expr, mode, sb);
        }
        _expectedEnum = null;
        return sb.ToString();
    }

    /// <summary>Renders an expression in a parenthesized position, omitting the outer parens a top-level binary operator would add.</summary>
    private void WriteTopLevel(Expr expr, NameMode mode, StringBuilder sb)
    {
        if (expr is BinaryExpr bin)
        {
            WriteOperand(bin.Left, mode, sb, EnumTypeName(bin.Right));
            sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
            WriteOperand(bin.Right, mode, sb, EnumTypeName(bin.Left));
        }
        else
        {
            Write(expr, mode, sb);
        }
    }

    /// <summary>True when a conditional's two branches are the bool literals true/false (in either order).</summary>
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

    /// <summary>Writes an operand, passing an enum-type hint when it is a bare identifier.</summary>
    private void WriteOperand(Expr expr, NameMode mode, StringBuilder sb, string? enumHint)
    {
        if (expr is IdentifierExpr id)
            WriteIdentifier(id.Name, mode, sb, enumHint);
        else
            Write(expr, mode, sb);
    }

    /// <summary>The enum type name an expression resolves to, else <c>null</c>.</summary>
    private string? EnumTypeName(Expr expr)
    {
        var type = _resolver.Infer(expr, _scope);
        return type is not null && _index.Classify(type.Name) == TypeKind.Enum ? type.Name : null;
    }

    private string Render(Expr expr, NameMode mode)
    {
        var sb = new StringBuilder();
        Write(expr, mode, sb);
        return sb.ToString();
    }

    private void Write(Expr expr, NameMode mode, StringBuilder sb)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                WriteIdentifier(id.Name, mode, sb);
                break;

            case LiteralExpr lit:
                WriteLiteral(lit, sb);
                break;

            case BinaryExpr bin:
                sb.Append('(');
                WriteOperand(bin.Left, mode, sb, EnumTypeName(bin.Right));
                sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
                WriteOperand(bin.Right, mode, sb, EnumTypeName(bin.Left));
                sb.Append(')');
                break;

            case UnaryExpr un:
                sb.Append(un.Op == UnaryOp.Not ? "!" : "-");
                // Parenthesize unless the operand is a bare identifier/literal or a
                // node that already self-parenthesizes. This keeps `!a` simple while
                // making `!lines.isEmpty` -> `!(Lines.Count == 0)` (not `!Lines.Count == 0`)
                // and `- -x` -> `-(-X)`.
                if (un.Operand is IdentifierExpr or LiteralExpr or BinaryExpr or ConditionalExpr or CoalesceExpr)
                {
                    Write(un.Operand, mode, sb);
                }
                else
                {
                    sb.Append('(');
                    Write(un.Operand, mode, sb);
                    sb.Append(')');
                }
                break;

            case ConditionalExpr cond when TryBoolLiterals(cond, out var whenTrue):
                // `cond ? true : false` => `cond`; `cond ? false : true` => `!(cond)`.
                if (whenTrue)
                {
                    Write(cond.Condition, mode, sb); // Write parenthesizes a binary condition
                }
                else
                {
                    sb.Append("!(");
                    Write(cond.Condition, mode, sb);
                    sb.Append(')');
                }
                break;

            case ConditionalExpr cond:
                sb.Append('(');
                Write(cond.Condition, mode, sb);
                sb.Append(" ? ");
                Write(cond.Then, mode, sb);
                sb.Append(" : ");
                Write(cond.Else, mode, sb);
                sb.Append(')');
                break;

            case CoalesceExpr co:
                sb.Append('(');
                Write(co.Left, mode, sb);
                sb.Append(" ?? ");
                Write(co.Right, mode, sb);
                sb.Append(')');
                break;

            case MemberAccessExpr ma:
                WriteMemberAccess(ma, mode, sb);
                break;

            case CallExpr call:
                WriteCall(call, mode, sb);
                break;

            case MatchExpr m:
                // raw matches /pat/  ->  Regex.IsMatch(raw, @"pat")
                sb.Append("Regex.IsMatch(");
                Write(m.Target, mode, sb);
                sb.Append(", @\"").Append(m.Pattern.Replace("\"", "\"\"")).Append("\")");
                break;

            case GuardExpr g:
                // A bare GuardExpr translates to its body; the guard condition is
                // handled by the invariant emitter. Fall back to body only.
                Write(g.Body, mode, sb);
                break;

            default:
                sb.Append("/* unsupported expression */");
                break;
        }
    }

    private void WriteIdentifier(string name, NameMode mode, StringBuilder sb, string? enumHint = null)
    {
        // Lambda parameter: rendered verbatim (escaped if a C# keyword).
        if (_locals.Contains(name))
        {
            sb.Append(CSharpNaming.ToCamelCase(name));
            return;
        }

        // `now` built-in (unless shadowed by a real member).
        if (name == "now" && !_memberNames.Contains(name))
        {
            sb.Append("DateTimeOffset.UtcNow");
            return;
        }

        // Enum member reference -> qualify as EnumName.Member, resolving a shared
        // member against the comparison context (enumHint) or the expected enum
        // type of the surrounding expression, when available.
        if (!_memberNames.Contains(name))
        {
            var owners = _index.EnumsDeclaring(name);
            if (owners.Count > 0)
            {
                var hint = enumHint ?? _expectedEnum;
                var enumType = hint is not null && owners.Contains(hint)
                    ? hint
                    : owners.Count == 1
                        ? owners[0]
                        : _enumMemberToType.TryGetValue(name, out var fallback) ? fallback : owners[0];
                sb.Append(enumType).Append('.').Append(name);
                return;
            }
        }

        if (_memberNames.Contains(name))
        {
            sb.Append(mode == NameMode.Parameter
                ? CSharpNaming.ToCamelCase(name)
                : CSharpNaming.ToPascalCase(name));
            return;
        }

        // Unknown identifier: emit as-is (best effort).
        sb.Append(name);
    }

    private void WriteMemberAccess(MemberAccessExpr ma, NameMode mode, StringBuilder sb)
    {
        var t = Render(ma.Target, mode);
        switch (ma.MemberName)
        {
            // Collection ops.
            case "isEmpty": sb.Append(t).Append(".Count == 0"); return;
            case "isNotEmpty": sb.Append(t).Append(".Count != 0"); return;
            case "count": sb.Append(t).Append(".Count"); return;
            // String ops.
            case "length": sb.Append(t).Append(".Length"); return;
            case "trim": sb.Append(t).Append(".Trim()"); return;
            case "lower": sb.Append(t).Append(".ToLowerInvariant()"); return;
            case "upper": sb.Append(t).Append(".ToUpperInvariant()"); return;
            case "isBlank": sb.Append("string.IsNullOrWhiteSpace(").Append(t).Append(')'); return;
            // Optional presence checks.
            case "isPresent": sb.Append(t).Append(" is not null"); return;
            case "isNone": sb.Append(t).Append(" is null"); return;
            // Plain field access.
            default: sb.Append(t).Append('.').Append(CSharpNaming.ToPascalCase(ma.MemberName)); return;
        }
    }

    private void WriteCall(CallExpr call, NameMode mode, StringBuilder sb)
    {
        var t = Render(call.Target, mode);
        var op = call.Method;

        switch (op)
        {
            // String / collection membership (both map to .Contains).
            case "startsWith": sb.Append(t).Append(".StartsWith(").Append(Render(call.Args[0], mode)).Append(')'); return;
            case "endsWith": sb.Append(t).Append(".EndsWith(").Append(Render(call.Args[0], mode)).Append(')'); return;
            case "contains": sb.Append(t).Append(".Contains(").Append(Render(call.Args[0], mode)).Append(')'); return;

            // Collection predicates / aggregations (lambda argument).
            case "all": sb.Append(t).Append(".All(").Append(RenderLambda(call, mode)).Append(')'); return;
            case "any": sb.Append(t).Append(".Any(").Append(RenderLambda(call, mode)).Append(')'); return;
            case "none": sb.Append('!').Append(t).Append(".Any(").Append(RenderLambda(call, mode)).Append(')'); return;
            case "min": sb.Append(t).Append(".Min(").Append(RenderLambda(call, mode)).Append(')'); return;
            case "max": sb.Append(t).Append(".Max(").Append(RenderLambda(call, mode)).Append(')'); return;
            case "sum": WriteSum(call, t, mode, sb); return;
            case "distinctBy":
                // "all distinct by the selector": count of distinct keys equals count.
                sb.Append(t).Append(".Select(").Append(RenderLambda(call, mode))
                  .Append(").Distinct().Count() == ").Append(t).Append(".Count");
                return;

            default:
                sb.Append("/* unsupported call '").Append(op).Append("' */");
                return;
        }
    }

    private void WriteSum(CallExpr call, string target, NameMode mode, StringBuilder sb)
    {
        // Numeric selector -> LINQ Sum (returns 0 for an empty sequence).
        // Value-object selector -> fold with the generated operator+. NOTE: a value
        // object has no identity/zero element, so this fold throws on an EMPTY
        // collection (unlike numeric Sum). Until Koine models a zero (roadmap R9),
        // sum over a possibly-empty value-object collection is the caller's concern.
        var selectorType = InferSelectorType(call);
        if (_resolver.IsValueLike(selectorType))
            sb.Append(target).Append(".Select(").Append(RenderLambda(call, mode))
              .Append(").Aggregate((a, b) => a + b)");
        else
            sb.Append(target).Append(".Sum(").Append(RenderLambda(call, mode)).Append(')');
    }

    /// <summary>The inferred type a collection call's lambda selector produces.</summary>
    private TypeRef? InferSelectorType(CallExpr call)
    {
        var element = TypeResolver.ElementOf(_resolver.Infer(call.Target, _scope));
        if (element is not null && call.Args is [LambdaExpr lambda])
            return _resolver.Infer(lambda.Body, _scope.With(lambda.Parameter, element));
        return null;
    }

    private string RenderLambda(CallExpr call, NameMode mode)
    {
        if (call.Args is not [LambdaExpr lambda])
            return "/* expected lambda */";

        // Save/restore: a lambda parameter that shadows an outer local (e.g. a
        // command parameter of the same name) must not delete the outer binding.
        var wasPresent = _locals.Contains(lambda.Parameter);
        _locals.Add(lambda.Parameter);
        var body = Render(lambda.Body, mode);
        if (!wasPresent) _locals.Remove(lambda.Parameter);
        return $"{CSharpNaming.ToCamelCase(lambda.Parameter)} => {body}";
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
                sb.Append(lit.Text).Append('m');
                break;
            case LiteralKind.String:
                sb.Append('"').Append(EscapeString(lit.Text)).Append('"');
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
