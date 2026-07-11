using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Translates the target-agnostic <see cref="Expr"/> sublanguage into Kotlin 2.x expression source — the
/// Kotlin counterpart of the C#/Java/Rust/Python/TS translators. Used for invariants, <c>when</c> guards,
/// and derived-member bodies.
/// <para>
/// Kotlin is more permissive than Java here: <c>==</c> is value equality for every type (so <c>String</c>,
/// <c>Instant</c>, enums, and <c>data class</c> value objects compare structurally with no
/// <c>Objects.equals</c> ceremony), the elvis operator <c>?:</c> expresses coalesce directly, and <c>if</c>
/// is an expression. The <b>one</b> type-aware wrinkle is <c>java.math.BigDecimal</c>: its <c>==</c> is
/// scale-sensitive (<c>1.0 != 1.00</c>), so a <c>Decimal</c> comparison lowers to <c>a.compareTo(b) &lt;op&gt;
/// 0</c> — value equality, not <c>BigDecimal.equals</c> — and a <c>Decimal</c> against the int literal
/// <c>0</c> widens to <c>BigDecimal.ZERO</c>. Decimal arithmetic lowers to <c>.add</c>/<c>.subtract</c>/
/// <c>.multiply</c>/<c>.divide(…, DECIMAL128)</c> to control rounding, and value-object arithmetic lowers to
/// the demand-driven <c>plus</c>/<c>minus</c>/<c>times</c>/<c>div</c> methods the value-object slice emits.
/// </para>
/// <para>
/// Member identifiers render per <see cref="NameMode"/>: a bare <c>camelCase</c> name in
/// <see cref="NameMode.Parameter"/> (an <c>init</c>-block invariant, where the member is still the incoming
/// constructor parameter), or <c>&lt;receiver&gt;.name</c> in <see cref="NameMode.Property"/> (an entity
/// method / computed-property body). Unlike Java there are no accessor parentheses — Kotlin properties read
/// as <c>this.name</c>. JDK types are emitted fully qualified so the emitter needs no import bookkeeping.
/// </para>
/// </summary>
internal sealed class KotlinExpressionTranslator
{
    /// <summary>How a member identifier should be rendered.</summary>
    public enum NameMode
    {
        /// <summary><c>init</c>-block / invariant context: a member renders as its bare camelCase parameter.</summary>
        Parameter,

        /// <summary>Instance-body context (computed properties, entity methods): a member renders as <c>&lt;receiver&gt;.name</c>.</summary>
        Property
    }

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly KotlinTypeMapper _typeMapper;
    private readonly TypeScope _scope;
    private readonly ISet<string> _memberNames;
    private readonly IReadOnlyDictionary<string, string> _enumMemberToType;
    private readonly string _memberReceiver;

    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);

    private NameMode _mode = NameMode.Parameter;
    private string? _expectedEnum;

    /// <param name="index">The model index, used to classify/resolve type references.</param>
    /// <param name="members">The members of the type being emitted (the identifier scope).</param>
    /// <param name="typeMapper">The Kotlin type mapper (shared with the caller, over the same index).</param>
    /// <param name="context">The bounded context the expression is resolved within (null = global).</param>
    /// <param name="memberReceiver">The receiver members hang off in <see cref="NameMode.Property"/> (default <c>this</c>).</param>
    /// <param name="enumMemberToType">
    /// Optional map from an enum member name to its owning enum type, disambiguating a bare reference to a
    /// member shared across enums (defaults to empty).
    /// </param>
    public KotlinExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        KotlinTypeMapper typeMapper,
        string? context = null,
        string memberReceiver = "this",
        IReadOnlyDictionary<string, string>? enumMemberToType = null)
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _typeMapper = typeMapper;
        _memberReceiver = memberReceiver;
        _scope = TypeScope.FromMembers(members, index);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType ?? EmptyEnumMap;
    }

    private static readonly IReadOnlyDictionary<string, string> EmptyEnumMap =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>Registers a local (a lambda / command parameter, or a <c>let</c> binding) for the body about to be translated.</summary>
    public void PushLocal(string name, TypeRef? type = null)
    {
        _locals.Add(name);
        if (type is not null)
        {
            _localTypes[name] = type;
        }
    }

    /// <summary>Removes a previously-registered local.</summary>
    public void PopLocal(string name)
    {
        _locals.Remove(name);
        _localTypes.Remove(name);
    }

    /// <summary>The member scope extended with any known local (parameter/binding) types.</summary>
    private TypeScope EffectiveScope()
    {
        TypeScope scope = _scope;
        foreach (KeyValuePair<string, TypeRef> kv in _localTypes)
        {
            scope = scope.WithRef(kv.Key, kv.Value, _index);
        }

        return scope;
    }

    /// <summary>The semantic type an expression infers to in this type's scope (locals included).</summary>
    public TypeRef? InferType(Expr expr) => _resolver.Infer(expr, EffectiveScope());

    /// <summary>Translates an expression to a Kotlin expression string (no redundant outer parentheses).</summary>
    public string Translate(Expr expr, NameMode mode = NameMode.Parameter, string? expectedEnum = null)
    {
        NameMode prevMode = _mode;
        _mode = mode;
        _expectedEnum = expectedEnum;
        var sb = new StringBuilder();
        WriteTopLevel(expr, sb);
        _expectedEnum = null;
        _mode = prevMode;
        return sb.ToString();
    }

    // ------------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------------

    /// <summary>Renders an expression in a position that supplies its own delimiters — so a top-level binary omits its outer parentheses.</summary>
    private void WriteTopLevel(Expr expr, StringBuilder sb)
    {
        if (expr is BinaryExpr bin)
        {
            WriteBinaryInner(bin, sb);
            return;
        }

        Write(expr, sb);
    }

    /// <summary>Renders an expression that may be embedded in a larger one — a binary is wrapped in parentheses for safe precedence.</summary>
    private void Write(Expr expr, StringBuilder sb)
    {
        switch (expr)
        {
            case IdentifierExpr id:
                WriteIdentifier(id.Name, sb, null);
                break;
            case LiteralExpr lit:
                WriteLiteral(lit, sb);
                break;
            case BinaryExpr bin:
                sb.Append('(');
                WriteBinaryInner(bin, sb);
                sb.Append(')');
                break;
            case UnaryExpr un:
                WriteUnary(un, sb);
                break;
            case ConditionalExpr cond:
                // Kotlin `if` is an expression: `if (c) a else b`.
                sb.Append("if (");
                WriteTopLevel(cond.Condition, sb);
                sb.Append(") ");
                WriteReconciledBranch(cond.Then, cond.Else, sb);
                sb.Append(" else ");
                WriteReconciledBranch(cond.Else, cond.Then, sb);
                break;
            case CoalesceExpr co:
                // The left is nullable (T?); Koine `l ?? r` -> Kotlin elvis `l ?: r`, yielding the non-null T.
                WriteAtom(co.Left, sb);
                sb.Append(" ?: ");
                Write(co.Right, sb);
                break;
            case MemberAccessExpr ma:
                WriteMemberAccess(ma, sb);
                break;
            case CallExpr call:
                WriteCall(call, sb);
                break;
            case MatchExpr m:
                WriteMatch(m, sb);
                break;
            case GuardExpr g:
                // A bare guard translates to its body; the guard condition is emitted by the invariant emitter.
                Write(g.Body, sb);
                break;
            case LetExpr let:
                WriteLet(let, sb);
                break;
            default:
                sb.Append("/* unsupported expression */ false");
                break;
        }
    }

    private void WriteUnary(UnaryExpr un, StringBuilder sb)
    {
        // A Decimal literal lowers to `java.math.BigDecimal("…")`, a reference type Kotlin has no unary `-`
        // for. Fold the sign into the literal string so `-273.15` emits `java.math.BigDecimal("-273.15")`.
        if (un.Op == UnaryOp.Negate && un.Operand is LiteralExpr { Kind: LiteralKind.Decimal } dlit)
        {
            sb.Append("java.math.BigDecimal(\"-").Append(EscapeKotlinString(dlit.Text)).Append("\")");
            return;
        }

        sb.Append(un.Op == UnaryOp.Not ? '!' : '-');
        WriteAtom(un.Operand, sb);
    }

    /// <summary>
    /// Writes one <c>if</c>/<c>else</c> branch, reconciling it against its SIBLING branch's type so both
    /// arms agree — Koine's semantic validator (and <see cref="TypeResolver"/>, #975) legitimately lets a
    /// conditional's two branches differ in numeric type (<c>Int</c>/<c>Decimal</c>) and/or optionality,
    /// widening the conditional's own joined type accordingly, but Kotlin's <c>if</c>-expression (like
    /// Java's ternary, which this method mirrors) infers a least-upper-bound type across both arms: an
    /// unreconciled <c>Long</c>/<c>BigDecimal</c> pair infers an unhelpful common supertype that does not
    /// assign to the target <c>BigDecimal</c> member — a real <c>kotlinc</c> type-mismatch (#1344). A
    /// branch is <c>java.math.BigDecimal.valueOf(...)</c>-widened when its own inferred type is a
    /// non-optional <c>Int</c> (<c>Long</c>) while the SIBLING branch is <c>Decimal</c>, and
    /// null-safe-map-widened (<c>?.let { java.math.BigDecimal.valueOf(it) }</c>) when its own inferred type
    /// is an OPTIONAL <c>Int</c> while the SIBLING branch is <c>Decimal</c> — the branch's own rendering is
    /// already <c>Long?</c>-shaped, so a bare <c>BigDecimal.valueOf(...)</c> wrap around a nullable receiver
    /// does not compile; mapping inside the nullable chain is required instead. <c>NeedsWiden</c> and
    /// <c>NeedsOptionalWiden</c> are mutually exclusive (they key off the same branch's own optionality).
    /// <b>Unlike Java/Rust, Kotlin needs no <c>NeedsSomeWrap</c> analogue</b>: Kotlin's <c>if</c>-expression
    /// least-upper-bound computation already infers <c>T?</c> when one arm is <c>T</c> and the sibling arm
    /// is <c>T?</c> of the SAME underlying type (after any widen above) — a plain non-nullable <c>T</c> is
    /// directly assignable wherever <c>T?</c> is expected, so an optionality-only mismatch (or a widen
    /// composed with a sibling-optional mismatch, e.g. the <c>Cash</c> fixture in
    /// <c>KotlinConformanceTests</c>) needs no extra wrap on either arm — confirmed by the accompanying
    /// conformance tests compiling with a real <c>kotlinc</c> when available. The DECISION — which
    /// dimensions apply — is the shared, cross-target <see cref="BranchReconciliation.Classify"/> (#1368);
    /// only the Kotlin RENDERING below is local (Kotlin simply ignores the classifier's
    /// <see cref="BranchReconciliation.NeedsSomeWrap"/>, having no optional-lift to emit).
    /// </summary>
    private void WriteReconciledBranch(Expr branch, Expr sibling, StringBuilder sb)
    {
        TypeScope scope = EffectiveScope();
        TypeRef? branchType = _resolver.Infer(branch, scope);
        TypeRef? siblingType = _resolver.Infer(sibling, scope);
        BranchReconciliation needs = BranchReconciliation.Classify(branchType, siblingType);

        if (needs.NeedsWiden)
        {
            // Reuses the same BigDecimal-position widening WriteBinary already applies to a plain
            // arithmetic/comparison operand, so a literal `0` branch gets its BigDecimal.ZERO shortcut here
            // too, instead of a hand-rolled BigDecimal.valueOf(...) wrap drifting from that convention.
            WriteBigDecimalOperand(branch, branchType, sb);
            return;
        }

        if (needs.NeedsOptionalWiden)
        {
            WriteAtom(branch, sb);
            sb.Append("?.let { java.math.BigDecimal.valueOf(it) }");
            return;
        }

        Write(branch, sb);
    }

    /// <summary>Writes an operand as an atom: a compound (binary/conditional/coalesce) is parenthesized so it composes safely as a receiver or a unary/argument operand.</summary>
    private void WriteAtom(Expr expr, StringBuilder sb)
    {
        // A low-precedence Kotlin lowering (elvis `?:`, `if/else`, or a fold that lowers to `?: throw` / a
        // bare `==`) is NOT a tight atom, so it must be parenthesized to compose as a receiver, a unary
        // operand, or an argument that a surrounding operator would otherwise mis-group.
        if (!IsLowPrecedence(expr) && expr is IdentifierExpr or LiteralExpr or MemberAccessExpr or CallExpr or MatchExpr)
        {
            Write(expr, sb);
        }
        else
        {
            sb.Append('(');
            WriteTopLevel(expr, sb);
            sb.Append(')');
        }
    }

    /// <summary>
    /// True when an expression LOWERS to a Kotlin form looser than a postfix/method-call term — a coalesce
    /// (elvis <c>?:</c>), a conditional (<c>if … else …</c>), or a collection fold whose lowering carries a
    /// top-level <c>?: throw</c> (<c>min</c>/<c>max</c>/a value-object <c>sum</c>) or a bare <c>==</c>
    /// (<c>distinctBy</c>). Such a form must be parenthesized when it appears as a sub-expression, or the
    /// surrounding operator mis-groups (e.g. <c>a ?: 1 * b</c> parses as <c>a ?: (1 * b)</c>). Java is
    /// unaffected because it lowers these to tight postfix calls (<c>.orElse(…)</c>, <c>.orElseThrow(…)</c>).
    /// </summary>
    private static bool IsLowPrecedence(Expr expr) => expr switch
    {
        CoalesceExpr => true,
        ConditionalExpr => true,
        CallExpr { Method: "min" or "max" or "sum" or "distinctBy" } => true,
        _ => false,
    };

    // ------------------------------------------------------------------------
    // Binary operators — the (mostly Decimal-only) type-aware core
    // ------------------------------------------------------------------------

    /// <summary>Renders a binary expression without its own outer parentheses, choosing operator or method form from the operand types.</summary>
    private void WriteBinaryInner(BinaryExpr bin, StringBuilder sb)
    {
        TypeScope scope = EffectiveScope();
        TypeRef? leftType = _resolver.Infer(bin.Left, scope);
        TypeRef? rightType = _resolver.Infer(bin.Right, scope);

        var isDecimal = leftType?.Name == "Decimal" || rightType?.Name == "Decimal";
        var isInstant = leftType?.Name == "Instant" || rightType?.Name == "Instant";

        // (0) Value-object arithmetic — lowers to the demand-driven method (plus/minus/times/div) the
        // value-object slice emits, so `unitPrice * quantity` becomes `unitPrice.times(quantity)`. Checked
        // first: a `value-object * decimal` must NOT be mistaken for Decimal arithmetic below. Comparisons
        // on a value object still fall through to structural `==` (case 3).
        if (IsArithmetic(bin.Op) && TryWriteValueObjectArithmetic(bin, leftType, rightType, sb))
        {
            return;
        }

        // (1) Decimal comparison (incl. equality) -> compareTo. Value equality via `compareTo == 0`, not the
        // scale-sensitive BigDecimal.equals; ordering via the same form for a uniform, mixed-operand-safe shape.
        if (isDecimal && IsComparison(bin.Op))
        {
            WriteBigDecimalOperand(bin.Left, leftType, sb);
            sb.Append(".compareTo(");
            WriteBigDecimalOperand(bin.Right, rightType, sb);
            sb.Append(") ").Append(ComparisonSymbol(bin.Op)).Append(" 0");
            return;
        }

        // (2) Instant ordering -> compareTo (equality falls through to structural `==` below).
        if (isInstant && IsOrdering(bin.Op))
        {
            WriteAtom(bin.Left, sb);
            sb.Append(".compareTo(");
            WriteTopLevel(bin.Right, sb);
            sb.Append(") ").Append(ComparisonSymbol(bin.Op)).Append(" 0");
            return;
        }

        // (3) Decimal arithmetic -> add/subtract/multiply/divide. A bare `BigDecimal.divide(x)` throws on a
        // non-terminating quotient (e.g. 10/3), so a Decimal `/` passes MathContext.DECIMAL128 — matching the
        // value-object slice's `div` lowering and the #879 division parity.
        if (isDecimal && IsArithmetic(bin.Op))
        {
            WriteBigDecimalOperand(bin.Left, leftType, sb);
            sb.Append('.').Append(DecimalMethod(bin.Op)).Append('(');
            WriteBigDecimalOperand(bin.Right, rightType, sb);
            if (bin.Op == BinaryOp.Div)
            {
                sb.Append(", java.math.MathContext.DECIMAL128");
            }

            sb.Append(')');
            return;
        }

        // (4) Plain Kotlin infix: Long/Boolean arithmetic & comparison, structural ==/!= (value equality for
        // every non-Decimal type — String, Instant, enums, value objects, primitives), logical &&/||, and
        // String concatenation (`+`). Redundant inner parens are elided by precedence.
        WriteBinaryChild(bin.Left, bin.Op, rightOperand: false, sb);
        sb.Append(' ').Append(PlainSymbol(bin.Op)).Append(' ');
        WriteBinaryChild(bin.Right, bin.Op, rightOperand: true, sb);
    }

    /// <summary>
    /// Lowers value-object arithmetic to the demand-driven method the value-object slice emits, returning
    /// <c>true</c> when it handled the operator: <c>value-object + value-object</c> → <c>a.plus(b)</c>,
    /// <c>value-object - value-object</c> → <c>a.minus(b)</c>, <c>value-object * scalar</c> /
    /// <c>scalar * value-object</c> → <c>vo.times(scalar)</c>, and <c>value-object / scalar</c> →
    /// <c>vo.div(scalar)</c>. Explicit method calls (not infix operators) sidestep Kotlin operator resolution
    /// for the commutative/mixed cases. Returns <c>false</c> (leaving the caller to its primitive/Decimal
    /// lowering) when no operand is a value object.
    /// </summary>
    private bool TryWriteValueObjectArithmetic(BinaryExpr bin, TypeRef? leftType, TypeRef? rightType, StringBuilder sb)
    {
        var leftVo = IsValueObject(leftType);
        var rightVo = IsValueObject(rightType);
        if (!leftVo && !rightVo)
        {
            return false;
        }

        // Additive `+`/`-`: both operands are the same value object; the method is called on the left.
        if (bin.Op is BinaryOp.Add or BinaryOp.Sub && leftVo)
        {
            WriteAtom(bin.Left, sb);
            sb.Append('.').Append(bin.Op == BinaryOp.Add ? "plus" : "minus").Append('(');
            WriteTopLevel(bin.Right, sb);
            sb.Append(')');
            return true;
        }

        // Scalar `*` (commutative): the value object is the receiver, the scalar the argument.
        if (bin.Op == BinaryOp.Mul && leftVo != rightVo)
        {
            var (voExpr, scalarExpr) = leftVo ? (bin.Left, bin.Right) : (bin.Right, bin.Left);
            WriteAtom(voExpr, sb);
            sb.Append(".times(");
            WriteTopLevel(scalarExpr, sb);
            sb.Append(')');
            return true;
        }

        // Scalar `/`: only `value-object / scalar` (the value object on the left) is a meaningful scale-down.
        if (bin.Op == BinaryOp.Div && leftVo && !rightVo)
        {
            WriteAtom(bin.Left, sb);
            sb.Append(".div(");
            WriteTopLevel(bin.Right, sb);
            sb.Append(')');
            return true;
        }

        return false;
    }

    /// <summary>True when a type classifies as a Koine value object (so its arithmetic lowers to a method call).</summary>
    private bool IsValueObject(TypeRef? type) => type is not null && _index.Classify(type.Name) == TypeKind.Value;

    /// <summary>Renders one operand of a plain-infix binary, dropping the redundant parentheses precedence/associativity does not require.</summary>
    private void WriteBinaryChild(Expr expr, BinaryOp parentOp, bool rightOperand, StringBuilder sb)
    {
        if (expr is BinaryExpr child && !NeedsParens(child.Op, parentOp, rightOperand))
        {
            WriteBinaryInner(child, sb);
            return;
        }

        // A low-precedence lowering (elvis / if-else / a `?: throw` or `==` fold) as a binary operand must be
        // parenthesized, or the surrounding operator swallows part of it (`a ?: 1 * b`, `if (c) a else b * c`).
        if (IsLowPrecedence(expr))
        {
            sb.Append('(');
            WriteTopLevel(expr, sb);
            sb.Append(')');
            return;
        }

        Write(expr, sb);
    }

    /// <summary>
    /// Writes an operand in a <c>BigDecimal</c> position (a <c>compareTo</c>/arithmetic receiver or argument):
    /// an int literal becomes <c>BigDecimal.ZERO</c> (for <c>0</c>) or <c>BigDecimal.valueOf(nL)</c>; a
    /// non-Decimal numeric expression is widened via <c>BigDecimal.valueOf(expr)</c>; an already-Decimal
    /// operand renders as an atom.
    /// </summary>
    private void WriteBigDecimalOperand(Expr expr, TypeRef? type, StringBuilder sb)
    {
        if (expr is LiteralExpr { Kind: LiteralKind.Int } lit)
        {
            sb.Append(lit.Text == "0"
                ? "java.math.BigDecimal.ZERO"
                : "java.math.BigDecimal.valueOf(" + lit.Text + "L)");
            return;
        }

        if (type?.Name == "Decimal")
        {
            WriteAtom(expr, sb);
            return;
        }

        // A non-Decimal numeric operand (a Koine `Int` -> Long): widen it to BigDecimal.
        sb.Append("java.math.BigDecimal.valueOf(");
        WriteTopLevel(expr, sb);
        sb.Append(')');
    }

    // ------------------------------------------------------------------------
    // Identifiers, members, calls, literals, matches, let
    // ------------------------------------------------------------------------

    private void WriteIdentifier(string name, StringBuilder sb, string? enumHint)
    {
        // (1) A local (lambda / command / factory parameter, or a `let` binding): verbatim camelCase.
        if (_locals.Contains(name))
        {
            sb.Append(KotlinNaming.ToMemberName(name));
            return;
        }

        // (2) A nullary value builtin such as `now` (unless shadowed by a real member).
        if (name == "now" && BuiltinOps.IsNullaryValueOp(name) && !_memberNames.Contains(name))
        {
            sb.Append("java.time.Instant.now()");
            return;
        }

        // (3) An enum member reference -> EnumType.Member.
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
                sb.Append(KotlinNaming.ToTypeName(enumType)).Append('.').Append(KotlinNaming.EscapeIdentifier(name));
                return;
            }
        }

        // (4) A member of the enclosing type: `<receiver>.name` in a body, bare `name` in an init-block/invariant.
        if (_memberNames.Contains(name))
        {
            if (_mode == NameMode.Property)
            {
                sb.Append(_memberReceiver).Append('.').Append(KotlinNaming.ToMemberName(name));
            }
            else
            {
                sb.Append(KotlinNaming.ToMemberName(name));
            }

            return;
        }

        // (5) A bare enum *type* reference (the qualifier of `OrderStatus.Draft`).
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(KotlinNaming.ToTypeName(name));
            return;
        }

        // (6) Unknown identifier (includes the `null` literal): emit as written.
        sb.Append(name);
    }

    private void WriteMemberAccess(MemberAccessExpr ma, StringBuilder sb)
    {
        // Qualified enum-member access: `OrderStatus.Cancelled` -> `OrderStatus.Cancelled`.
        if (ma.Target is IdentifierExpr qualifier && !_memberNames.Contains(qualifier.Name)
            && !_locals.Contains(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(KotlinNaming.ToTypeName(qualifier.Name)).Append('.').Append(KotlinNaming.EscapeIdentifier(ma.MemberName));
            return;
        }

        TypeRef? targetType = _resolver.Infer(ma.Target, EffectiveScope());
        var target = new StringBuilder();
        WriteAtom(ma.Target, target);
        var t = target.ToString();

        // A user type that declares a member named after a built-in member-op (count/length/trim/…) shadows
        // the op shortcut — read it as a property instead of dispatching by name only. Without this a domain
        // field named e.g. `count` would emit `.size`, a property the emitted type lacks (the C# #605/#672 guard).
        if (targetType is not null
            && _index.TryGetMemberType(targetType.Qualifier ?? _resolver.Context, targetType.Name, ma.MemberName, out _))
        {
            sb.Append(t).Append('.').Append(KotlinNaming.ToMemberName(ma.MemberName));
            return;
        }

        switch (ma.MemberName)
        {
            case "isEmpty":
                sb.Append(t).Append(".isEmpty()");
                return;
            case "isNotEmpty":
                sb.Append(t).Append(".isNotEmpty()");
                return;
            case "count":
                // Collection size; widen to Long so it composes with Koine `Int` (-> Long) arithmetic.
                sb.Append(t).Append(".size.toLong()");
                return;
            case "length":
                // String length; widen to Long for the same reason.
                sb.Append(t).Append(".length.toLong()");
                return;
            case "trim":
                sb.Append(t).Append(".trim()");
                return;
            case "lower":
                sb.Append(t).Append(".lowercase()");
                return;
            case "upper":
                sb.Append(t).Append(".uppercase()");
                return;
            case "isBlank":
                sb.Append(t).Append(".isBlank()");
                return;
            case "isPresent":
                sb.Append('(').Append(t).Append(" != null)");
                return;
            case "isNone":
            case "isAbsent":
                sb.Append('(').Append(t).Append(" == null)");
                return;
            default:
                // A property/derived-member access on another value: read it directly (Kotlin properties
                // have no accessor parentheses).
                sb.Append(t).Append('.').Append(KotlinNaming.ToMemberName(ma.MemberName));
                return;
        }
    }

    private void WriteCall(CallExpr call, StringBuilder sb)
    {
        var target = new StringBuilder();
        WriteAtom(call.Target, target);
        var t = target.ToString();

        switch (call.Method)
        {
            case "startsWith":
                sb.Append(t).Append(".startsWith(");
                WriteTopLevel(call.Args[0], sb);
                sb.Append(')');
                return;
            case "endsWith":
                sb.Append(t).Append(".endsWith(");
                WriteTopLevel(call.Args[0], sb);
                sb.Append(')');
                return;
            case "contains":
                sb.Append(t).Append(".contains(");
                WriteTopLevel(call.Args[0], sb);
                sb.Append(')');
                return;
            case "all":
                WriteQuantifier(call, t, "all", sb);
                return;
            case "any":
                WriteQuantifier(call, t, "any", sb);
                return;
            case "none":
                WriteQuantifier(call, t, "none", sb);
                return;
            case "distinctBy":
                // "all distinct by the selector": the distinct-by-key list has the same size as the source.
                // Kotlin's stdlib `distinctBy` keeps the first element per key, so equal sizes ⇔ no duplicates.
                sb.Append(t).Append(".distinctBy { ").Append(LambdaParam(call)).Append(" -> ");
                WriteLambdaBody(call, sb);
                sb.Append(" }.size == ").Append(t).Append(".size");
                return;
            case "sum":
                WriteSum(call, t, sb);
                return;
            case "min":
                WriteMinMax(call, t, sb, isMin: true);
                return;
            case "max":
                WriteMinMax(call, t, sb, isMin: false);
                return;
            default:
                sb.Append("/* unsupported call '").Append(call.Method).Append("' */ false");
                return;
        }
    }

    /// <summary>Renders an <c>all</c>/<c>any</c>/<c>none</c> quantifier as a Kotlin collection predicate: <c>xs.all { p -&gt; body }</c>.</summary>
    private void WriteQuantifier(CallExpr call, string target, string op, StringBuilder sb)
    {
        sb.Append(target).Append('.').Append(op).Append(" { ").Append(LambdaParam(call)).Append(" -> ");
        WriteLambdaBody(call, sb);
        sb.Append(" }");
    }

    /// <summary>
    /// Renders a <c>sum</c> fold: a value-object selector reduces with the value object's <c>plus</c> method
    /// (throwing a domain error on an empty collection, the seedless-fold contract), a Decimal selector folds
    /// from <c>BigDecimal.ZERO</c> with <c>add</c>, and a numeric selector uses <c>sumOf</c>.
    /// </summary>
    private void WriteSum(CallExpr call, string target, StringBuilder sb)
    {
        TypeRef? selector = InferSelectorType(call);
        if (selector is not null && _index.Classify(selector.Name) == TypeKind.Value)
        {
            sb.Append(target).Append(".map { ").Append(LambdaParam(call)).Append(" -> ");
            WriteLambdaBody(call, sb);
            sb.Append(" }.reduceOrNull { acc, e -> acc.plus(e) } ?: throw ")
              .Append("koine.runtime.DomainException(\"cannot sum an empty collection\")");
            return;
        }

        if (selector?.Name == "Decimal")
        {
            sb.Append(target).Append(".map { ").Append(LambdaParam(call)).Append(" -> ");
            WriteLambdaBody(call, sb);
            sb.Append(" }.fold(java.math.BigDecimal.ZERO) { acc, e -> acc.add(e) }");
            return;
        }

        sb.Append(target).Append(".sumOf { ").Append(LambdaParam(call)).Append(" -> ");
        WriteLambdaBody(call, sb);
        sb.Append(" }");
    }

    /// <summary>Renders a <c>min</c>/<c>max</c> fold as a Kotlin projection + <c>minOrNull</c>/<c>maxOrNull</c>, throwing a domain error on an empty collection.</summary>
    private void WriteMinMax(CallExpr call, string target, StringBuilder sb, bool isMin)
    {
        var op = isMin ? "min" : "max";
        sb.Append(target).Append(".map { ").Append(LambdaParam(call)).Append(" -> ");
        WriteLambdaBody(call, sb);
        sb.Append(" }.").Append(op).Append("OrNull() ?: throw koine.runtime.DomainException(\"cannot take ")
          .Append(op).Append(" of an empty collection\")");
    }

    /// <summary>The escaped Kotlin lambda parameter name for a collection-op call.</summary>
    private static string LambdaParam(CallExpr call) =>
        call.Args is [LambdaExpr lambda] ? KotlinNaming.ToMemberName(lambda.Parameter) : "x";

    /// <summary>Writes a lambda body with its parameter pushed as a local (the receiver's element type).</summary>
    private void WriteLambdaBody(CallExpr call, StringBuilder sb)
    {
        if (call.Args is not [LambdaExpr lambda])
        {
            sb.Append("false");
            return;
        }

        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, EffectiveScope()));
        var wasPresent = _locals.Contains(lambda.Parameter);
        var hadType = _localTypes.TryGetValue(lambda.Parameter, out TypeRef? priorType);
        PushLocal(lambda.Parameter, element);

        WriteTopLevel(lambda.Body, sb);

        if (!wasPresent)
        {
            PopLocal(lambda.Parameter);
        }
        else if (hadType)
        {
            _localTypes[lambda.Parameter] = priorType!;
        }
    }

    /// <summary>The inferred type a collection call's lambda selector produces (for choosing the sum fold shape).</summary>
    private TypeRef? InferSelectorType(CallExpr call)
    {
        TypeScope scope = EffectiveScope();
        TypeRef? element = TypeResolver.ElementOf(_resolver.Infer(call.Target, scope));
        if (element is not null && call.Args is [LambdaExpr lambda])
        {
            return _resolver.Infer(lambda.Body, scope.WithRef(lambda.Parameter, element, _index));
        }

        return null;
    }

    private void WriteMatch(MatchExpr m, StringBuilder sb)
    {
        // Unanchored find, matching the Java `.find()` / Rust `regex_is_match` / C# `Regex.IsMatch` semantics
        // — `Regex.containsMatchIn` is Kotlin's unanchored search (NOT `.matches()`, which is full-anchored),
        // so the Kotlin target stays semantically aligned with its siblings (cross-emitter parity).
        sb.Append("Regex(\"").Append(EscapeKotlinString(m.Pattern)).Append("\").containsMatchIn(");
        WriteTopLevel(m.Target, sb);
        sb.Append(')');
    }

    /// <summary>
    /// Lowers <c>let x = e (, y = e)* in body</c> to a Kotlin <c>run { }</c> block with <c>val</c> locals —
    /// Kotlin's <c>run</c> is an expression, so the bindings and body preserve evaluation order and scoping
    /// without the immediately-invoked-lambda ceremony Java needs.
    /// </summary>
    private void WriteLet(LetExpr let, StringBuilder sb)
    {
        sb.Append("run { ");

        var pushed = new List<string>();
        foreach (LetBinding b in let.Bindings)
        {
            sb.Append("val ").Append(KotlinNaming.ToMemberName(b.Name)).Append(" = ");
            WriteTopLevel(b.Value, sb);
            sb.Append("; ");
            PushLocal(b.Name, _resolver.Infer(b.Value, EffectiveScope()));
            pushed.Add(b.Name);
        }

        WriteTopLevel(let.Body, sb);
        sb.Append(" }");

        for (var i = pushed.Count - 1; i >= 0; i--)
        {
            PopLocal(pushed[i]);
        }
    }

    private static void WriteLiteral(LiteralExpr lit, StringBuilder sb)
    {
        switch (lit.Kind)
        {
            case LiteralKind.Int:
                // A Kotlin `Long` literal (the type Koine `Int` maps to), so an int constant assigns to a
                // Long member/parameter without an Int-not-assignable-to-Long error.
                sb.Append(lit.Text).Append('L');
                break;
            case LiteralKind.Bool:
                sb.Append(lit.Text == "true" ? "true" : "false");
                break;
            case LiteralKind.Decimal:
                sb.Append("java.math.BigDecimal(\"").Append(lit.Text).Append("\")");
                break;
            case LiteralKind.String:
                sb.Append('"').Append(EscapeKotlinString(lit.Text)).Append('"');
                break;
        }
    }

    // ------------------------------------------------------------------------
    // Operator classification & symbols
    // ------------------------------------------------------------------------

    private static bool IsEquality(BinaryOp op) => op is BinaryOp.Eq or BinaryOp.Neq;

    private static bool IsOrdering(BinaryOp op) => op is BinaryOp.Lt or BinaryOp.Le or BinaryOp.Gt or BinaryOp.Ge;

    private static bool IsComparison(BinaryOp op) => IsEquality(op) || IsOrdering(op);

    private static bool IsArithmetic(BinaryOp op) => op is BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div;

    /// <summary>The Kotlin infix symbol closing a <c>compareTo</c> comparison (<c>… &lt;sym&gt; 0</c>).</summary>
    private static string ComparisonSymbol(BinaryOp op) => op switch
    {
        BinaryOp.Eq => "==",
        BinaryOp.Neq => "!=",
        BinaryOp.Lt => "<",
        BinaryOp.Le => "<=",
        BinaryOp.Gt => ">",
        BinaryOp.Ge => ">=",
        _ => "?"
    };

    /// <summary>The <c>BigDecimal</c> method for a Decimal arithmetic operator.</summary>
    private static string DecimalMethod(BinaryOp op) => op switch
    {
        BinaryOp.Add => "add",
        BinaryOp.Sub => "subtract",
        BinaryOp.Mul => "multiply",
        BinaryOp.Div => "divide",
        _ => "add"
    };

    /// <summary>The plain Kotlin infix symbol for an operator emitted directly (primitives, logical, String concat, structural equality).</summary>
    private static string PlainSymbol(BinaryOp op) => op switch
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

    /// <summary>True when a nested plain-infix binary <paramref name="childOp"/> must be parenthesized inside a parent <paramref name="parentOp"/> (Kotlin precedence/associativity).</summary>
    private static bool NeedsParens(BinaryOp childOp, BinaryOp parentOp, bool rightOperand)
    {
        var childPrec = Precedence(childOp);
        var parentPrec = Precedence(parentOp);
        if (childPrec < parentPrec)
        {
            return true;
        }

        // Equal precedence: these operators are left-associative, so only the right operand keeps its parens.
        return childPrec == parentPrec && rightOperand;
    }

    /// <summary>Kotlin binary-operator precedence tiers (higher binds tighter), for redundant-paren elision.</summary>
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

    /// <summary>Escapes a raw string (a literal body or a regex pattern) for a Kotlin double-quoted string literal.</summary>
    private static string EscapeKotlinString(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '$': sb.Append("\\$"); break; // Kotlin string templates: `$` must be escaped in a literal.
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default: sb.Append(c); break;
            }
        }

        return sb.ToString();
    }
}
