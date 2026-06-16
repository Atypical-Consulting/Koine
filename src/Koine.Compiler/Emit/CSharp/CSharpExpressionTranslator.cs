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

    // Local names currently in scope (lambda parameters, command/factory parameters):
    // rendered verbatim (camelCase, escaped) rather than as members.
    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);

    // Declared types of locals (when known), so type-directed emission (e.g. choosing
    // a value-object `sum` fold over a numeric Sum) can resolve a parameter's element
    // type — the member-only _scope does not know about command/factory parameters.
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);

    /// <summary>Registers a local (e.g. a command/factory parameter) for the body about to be translated.</summary>
    public void PushLocal(string name, TypeRef? type = null)
    {
        _locals.Add(name);
        if (type is not null)
            _localTypes[name] = type;
    }

    /// <summary>Removes a previously-registered local.</summary>
    public void PopLocal(string name)
    {
        _locals.Remove(name);
        _localTypes.Remove(name);
    }

    /// <summary>The member scope extended with any known local (parameter) types.</summary>
    private TypeScope EffectiveScope()
    {
        var scope = _scope;
        foreach (var kv in _localTypes)
            scope = scope.With(kv.Key, kv.Value);
        return scope;
    }

    // The enum type the whole expression is expected to produce (a derived/default
    // member of enum type). Used to qualify a bare shared enum member in positions
    // a comparison hint doesn't reach (conditional/coalesce branches, a bare value).
    private string? _expectedEnum;

    // Spec bodies referenceable by name in the current target type (R10.1); a bare
    // reference to one is inlined (the spec is a named boolean expression).
    private readonly IReadOnlyDictionary<string, Expr> _specBodies;
    private readonly HashSet<string> _inliningSpecs = new(StringComparer.Ordinal);

    // When set, member identifiers render as `<receiver>.Member` (used inside the
    // generated static specification methods, where members hang off a parameter `x`).
    private readonly string? _memberReceiver;

    // Monotonic counter giving each emitted value-object `sum` fold a unique pattern
    // binding name (`__sum0`, `__sum1`, …), so sibling folds in one expression never collide.
    private int _sumCounter;

    /// <param name="members">The members of the type being emitted.</param>
    /// <param name="enumMemberToType">Map from an enum member name to its owning enum type name.</param>
    /// <param name="specBodies">Spec name -&gt; body, for inlining spec references (R10.1).</param>
    /// <param name="memberReceiver">When set, members render as <c>receiver.Member</c>.</param>
    public CSharpExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        IReadOnlyDictionary<string, Expr>? specBodies = null,
        string? memberReceiver = null,
        string? context = null)
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _scope = TypeScope.FromMembers(members);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType;
        _specBodies = specBodies ?? EmptySpecs;
        _memberReceiver = memberReceiver;
    }

    private static readonly IReadOnlyDictionary<string, Expr> EmptySpecs = new Dictionary<string, Expr>();

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

    /// <summary>
    /// Renders the logical negation of a boolean condition idiomatically, for guard
    /// emission where the assertion's failure must be tested. A leading <c>!</c> is
    /// peeled (<c>!lines.isEmpty</c> → <c>Lines.Count == 0</c>), a top-level comparison
    /// has its operator flipped (<c>amount &gt;= 0</c> → <c>amount &lt; 0</c>), and only a
    /// compound/other expression falls back to wrapping in <c>!(...)</c>. This avoids the
    /// double negations and redundant wrappers a blanket <c>!(...)</c> would produce.
    /// </summary>
    public string TranslateNegated(Expr expr, NameMode mode, string? expectedEnum = null)
    {
        _expectedEnum = expectedEnum;
        var sb = new StringBuilder();
        WriteNegated(expr, mode, sb);
        _expectedEnum = null;
        return sb.ToString();
    }

    private void WriteNegated(Expr expr, NameMode mode, StringBuilder sb)
    {
        switch (expr)
        {
            // !(X)  ->  X   (peel the negation rather than stacking a second one).
            case UnaryExpr { Op: UnaryOp.Not } un:
                WriteTopLevel(un.Operand, mode, sb);
                break;

            // a <cmp> b  ->  a <flipped cmp> b   (flip rather than wrap in !(...)).
            case BinaryExpr bin when Flip(bin.Op) is { } flipped:
                WriteOperand(bin.Left, mode, sb, EnumTypeName(bin.Right));
                sb.Append(' ').Append(flipped).Append(' ');
                WriteOperand(bin.Right, mode, sb, EnumTypeName(bin.Left));
                break;

            // `cond ? true : false` => `!(cond)`; `cond ? false : true` => `cond`.
            case ConditionalExpr c when TryBoolLiterals(c, out var whenTrue):
                if (whenTrue)
                {
                    sb.Append("!(");
                    Write(c.Condition, mode, sb);
                    sb.Append(')');
                }
                else
                {
                    WriteTopLevel(c.Condition, mode, sb);
                }
                break;

            // Compound (&&/||) or anything else: negate by wrapping once.
            default:
                sb.Append("!(");
                WriteTopLevel(expr, mode, sb);
                sb.Append(')');
                break;
        }
    }

    /// <summary>The negated form of a comparison operator, or <c>null</c> for a non-comparison.</summary>
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

    /// <summary>Renders an expression in a parenthesized position, omitting the outer parens a top-level binary operator would add.</summary>
    private void WriteTopLevel(Expr expr, NameMode mode, StringBuilder sb)
    {
        if (expr is BinaryExpr bin)
        {
            WriteBinaryChild(bin.Left, mode, sb, EnumTypeName(bin.Right), bin.Op, rightOperand: false);
            sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
            WriteBinaryChild(bin.Right, mode, sb, EnumTypeName(bin.Left), bin.Op, rightOperand: true);
        }
        else
        {
            Write(expr, mode, sb);
        }
    }

    /// <summary>
    /// Renders one operand of a binary expression, parenthesizing a nested binary
    /// child only when C# precedence/associativity actually requires it. A
    /// higher-precedence child (e.g. <c>&gt;</c> under <c>||</c>) and a same-precedence
    /// left child of a left-associative operator (e.g. <c>a + b</c> under <c>+ c</c>)
    /// drop their redundant parens, flattening associative chains.
    /// </summary>
    private void WriteBinaryChild(Expr expr, NameMode mode, StringBuilder sb, string? enumHint, BinaryOp parentOp, bool rightOperand)
    {
        if (expr is BinaryExpr child && !NeedsParens(child.Op, parentOp, rightOperand))
        {
            // Render the child binary without its own wrapping parens (recurse top-level).
            WriteBinaryChild(child.Left, mode, sb, EnumTypeName(child.Right), child.Op, rightOperand: false);
            sb.Append(' ').Append(OperatorOf(child.Op)).Append(' ');
            WriteBinaryChild(child.Right, mode, sb, EnumTypeName(child.Left), child.Op, rightOperand: true);
            return;
        }
        WriteOperand(expr, mode, sb, enumHint);
    }

    /// <summary>
    /// True when a nested binary <paramref name="childOp"/> must be parenthesized inside
    /// a parent binary <paramref name="parentOp"/>. A strictly lower-precedence child
    /// always needs parens; a same-precedence child needs them only as the right operand
    /// of a left-associative operator (to preserve the original grouping).
    /// </summary>
    private static bool NeedsParens(BinaryOp childOp, BinaryOp parentOp, bool rightOperand)
    {
        var childPrec = Precedence(childOp);
        var parentPrec = Precedence(parentOp);
        if (childPrec < parentPrec)
            return true;
        // Equal precedence: all C# binary operators here are left-associative, so the
        // right operand keeps parens (a - (b - c) != a - b - c), the left drops them.
        return childPrec == parentPrec && rightOperand;
    }

    /// <summary>C# binary-operator precedence tiers (higher binds tighter), for redundant-paren elision.</summary>
    private static int Precedence(BinaryOp op) => op switch
    {
        BinaryOp.Or => 1,
        BinaryOp.And => 2,
        BinaryOp.Eq or BinaryOp.Neq => 3,
        BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge => 4,
        BinaryOp.Add or BinaryOp.Sub => 5,
        BinaryOp.Mul or BinaryOp.Div => 6,
        _ => 0
    };

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
                // Keep the outer parens (this node may be embedded in a unary/conditional
                // operand) but elide redundant inner parens within associative chains.
                sb.Append('(');
                WriteBinaryChild(bin.Left, mode, sb, EnumTypeName(bin.Right), bin.Op, rightOperand: false);
                sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
                WriteBinaryChild(bin.Right, mode, sb, EnumTypeName(bin.Left), bin.Op, rightOperand: true);
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
            // A receiver (the static-spec `x`) makes members property accesses on it.
            if (_memberReceiver is not null)
                sb.Append(_memberReceiver).Append('.').Append(CSharpNaming.ToPascalCase(name));
            else
                sb.Append(mode == NameMode.Parameter
                    ? CSharpNaming.ToCamelCase(name)
                    : CSharpNaming.ToPascalCase(name));
            return;
        }

        // A spec reference (R10.1): inline its body, recursively, in the current mode.
        // Cycle detection at validation time guarantees this terminates.
        if (_specBodies.TryGetValue(name, out var specBody) && _inliningSpecs.Add(name))
        {
            sb.Append('(');
            Write(specBody, mode, sb);
            sb.Append(')');
            _inliningSpecs.Remove(name);
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
        // Value-object selector -> fold with the generated operator+. A value object
        // has no identity/zero element, so an EMPTY collection cannot fold; rather than
        // leak LINQ's opaque "Sequence contains no elements" InvalidOperationException,
        // we guard the fold and throw a DomainInvariantViolationException with a clear
        // message. (Until Koine models a zero — roadmap R9 — there is no neutral seed.)
        var selectorType = InferSelectorType(call);
        if (_resolver.IsValueLike(selectorType))
        {
            // Materialize the projection, then guard emptiness with a list pattern: a
            // non-empty list folds with the generated operator+ (over NON-nullable elements,
            // so no nullable warnings), while an empty list throws a clear domain error
            // rather than leaking LINQ's opaque "Sequence contains no elements".
            // The whole thing is parenthesized so the low-precedence `throw`/`?:` stays
            // self-contained when this sum is embedded in a larger expression.
            var voName = selectorType!.Name;
            var rule = $"cannot sum an empty collection of {voName} (no zero value)";
            // Unique binding name so sibling sums in one expression never collide.
            var bind = "__sum" + _sumCounter++;
            sb.Append('(').Append(target).Append(".Select(").Append(RenderLambda(call, mode))
              .Append(").ToList() is { Count: > 0 } ").Append(bind)
              .Append(" ? ").Append(bind).Append(".Aggregate((a, b) => a + b)")
              .Append(" : throw new DomainInvariantViolationException(type: \"")
              .Append(voName).Append("\", rule: \"").Append(rule).Append("\"))");
        }
        else
        {
            sb.Append(target).Append(".Sum(").Append(RenderLambda(call, mode)).Append(')');
        }
    }

    /// <summary>The inferred type a collection call's lambda selector produces.</summary>
    private TypeRef? InferSelectorType(CallExpr call)
    {
        var scope = EffectiveScope();
        var element = TypeResolver.ElementOf(_resolver.Infer(call.Target, scope));
        if (element is not null && call.Args is [LambdaExpr lambda])
            return _resolver.Infer(lambda.Body, scope.With(lambda.Parameter, element));
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
