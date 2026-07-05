using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Translates the target-agnostic <see cref="Expr"/> sublanguage into Java 17 expression source — the Java
/// counterpart of <see cref="CSharp.CSharpExpressionTranslator"/> and the Rust/Python/TS translators. Used
/// for invariants, <c>when</c> guards, and derived-member bodies.
/// <para>
/// The Java-specific crux is that <b>reference types carry no operators</b>. C# <c>decimal</c> and Rust
/// <c>Decimal</c> overload <c>+ - * / &lt; &gt; == …</c> directly, but Java's <c>java.math.BigDecimal</c>
/// does not — so this translator is <b>type-aware</b> (it infers each operand's <see cref="TypeRef"/> via a
/// <see cref="TypeResolver"/>) and lowers operators to method calls when an operand is a reference type:
/// </para>
/// <list type="bullet">
///   <item><c>Decimal</c> comparison → <c>a.compareTo(b) &lt;op&gt; 0</c> (equality is <c>== 0</c>/<c>!= 0</c> —
///   value equality, not scale-sensitive <c>BigDecimal.equals</c>). A <c>Decimal</c> against the int literal
///   <c>0</c> compares to <c>BigDecimal.ZERO</c>, other int literals to <c>BigDecimal.valueOf(n)</c>.</item>
///   <item><c>Decimal</c> arithmetic → <c>.add</c>/<c>.subtract</c>/<c>.multiply</c>/<c>.divide</c>; an int
///   operand opposite a Decimal is widened via <c>BigDecimal.valueOf(…)</c>.</item>
///   <item><c>Instant</c> ordering → <c>a.compareTo(b) &lt;op&gt; 0</c>; equality via <c>Objects.equals</c>.</item>
///   <item>Object equality (<c>String</c>, value objects, enums, …) → <c>Objects.equals(a, b)</c> /
///   <c>!Objects.equals(a, b)</c>; a comparison against the <c>null</c> literal stays reference
///   <c>==</c>/<c>!=</c> (correct in Java).</item>
///   <item><c>long</c>/<c>boolean</c> (Koine <c>Int</c>/<c>Bool</c>) → plain Java operators
///   <c>+ - * / &lt; &gt; &lt;= &gt;= == != &amp;&amp; || !</c>; <c>String</c> <c>+</c> stays Java concatenation.</item>
///   <item><c>matches /pat/</c> → an inline, dependency-free unanchored find:
///   <c>java.util.regex.Pattern.compile("pat").matcher(input).find()</c>.</item>
/// </list>
/// <para>
/// Member identifiers render per <see cref="NameMode"/>: a bare <c>camelCase</c> name in
/// <see cref="NameMode.Parameter"/> (a record's compact constructor / smart-constructor / invariant context,
/// where the member is still the incoming component parameter), or <c>&lt;receiver&gt;.name</c> in
/// <see cref="NameMode.Property"/> (an entity method / record accessor body). In property mode a component
/// read through its accessor appends <c>()</c> — controlled by <c>membersAsAccessors</c> (records, whose
/// components are private, read via accessors) or, for a stored-field receiver, only for a
/// <em>derived</em> (computed) member. Stdlib types are emitted fully qualified so the emitter needs no
/// import bookkeeping.
/// </para>
/// </summary>
internal sealed class JavaExpressionTranslator
{
    /// <summary>How a member identifier should be rendered.</summary>
    public enum NameMode
    {
        /// <summary>Compact-constructor / invariant context: a member renders as its bare camelCase parameter.</summary>
        Parameter,

        /// <summary>Instance-body context (accessors, entity methods): a member renders as <c>&lt;receiver&gt;.name</c>.</summary>
        Property
    }

    private readonly ModelIndex _index;
    private readonly TypeResolver _resolver;
    private readonly JavaTypeMapper _typeMapper;
    private readonly TypeScope _scope;
    private readonly ISet<string> _memberNames;
    private readonly IReadOnlyDictionary<string, string> _enumMemberToType;
    private readonly ISet<string> _derivedMembers;
    private readonly string _memberReceiver;
    private readonly bool _membersAsAccessors;

    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);

    private NameMode _mode = NameMode.Parameter;
    private string? _expectedEnum;

    /// <param name="index">The model index, used to classify/resolve type references.</param>
    /// <param name="members">The members of the type being emitted (the identifier scope).</param>
    /// <param name="typeMapper">The Java type mapper (shared with the caller, over the same index).</param>
    /// <param name="context">The bounded context the expression is resolved within (null = global).</param>
    /// <param name="memberReceiver">The receiver members hang off in <see cref="NameMode.Property"/> (default <c>this</c>).</param>
    /// <param name="membersAsAccessors">
    /// When <c>true</c>, every member read in property mode goes through its accessor method
    /// (<c>this.name()</c>) — the record case, where components are private. When <c>false</c>, a stored field
    /// reads directly (<c>this.name</c>) and only a derived (computed) member reads via its accessor — the
    /// entity case.
    /// </param>
    /// <param name="enumMemberToType">
    /// Optional map from an enum member name to its owning enum type, disambiguating a bare reference to a
    /// member shared across enums (defaults to empty).
    /// </param>
    public JavaExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        JavaTypeMapper typeMapper,
        string? context = null,
        string memberReceiver = "this",
        bool membersAsAccessors = false,
        IReadOnlyDictionary<string, string>? enumMemberToType = null)
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _typeMapper = typeMapper;
        _memberReceiver = memberReceiver;
        _membersAsAccessors = membersAsAccessors;
        _scope = TypeScope.FromMembers(members, index);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType ?? EmptyEnumMap;
        // A derived (computed) member emits as an accessor method, not a stored field, so a reference to one
        // in an instance body must render as a call `this.x()`, never a field read `this.x`.
        _derivedMembers = new HashSet<string>(
            members.Where(m => MemberAnalysis.IsDerived(m, _memberNames)).Select(m => m.Name),
            StringComparer.Ordinal);
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

    /// <summary>Translates an expression to a Java expression string (no redundant outer parentheses).</summary>
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
                sb.Append('(');
                WriteTopLevel(cond.Condition, sb);
                sb.Append(" ? ");
                Write(cond.Then, sb);
                sb.Append(" : ");
                Write(cond.Else, sb);
                sb.Append(')');
                break;
            case CoalesceExpr co:
                // The left is optional (Optional<T>); `l ?? r` -> `l.orElse(r)` yields the non-optional T.
                WriteAtom(co.Left, sb);
                sb.Append(".orElse(");
                WriteTopLevel(co.Right, sb);
                sb.Append(')');
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
        sb.Append(un.Op == UnaryOp.Not ? '!' : '-');
        WriteAtom(un.Operand, sb);
    }

    /// <summary>Writes an operand as an atom: a compound (binary/conditional/coalesce) is parenthesized so it composes safely as a receiver or a unary/argument operand.</summary>
    private void WriteAtom(Expr expr, StringBuilder sb)
    {
        if (expr is IdentifierExpr or LiteralExpr or MemberAccessExpr or CallExpr or MatchExpr)
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

    // ------------------------------------------------------------------------
    // Binary operators — the type-aware operator-vs-method core
    // ------------------------------------------------------------------------

    /// <summary>Renders a binary expression without its own outer parentheses, choosing operator or method form from the operand types.</summary>
    private void WriteBinaryInner(BinaryExpr bin, StringBuilder sb)
    {
        TypeScope scope = EffectiveScope();
        TypeRef? leftType = _resolver.Infer(bin.Left, scope);
        TypeRef? rightType = _resolver.Infer(bin.Right, scope);

        var isDecimal = leftType?.Name == "Decimal" || rightType?.Name == "Decimal";
        var isInstant = leftType?.Name == "Instant" || rightType?.Name == "Instant";

        // (0) Value-object arithmetic — Java reference types carry no operators, so a `+`/`-`/`*`/`/`
        // involving a value object lowers to its demand-driven method (plus/minus/times/dividedBy), emitted
        // on the value-object record by the value-object slice. Checked first: a `value-object * decimal`
        // (e.g. `lineTotal * 0.9`) must NOT be mistaken for Decimal arithmetic below. Comparisons on a value
        // object still fall through to Objects.equals (case 3).
        if (IsArithmetic(bin.Op) && TryWriteValueObjectArithmetic(bin, leftType, rightType, sb))
        {
            return;
        }

        // (1) Decimal comparison (incl. equality) -> compareTo. Value equality via `compareTo == 0`, not the
        // scale-sensitive BigDecimal.equals.
        if (isDecimal && IsComparison(bin.Op))
        {
            WriteBigDecimalOperand(bin.Left, leftType, sb);
            sb.Append(".compareTo(");
            WriteBigDecimalOperand(bin.Right, rightType, sb);
            sb.Append(") ").Append(ComparisonSymbol(bin.Op)).Append(" 0");
            return;
        }

        // (2) Instant ordering -> compareTo (equality falls through to Objects.equals below).
        if (isInstant && IsOrdering(bin.Op))
        {
            WriteAtom(bin.Left, sb);
            sb.Append(".compareTo(");
            WriteTopLevel(bin.Right, sb);
            sb.Append(") ").Append(ComparisonSymbol(bin.Op)).Append(" 0");
            return;
        }

        // (3) Object equality (String / Instant / value objects / enums …) -> null-safe Objects.equals.
        // A comparison against the `null` literal stays reference ==/!= (case 6), and primitive Int/Bool
        // equality stays a plain operator.
        if (IsEquality(bin.Op) && NeedsObjectsEquals(bin, leftType, rightType))
        {
            if (bin.Op == BinaryOp.Neq)
            {
                sb.Append('!');
            }

            sb.Append("java.util.Objects.equals(");
            WriteTopLevel(bin.Left, sb);
            sb.Append(", ");
            WriteTopLevel(bin.Right, sb);
            sb.Append(')');
            return;
        }

        // (4) Decimal arithmetic -> add/subtract/multiply/divide.
        if (isDecimal && IsArithmetic(bin.Op))
        {
            WriteBigDecimalOperand(bin.Left, leftType, sb);
            sb.Append('.').Append(DecimalMethod(bin.Op)).Append('(');
            WriteBigDecimalOperand(bin.Right, rightType, sb);
            sb.Append(')');
            return;
        }

        // (5)/(6) Plain Java infix: long/boolean arithmetic & comparison, logical &&/||, String concatenation
        // (Java `+`), and reference ==/!= against the null literal. Redundant inner parens are elided by
        // precedence.
        WriteBinaryChild(bin.Left, bin.Op, rightOperand: false, sb);
        sb.Append(' ').Append(PlainSymbol(bin.Op)).Append(' ');
        WriteBinaryChild(bin.Right, bin.Op, rightOperand: true, sb);
    }

    /// <summary>
    /// Lowers value-object arithmetic to the demand-driven method the value-object slice emits, returning
    /// <c>true</c> when it handled the operator: <c>value-object + value-object</c> → <c>a.plus(b)</c>,
    /// <c>value-object - value-object</c> → <c>a.minus(b)</c>, <c>value-object * scalar</c> /
    /// <c>scalar * value-object</c> → <c>vo.times(scalar)</c>, and <c>value-object / scalar</c> →
    /// <c>vo.dividedBy(scalar)</c>. Returns <c>false</c> (leaving the caller to its primitive/Decimal
    /// lowering) when no operand is a value object, so plain numeric arithmetic is untouched.
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
            sb.Append(".dividedBy(");
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

        Write(expr, sb);
    }

    /// <summary>
    /// Writes an operand in a <c>BigDecimal</c> position (a <c>compareTo</c>/arithmetic receiver or argument):
    /// an int literal becomes <c>BigDecimal.ZERO</c> (for <c>0</c>) or <c>BigDecimal.valueOf(n)</c>; a
    /// non-Decimal numeric expression is widened via <c>BigDecimal.valueOf(expr)</c>; an already-Decimal
    /// operand renders as an atom.
    /// </summary>
    private void WriteBigDecimalOperand(Expr expr, TypeRef? type, StringBuilder sb)
    {
        if (expr is LiteralExpr { Kind: LiteralKind.Int } lit)
        {
            sb.Append(lit.Text == "0"
                ? "java.math.BigDecimal.ZERO"
                : "java.math.BigDecimal.valueOf(" + lit.Text + ")");
            return;
        }

        if (type?.Name == "Decimal")
        {
            WriteAtom(expr, sb);
            return;
        }

        // A non-Decimal numeric operand (a Koine `Int` -> long): widen it to BigDecimal.
        sb.Append("java.math.BigDecimal.valueOf(");
        WriteTopLevel(expr, sb);
        sb.Append(')');
    }

    /// <summary>True when an equality (<c>==</c>/<c>!=</c>) must lower to <c>Objects.equals</c>: a reference-typed operand and neither side the <c>null</c> literal.</summary>
    private bool NeedsObjectsEquals(BinaryExpr bin, TypeRef? leftType, TypeRef? rightType)
    {
        if (IsNullLiteral(bin.Left) || IsNullLiteral(bin.Right))
        {
            return false;
        }

        return IsReferenceType(leftType) || IsReferenceType(rightType);
    }

    // ------------------------------------------------------------------------
    // Identifiers, members, calls, literals, matches, let
    // ------------------------------------------------------------------------

    private void WriteIdentifier(string name, StringBuilder sb, string? enumHint)
    {
        // (1) A local (lambda / command / factory parameter, or a `let` binding): verbatim camelCase.
        if (_locals.Contains(name))
        {
            sb.Append(JavaNaming.Member(name));
            return;
        }

        // (2) A nullary value builtin such as `now` (unless shadowed by a real member).
        if (name == "now" && BuiltinOps.IsNullaryValueOp(name) && !_memberNames.Contains(name))
        {
            sb.Append("java.time.Instant.now()");
            return;
        }

        // (3) An enum member reference -> EnumType.MEMBER.
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
                sb.Append(JavaNaming.Type(enumType)).Append('.').Append(JavaNaming.EscapeIdentifier(name));
                return;
            }
        }

        // (4) A member of the enclosing type: `<receiver>.name` in a body (a stored field reads directly, a
        // derived member — or any member when `membersAsAccessors` — reads via its accessor), bare `name` in
        // a compact constructor / invariant.
        if (_memberNames.Contains(name))
        {
            if (_mode == NameMode.Property)
            {
                sb.Append(_memberReceiver).Append('.').Append(JavaNaming.Member(name));
                if (_membersAsAccessors || _derivedMembers.Contains(name))
                {
                    sb.Append("()");
                }
            }
            else
            {
                sb.Append(JavaNaming.Member(name));
            }

            return;
        }

        // (5) A bare enum *type* reference (the qualifier of `OrderStatus.Draft`).
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(JavaNaming.Type(name));
            return;
        }

        // (6) Unknown identifier (includes the `null` literal): emit as written.
        sb.Append(name);
    }

    private void WriteMemberAccess(MemberAccessExpr ma, StringBuilder sb)
    {
        // Qualified enum-member access: `OrderStatus.Cancelled` -> `OrderStatus.CANCELLED`.
        if (ma.Target is IdentifierExpr qualifier && !_memberNames.Contains(qualifier.Name)
            && !_locals.Contains(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(JavaNaming.Type(qualifier.Name)).Append('.').Append(JavaNaming.EscapeIdentifier(ma.MemberName));
            return;
        }

        TypeRef? targetType = _resolver.Infer(ma.Target, EffectiveScope());
        var target = new StringBuilder();
        WriteAtom(ma.Target, target);
        var t = target.ToString();

        switch (ma.MemberName)
        {
            case "isEmpty":
                sb.Append(t).Append(".isEmpty()");
                return;
            case "isNotEmpty":
                sb.Append('!').Append(t).Append(".isEmpty()");
                return;
            case "count":
                // Collection size; cast to long so it composes with Koine `Int` arithmetic.
                sb.Append("(long) ").Append(t).Append(".size()");
                return;
            case "length":
                // String length; cast to long for the same reason.
                sb.Append("(long) ").Append(t).Append(".length()");
                return;
            case "trim":
                sb.Append(t).Append(".strip()");
                return;
            case "lower":
                sb.Append(t).Append(".toLowerCase(java.util.Locale.ROOT)");
                return;
            case "upper":
                sb.Append(t).Append(".toUpperCase(java.util.Locale.ROOT)");
                return;
            case "isBlank":
                sb.Append(t).Append(".isBlank()");
                return;
            case "isPresent":
                sb.Append(t).Append(".isPresent()");
                return;
            case "isNone":
            case "isAbsent":
                sb.Append(t).Append(".isEmpty()");
                return;
            default:
                // A field/derived-member access on another value: call its accessor.
                if (targetType is not null && _index.Classify(targetType.Name) is TypeKind.Value or TypeKind.Entity)
                {
                    sb.Append(t).Append('.').Append(JavaNaming.Member(ma.MemberName)).Append("()");
                    return;
                }

                sb.Append(t).Append('.').Append(JavaNaming.Member(ma.MemberName)).Append("()");
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
                sb.Append(t).Append(".stream().allMatch(").Append(LambdaParam(call)).Append(" -> ");
                WriteLambdaBody(call, sb);
                sb.Append(')');
                return;
            case "any":
                sb.Append(t).Append(".stream().anyMatch(").Append(LambdaParam(call)).Append(" -> ");
                WriteLambdaBody(call, sb);
                sb.Append(')');
                return;
            case "none":
                sb.Append(t).Append(".stream().noneMatch(").Append(LambdaParam(call)).Append(" -> ");
                WriteLambdaBody(call, sb);
                sb.Append(')');
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

    /// <summary>
    /// Renders a <c>sum</c> fold as a stream reduction — a value-object selector reduces with the value
    /// object's <c>plus</c> method (throwing on an empty collection, the seedless-fold contract), a Decimal
    /// selector reduces with <c>BigDecimal::add</c>, and a numeric selector maps to <c>long</c> and sums.
    /// </summary>
    private void WriteSum(CallExpr call, string target, StringBuilder sb)
    {
        TypeRef? selector = InferSelectorType(call);
        if (selector is not null && _index.Classify(selector.Name) == TypeKind.Value)
        {
            // Value objects have no additive operator in Java; fold with the demand-generated `plus` method
            // (emitted on the record by the value-object slice). A seedless reduce yields Optional, so an
            // empty collection throws — matching the C#/Rust/TS `sum` semantics.
            var voType = _typeMapper.Map(new TypeRef(selector.Name));
            sb.Append(target).Append(".stream().map(").Append(LambdaParam(call)).Append(" -> ");
            WriteLambdaBody(call, sb);
            sb.Append(").reduce(").Append(voType).Append("::plus).orElseThrow(() -> ")
              .Append("new koine.runtime.DomainException(\"cannot sum an empty collection\"))");
            return;
        }

        if (selector?.Name == "Decimal")
        {
            sb.Append(target).Append(".stream().map(").Append(LambdaParam(call)).Append(" -> ");
            WriteLambdaBody(call, sb);
            sb.Append(").reduce(java.math.BigDecimal.ZERO, java.math.BigDecimal::add)");
            return;
        }

        sb.Append(target).Append(".stream().mapToLong(").Append(LambdaParam(call)).Append(" -> ");
        WriteLambdaBody(call, sb);
        sb.Append(").sum()");
    }

    /// <summary>Renders a <c>min</c>/<c>max</c> fold as a stream reduction over the projected comparable values, throwing a domain error on an empty collection.</summary>
    private void WriteMinMax(CallExpr call, string target, StringBuilder sb, bool isMin)
    {
        var op = isMin ? "min" : "max";
        sb.Append(target).Append(".stream().map(").Append(LambdaParam(call)).Append(" -> ");
        WriteLambdaBody(call, sb);
        sb.Append(").").Append(op).Append("(java.util.Comparator.naturalOrder())")
          .Append(".orElseThrow(() -> new koine.runtime.DomainException(\"cannot take ")
          .Append(op).Append(" of an empty collection\"))");
    }

    /// <summary>The escaped Java lambda parameter name for a collection-op call.</summary>
    private static string LambdaParam(CallExpr call) =>
        call.Args is [LambdaExpr lambda] ? JavaNaming.Member(lambda.Parameter) : "x";

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
        // Unanchored find, matching the Rust `regex_is_match` / C# `Regex.IsMatch` semantics — inline and
        // dependency-free, so no runtime helper is needed.
        sb.Append("java.util.regex.Pattern.compile(\"").Append(EscapeJavaString(m.Pattern)).Append("\").matcher(");
        WriteTopLevel(m.Target, sb);
        sb.Append(").find()");
    }

    /// <summary>
    /// Lowers <c>let x = e (, y = e)* in body</c> to an immediately-invoked <c>Supplier</c> with <c>var</c>
    /// locals — Java has no expression-<c>let</c>, so a private-local block behind a supplier preserves
    /// evaluation order and scoping.
    /// </summary>
    private void WriteLet(LetExpr let, StringBuilder sb)
    {
        TypeScope scope = EffectiveScope();
        foreach (LetBinding b in let.Bindings)
        {
            scope = scope.WithRef(b.Name, _resolver.Infer(b.Value, scope) ?? new TypeRef("String"), _index);
        }

        TypeRef? bodyType = _resolver.Infer(let.Body, scope);
        var ret = BoxedTypeName(bodyType);

        sb.Append("((java.util.function.Supplier<").Append(ret).Append(">)(() -> { ");

        var pushed = new List<string>();
        foreach (LetBinding b in let.Bindings)
        {
            sb.Append("var ").Append(JavaNaming.Member(b.Name)).Append(" = ");
            WriteTopLevel(b.Value, sb);
            sb.Append("; ");
            PushLocal(b.Name, _resolver.Infer(b.Value, EffectiveScope()));
            pushed.Add(b.Name);
        }

        sb.Append("return ");
        WriteTopLevel(let.Body, sb);
        sb.Append("; })).get()");

        for (var i = pushed.Count - 1; i >= 0; i--)
        {
            PopLocal(pushed[i]);
        }
    }

    /// <summary>The boxed Java type name for a generic (<c>Supplier&lt;T&gt;</c>) position — a primitive is boxed to its reference form.</summary>
    private string BoxedTypeName(TypeRef? type) => type?.Name switch
    {
        null => "Object",
        "Int" => "Long",
        "Bool" => "Boolean",
        _ => _typeMapper.Map(type),
    };

    private static void WriteLiteral(LiteralExpr lit, StringBuilder sb)
    {
        switch (lit.Kind)
        {
            case LiteralKind.Int:
                // A Java `long` literal so it composes with the `long` Koine `Int` maps to.
                sb.Append(lit.Text).Append('L');
                break;
            case LiteralKind.Bool:
                sb.Append(lit.Text == "true" ? "true" : "false");
                break;
            case LiteralKind.Decimal:
                sb.Append("new java.math.BigDecimal(\"").Append(lit.Text).Append("\")");
                break;
            case LiteralKind.String:
                sb.Append('"').Append(EscapeJavaString(lit.Text)).Append('"');
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

    private static bool IsNullLiteral(Expr expr) => expr is IdentifierExpr { Name: "null" };

    /// <summary>True when a type is a Java reference type for equality purposes — anything but the <c>long</c>/<c>boolean</c> primitives.</summary>
    private static bool IsReferenceType(TypeRef? type) => type is not null && type.Name is not ("Int" or "Bool");

    /// <summary>The Java infix symbol closing a <c>compareTo</c> comparison (<c>… &lt;sym&gt; 0</c>) or a plain primitive comparison.</summary>
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

    /// <summary>The plain Java infix symbol for an operator emitted directly (primitives, logical, String concat, null equality).</summary>
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

    /// <summary>True when a nested plain-infix binary <paramref name="childOp"/> must be parenthesized inside a parent <paramref name="parentOp"/> (Java precedence/associativity).</summary>
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

    /// <summary>Java binary-operator precedence tiers (higher binds tighter), for redundant-paren elision.</summary>
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

    /// <summary>Escapes a raw string (a literal body or a regex pattern) for a Java double-quoted string literal.</summary>
    private static string EscapeJavaString(string s)
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
}
