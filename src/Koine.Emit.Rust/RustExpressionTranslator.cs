using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

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
    private readonly IReadOnlyDictionary<(string Context, string Enum), IReadOnlyDictionary<string, string>> _enumVariants;

    private readonly HashSet<string> _locals = new(StringComparer.Ordinal);
    private readonly Dictionary<string, TypeRef> _localTypes = new(StringComparer.Ordinal);
    private readonly ISet<string> _derivedMembers;
    private readonly string _memberReceiver;
    private readonly bool _membersAsAccessors;

    private string? _expectedEnum;

    public RustExpressionTranslator(
        ModelIndex index,
        IReadOnlyList<Member> members,
        IReadOnlyDictionary<string, string> enumMemberToType,
        IReadOnlyDictionary<(string Context, string Enum), IReadOnlyDictionary<string, string>> enumVariants,
        RustTypeMapper typeMapper,
        string? context = null,
        string memberReceiver = "self",
        bool membersAsAccessors = false)
    {
        _index = index;
        _resolver = new TypeResolver(index, context);
        _typeMapper = typeMapper;
        _memberReceiver = memberReceiver;
        // Read-model projection bodies read from a borrowed source (`src`), whose fields are private —
        // so every member must go through its accessor, even the stored ones.
        _membersAsAccessors = membersAsAccessors;
        _scope = TypeScope.FromMembers(members, index);
        _memberNames = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);
        _enumMemberToType = enumMemberToType;
        _enumVariants = enumVariants;
        // Derived (computed) members emit as accessor methods, not struct fields, so a reference to one
        // in an instance body must render as a call `self.x()`, never a field read `self.x`.
        _derivedMembers = new HashSet<string>(
            members.Where(m => MemberAnalysis.IsDerived(m, _memberNames)).Select(m => m.Name),
            StringComparer.Ordinal);
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
                // The condition needs no outer parentheses (rustc warns on them).
                var condBuf = new StringBuilder();
                Write(cond.Condition, condBuf, null);
                sb.Append("if ").Append(StripOuterParens(condBuf.ToString()));
                sb.Append(" { ");
                Write(cond.Then, sb, coerceTo);
                sb.Append(" } else { ");
                Write(cond.Else, sb, coerceTo);
                sb.Append(" }");
                break;
            case CoalesceExpr co:
                // `l ?? r` -> `l.clone().unwrap_or_else(|| r)` (l is an Option<T>; result is T) when `r`
                // is non-optional, or `l.clone().or_else(|| r)` (result stays Option<T>) when `r` is
                // itself optional — force-unwrapping there would lose the "still absent" case and fail a
                // real `cargo check` E0308 (#1333). Infer `r`'s type once and hand it to
                // WriteOperandValue, which would otherwise re-infer the same node.
                WriteOperandValue(co.Left, sb);
                TypeRef? rightType = _resolver.Infer(co.Right, EffectiveScope());
                sb.Append(rightType?.IsOptional == true ? ".or_else(|| " : ".unwrap_or_else(|| ");
                WriteOperandValue(co.Right, sb, rightType);
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

        // A `quantity`'s plain +/- has no native operator to lower to — WriteQuantityOps only ever
        // emits the inherent, unit-checked `add`/`sub` methods (never `impl std::ops::Add`/`Sub`), so
        // the call site must route through them instead (#1068).
        if (bin.Op is BinaryOp.Add or BinaryOp.Sub && IsQuantityType(leftType))
        {
            WriteQuantityOperand(bin.Left, sb);
            sb.Append('.').Append(bin.Op == BinaryOp.Add ? "add" : "sub").Append("(&");
            WriteQuantityOperand(bin.Right, sb);
            sb.Append(").expect(\"").Append(leftType!.Name).Append(": unit mismatch\")");
            if (parenthesize)
            {
                sb.Append(')');
            }

            return;
        }

        // String concatenation lowers to `String + &str` — Rust's `+` on strings consumes an owned
        // left and borrows the right. Cloning both sides (the default for non-Copy arithmetic operands)
        // would emit the invalid `String + String`, so route string `+` through a dedicated writer.
        if (bin.Op == BinaryOp.Add && (leftType?.Name == "String" || rightType?.Name == "String"))
        {
            WriteStringOwned(bin.Left, sb);
            sb.Append(" + ");
            WriteStrRef(bin.Right, sb);
            if (parenthesize)
            {
                sb.Append(')');
            }

            return;
        }

        var isArithmetic = bin.Op is BinaryOp.Add or BinaryOp.Sub or BinaryOp.Mul or BinaryOp.Div;

        // Decimal coercion: an Int operand on the side opposite a Decimal becomes a Decimal.
        TypeRef? coerceLeft = rightType?.Name == "Decimal" && leftType?.Name == "Int" ? Decimal() : null;
        TypeRef? coerceRight = leftType?.Name == "Decimal" && rightType?.Name == "Int" ? Decimal() : null;

        // An optional Int coerced toward Decimal maps inside its Option (EmitCoerced/
        // WriteArithmeticOperand's compound wrap) rather than widening in place, so it stays
        // Option-shaped; symmetrically, an already-optional Decimal side stays Option-shaped regardless
        // of coercion. Either way, whichever side ends up non-optional after coercion must itself become
        // `Some(...)`-wrapped when its sibling is optional, or the two sides of the operator render as
        // mismatched `Option<Decimal>` / `Decimal` types (#1343 — mirrors WriteReconciledBranch's
        // needsSomeWrap, #1335, applied here to binary operands rather than conditional branches). Keyed
        // on each side's OWN optionality (not on which side happens to be the Int-named one), so it
        // fires both when the Int side is optional and when the already-Decimal side is optional.
        // Gated on `coerceLeft`/`coerceRight` involvement so this never touches an unrelated type
        // mismatch outside the Int-vs-Decimal coercion this issue scopes to.
        var involvesDecimalCoercion = coerceLeft is not null || coerceRight is not null;
        var someWrapLeft = involvesDecimalCoercion && leftType is { IsOptional: false } && rightType is { IsOptional: true };
        var someWrapRight = involvesDecimalCoercion && rightType is { IsOptional: false } && leftType is { IsOptional: true };

        // Value-object arithmetic (e.g. Money * quantity) consumes `self` via std::ops, so a non-Copy
        // operand must evaluate to an owned value; comparisons borrow and need no clone.
        if (someWrapLeft)
        {
            sb.Append("Some(");
        }

        WriteArithmeticOperand(bin.Left, sb, EnumTypeName(bin.Right), coerceLeft, isArithmetic, leftType);
        if (someWrapLeft)
        {
            sb.Append(')');
        }

        sb.Append(' ').Append(OperatorOf(bin.Op)).Append(' ');
        if (someWrapRight)
        {
            sb.Append("Some(");
        }

        WriteArithmeticOperand(bin.Right, sb, EnumTypeName(bin.Left), coerceRight, isArithmetic, rightType);
        if (someWrapRight)
        {
            sb.Append(')');
        }

        if (parenthesize)
        {
            sb.Append(')');
        }
    }

    private void WriteOperand(Expr expr, StringBuilder sb, string? enumHint, TypeRef? coerceTo, bool clone, TypeRef? ownType = null)
    {
        switch (expr)
        {
            case BinaryExpr bin:
                WriteBinary(bin, sb, parenthesize: true);
                break;
            case IdentifierExpr id:
                WriteIdentifier(id.Name, sb, enumHint, coerceTo, ownType);
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

    /// <summary>
    /// Writes an operand of the quantity <c>+</c>/<c>-</c> guard (#1068). A simple place
    /// (identifier/member access) is written bare — the receiver and the <c>&amp;</c>-borrowed argument
    /// of a method call auto-ref a place without moving it. A compound expression (e.g. a conditional)
    /// must itself evaluate to an owned value before the call site can consume it, so it is parenthesized
    /// and its leaf places are cloned via <see cref="WriteOwnedOperand"/> (#1268).
    /// </summary>
    private void WriteQuantityOperand(Expr expr, StringBuilder sb)
    {
        if (expr is IdentifierExpr or MemberAccessExpr)
        {
            WriteOperand(expr, sb, null, null, clone: false);
            return;
        }

        sb.Append('(');
        WriteOwnedOperand(expr, sb);
        sb.Append(')');
    }

    /// <summary>
    /// Writes an operand of the general (non-quantity) arithmetic path — the sibling of
    /// <see cref="WriteQuantityOperand"/> for <c>+</c>/<c>-</c>/<c>*</c>/<c>/</c> on plain value objects
    /// (and a quantity's <c>*</c>/<c>/</c>, which never goes through the quantity guard), and of every
    /// comparison operator (<c>&lt;</c>/<c>&lt;=</c>/<c>&gt;</c>/<c>&gt;=</c>/<c>==</c>/<c>!=</c>) too,
    /// since <see cref="WriteBinary"/> computes <paramref name="coerceTo"/> unconditionally for every
    /// binary operator, not just arithmetic ones (#1311, extending #1293).
    /// <para>
    /// A simple place is written bare-or-cloned exactly as before (clone only for a non-Copy arithmetic
    /// operand — comparisons always borrow, per #1282: the operator itself auto-refs a bare place, so no
    /// move occurs). A compound expression (conditional/let/guard) OR a bare non-leaf expression (a
    /// nested <c>BinaryExpr</c> used directly, not nested inside a conditional — #1311, Task 3:
    /// <see cref="WriteOperand"/>'s own <c>BinaryExpr</c> case ignores <paramref name="coerceTo"/>
    /// entirely) renders via <see cref="WriteOwnedOperand"/>, which ALWAYS clones a non-Copy leaf place
    /// regardless of <paramref name="isArithmetic"/> — unlike the bare-place case, a conditional/let
    /// block's tail position is a move-out-of-<c>&amp;self</c> position no matter what consumes the
    /// block's result afterward, so skipping the clone for a comparison operand would leave the BLOCK
    /// itself failing to borrow-check (E0507), not just the outer operator. Then — mirroring
    /// <c>RustEmitter.ValueObjects.WriteDerived</c>'s <c>NumericCoercionWrap</c> precedent — wraps the
    /// WHOLE rendered expression once in <c>Decimal::from(...)</c> when its own inferred
    /// <paramref name="type"/> differs from <paramref name="coerceTo"/>.
    /// </para>
    /// <para>
    /// This deliberately does NOT call <c>NumericCoercionWrap</c> itself (#1293, Task 2): that helper is
    /// <c>private</c> on the sibling <c>RustEmitter</c> class, which already depends on this translator
    /// (<c>RustEmitter.ValueObjects.WriteDerived</c> calls <c>Translate</c>/<c>TranslateOwned</c>) — a
    /// call the other way would invert that dependency. It also solves a different, narrower problem: a
    /// declared-member-type-vs-body mismatch that can go either widening (<c>Int</c>→<c>Decimal</c>) or
    /// narrowing (<c>Decimal</c>→<c>Int</c>, defensive/normally validator-rejected), whereas
    /// <paramref name="coerceTo"/> here is always <c>Decimal</c> (set only by <see cref="WriteBinary"/>'s
    /// Int-opposite-a-Decimal check) — so a second, narrower <c>Decimal::from</c> literal is clearer than
    /// routing through a helper built for a different, wider contract.
    /// </para>
    /// <para>
    /// Scope (#1293 fixed the compound-arithmetic slice; #1311 extended it to comparisons, a conditional's
    /// own disagreeing branches — see <see cref="WriteReconciledBranch"/> — and a bare <c>BinaryExpr</c>
    /// operand): #1316 closed a bare <c>MemberAccessExpr</c>/<c>CallExpr</c> operand used directly (not
    /// nested in a conditional). Unlike the compound shapes above, a member access or call is already a
    /// tight-binding primary with no delimiting needed for precedence, so it is wrapped in
    /// <c>Decimal::from(...)</c> ONLY when coercion is actually needed — reusing
    /// <see cref="WriteOwnedOperand"/>'s "compound" treatment unconditionally would wrap even the
    /// no-coercion case in bare <c>(...)</c> (a plain accessor call has no self-enclosing parens for
    /// <see cref="StripOuterParens"/> to remove), regressing every currently-passing shape. A bare
    /// <c>UnaryExpr</c> operand (e.g. <c>-baseAmount</c>) had the identical defect — <c>WriteUnary</c>
    /// never consults <paramref name="coerceTo"/> — closed by #1321 the same way, since a negation is
    /// likewise a tight-binding primary with no self-enclosing parens.
    /// </para>
    /// </summary>
    private void WriteArithmeticOperand(Expr expr, StringBuilder sb, string? enumHint, TypeRef? coerceTo, bool isArithmetic, TypeRef? type)
    {
        // The wrap decision depends only on `coerceTo`/`type` (known up front), not on the rendered
        // text, so it's computed once and shared by both branches below that need it.
        var needsWrap = coerceTo is not null && type?.Name != coerceTo.Name;

        if (expr is ConditionalExpr or LetExpr or GuardExpr or BinaryExpr)
        {
            // An optional operand's owned rendering is already `Option<...>` — a bare `Decimal::from(...)`
            // prefix around it doesn't compile (E0277), so map inside the Option instead (#1343, mirrors
            // WriteReconciledBranch's needsOptionalWiden, #1335).
            var needsMapWrap = needsWrap && type is { IsOptional: true };

            // The prefix is picked before rendering and `WriteOwnedOperand` writes straight into `sb` —
            // no intermediate buffer needed.
            sb.Append(needsWrap && !needsMapWrap ? "Decimal::from(" : "(");
            WriteOwnedOperand(expr, sb);
            sb.Append(')');
            if (needsMapWrap)
            {
                sb.Append(".map(Decimal::from)");
            }

            return;
        }

        var clone = isArithmetic && IsNonCopyPlace(expr, type);

        if (expr is MemberAccessExpr or CallExpr or UnaryExpr && needsWrap)
        {
            // Mirrors the compound-operand branch's needsMapWrap above: an optional operand's rendering
            // is already `Option<...>` (or a reference to one, for an accessor call), so a bare
            // `Decimal::from(...)` prefix around it doesn't compile (E0277) — map inside the Option
            // instead (#1354, closing the same #1343/#1347 defect class for this remaining call site).
            var needsMapWrap = type is { IsOptional: true };

            if (!needsMapWrap)
            {
                sb.Append("Decimal::from(");
            }

            WriteOperand(expr, sb, enumHint, coerceTo: null, clone);

            if (!needsMapWrap)
            {
                sb.Append(')');
            }
            else
            {
                sb.Append(".map(Decimal::from)");
            }

            return;
        }

        WriteOperand(expr, sb, enumHint, coerceTo, clone, type);
    }

    /// <summary>
    /// Writes an expression so it evaluates to an owned value, recursing into a conditional's branches
    /// (including nested conditionals) so a leaf place a branch would otherwise move out of
    /// <c>&amp;self</c> is cloned instead — the block-expression dual of <see cref="WriteOperandValue"/>
    /// (#1268). Shared by the quantity <c>+</c>/<c>-</c> guard, the general arithmetic/comparison path
    /// (#1282, #1311), a bare conditional/let derived-member body
    /// (<see cref="RustExpressionTranslator.TranslateOwned"/>, #1282), and a <c>CoalesceExpr</c> arm
    /// (<see cref="WriteOperandValue"/>, #1282). Always clones/normalizes a non-Copy leaf place — this is
    /// unconditional (not gated by whether the caller is arithmetic or a comparison), because a
    /// conditional/let block's own tail position requires an owned value to type/borrow-check regardless
    /// of what the surrounding operator does with the block's result (#1311).
    /// </summary>
    private void WriteOwnedOperand(Expr expr, StringBuilder sb)
    {
        if (expr is ConditionalExpr cond)
        {
            var condBuf = new StringBuilder();
            Write(cond.Condition, condBuf, null);
            sb.Append("if ").Append(StripOuterParens(condBuf.ToString())).Append(" { ");
            WriteReconciledBranch(cond.Then, cond.Else, sb);
            sb.Append(" } else { ");
            WriteReconciledBranch(cond.Else, cond.Then, sb);
            sb.Append(" }");
            return;
        }

        if (expr is LetExpr let)
        {
            List<string> pushed = WriteLetBindings(let.Bindings, sb, cloneNonCopyPlaces: true);
            var bodyBuf = new StringBuilder();
            WriteOwnedOperand(let.Body, bodyBuf);
            sb.Append(StripOuterParens(bodyBuf.ToString()));
            sb.Append(" }");
            PopLocals(pushed);
            return;
        }

        if (expr is GuardExpr g)
        {
            // `when` is a semantic-only disambiguation with no runtime Rust representation (mirrors
            // Write's GuardExpr case) — the owned-value treatment belongs to the guarded body.
            WriteOwnedOperand(g.Body, sb);
            return;
        }

        WriteOwnedLeaf(expr, sb);
    }

    /// <summary>
    /// Writes one conditional branch, individually widened to <c>Decimal</c> when its own inferred type
    /// is a non-optional <c>Int</c> while the SIBLING branch is <c>Decimal</c>, map-widened
    /// (<c>.map(Decimal::from)</c>) when its own inferred type is an OPTIONAL <c>Int</c> while the
    /// SIBLING branch is <c>Decimal</c> (#1335 — the branch's owned rendering is already
    /// <c>Option&lt;i64&gt;</c>, so a bare <c>Decimal::from(...)</c> prefix does not compile; mapping
    /// inside the <c>Option</c> is required instead), and/or <c>Some(...)</c>-wrapped when its own
    /// inferred type is non-optional while the SIBLING branch is optional. <see cref="TypeResolver"/>
    /// already widens the conditional's own aggregate type to the wider/optional-joined type of the two
    /// branches (#975), so the outer <c>coerceTo</c> comparison in <see cref="WriteArithmeticOperand"/>
    /// (and <c>WriteDerived</c>'s own whole-body <c>Some(...)</c>-wrap decision, #1329) never sees a
    /// mismatch here — each branch still renders in its own native Rust type/optionality, so an
    /// unreconciled pair emits two different types in the same <c>if</c>/<c>else</c> (a real
    /// <c>cargo check</c> E0308: numeric — #1311; optionality — #1331; optional numeric — #1335).
    /// Reconciling per-branch (rather than a single wrap around the whole conditional) is required
    /// because the branches disagree with EACH OTHER, not with an externally supplied
    /// <c>coerceTo</c>. Fixed here in the emitter (not the semantic validator): a widened or
    /// optional-joined conditional is a legitimate, cross-target-sanctioned pattern (#975) — this is a
    /// Rust-only rendering gap, not a modeling error. The <c>needsWiden</c>/<c>needsOptionalWiden</c>
    /// widen cases are mutually exclusive (they key off the same branch's own optionality: the former
    /// requires it non-optional, the latter requires it optional). <c>needsWiden</c> composes with
    /// <c>needsSomeWrap</c> as <c>Some(Decimal::from(...))</c> (wrap outside, widen inside) — the value
    /// must be a <c>Decimal</c> before it becomes an <c>Option&lt;Decimal&gt;</c>. <c>needsOptionalWiden</c>
    /// never composes with <c>needsSomeWrap</c>: <c>needsSomeWrap</c> also requires the branch itself to
    /// be non-optional, so a branch that is already <c>Option</c>-shaped (<c>needsOptionalWiden</c>)
    /// never needs the extra <c>Some(...)</c> wrap.
    /// </summary>
    private void WriteReconciledBranch(Expr branch, Expr sibling, StringBuilder sb)
    {
        TypeScope scope = EffectiveScope();
        TypeRef? branchType = _resolver.Infer(branch, scope);
        TypeRef? siblingType = _resolver.Infer(sibling, scope);
        var needsWiden = branchType is { Name: "Int", IsOptional: false } && siblingType?.Name == "Decimal";
        var needsOptionalWiden = branchType is { Name: "Int", IsOptional: true } && siblingType?.Name == "Decimal";
        var needsSomeWrap = branchType is { IsOptional: false } && siblingType is { IsOptional: true };

        if (needsSomeWrap)
        {
            sb.Append("Some(");
        }

        if (needsWiden)
        {
            sb.Append("Decimal::from(");
        }

        WriteOwnedOperand(branch, sb);
        if (needsWiden)
        {
            sb.Append(')');
        }

        if (needsOptionalWiden)
        {
            sb.Append(".map(Decimal::from)");
        }

        if (needsSomeWrap)
        {
            sb.Append(')');
        }
    }

    /// <summary>
    /// Writes a leaf (non-conditional/let/guard) expression as an owned value — the base case
    /// <see cref="WriteOwnedOperand"/> recurses down to. A <c>String</c>-typed <b>place</b>
    /// (identifier/member access) is normalized via <c>.to_string()</c> (correct whether it renders as
    /// an owned <c>String</c> field or a borrowed <c>&amp;str</c> accessor result — <c>.clone()</c> on
    /// the latter would stay a <c>&amp;str</c> and mistype the position); any other non-<c>Copy</c>
    /// place is cloned. A <b>non-place</b> String leaf (a concatenation) is left as-is: it already
    /// renders as an owned <c>String</c> via <see cref="WriteStringOwned"/>, and appending a suffix
    /// after <see cref="StripOuterParens"/> has removed its enclosing parens would bind to the
    /// concatenation's last operand instead of the whole expression.
    /// </summary>
    private void WriteOwnedLeaf(Expr expr, StringBuilder sb)
    {
        TypeRef? type = _resolver.Infer(expr, EffectiveScope());
        var bodyBuf = new StringBuilder();
        Write(expr, bodyBuf, null);
        sb.Append(StripOuterParens(bodyBuf.ToString()));

        var isPlace = expr is IdentifierExpr or MemberAccessExpr;
        if (type is { Name: "String", IsOptional: false } && isPlace)
        {
            sb.Append(".to_string()");
        }
        else if (IsNonCopyPlace(expr, type))
        {
            sb.Append(".clone()");
        }
    }

    /// <summary>
    /// Writes an expression as an owned value (used for coalesce arms): cloned when it is a place. A
    /// compound (conditional/let/guard) arm routes through <see cref="WriteOwnedOperand"/> instead, so a
    /// leaf place a branch would otherwise move out of <c>&amp;self</c> is cloned too (#1282) — the
    /// non-compound case below is unchanged. <paramref name="knownType"/> lets a caller that already
    /// inferred <paramref name="expr"/>'s type (e.g. to pick a coalesce combinator, #1333) pass it
    /// through instead of paying a second <see cref="TypeResolver.Infer"/> walk for the same node.
    /// </summary>
    private void WriteOperandValue(Expr expr, StringBuilder sb, TypeRef? knownType = null)
    {
        if (expr is ConditionalExpr or LetExpr or GuardExpr)
        {
            WriteOwnedOperand(expr, sb);
            return;
        }

        TypeRef? type = knownType ?? _resolver.Infer(expr, EffectiveScope());
        var clone = IsNonCopyPlace(expr, type);
        Write(expr, sb, null);
        if (clone)
        {
            sb.Append(".clone()");
        }
    }

    private void WriteLet(LetExpr let, StringBuilder sb, TypeRef? coerceTo)
    {
        // `let x = e1, y = e2 in body` -> `{ let x = e1; let y = e2; body }` (a Rust block expression).
        // A binding's value is written as-is here: it need not be an owned value (e.g. an accessor call
        // like `title.trim()` legitimately binds a borrow), so it is not cloned.
        List<string> pushed = WriteLetBindings(let.Bindings, sb, cloneNonCopyPlaces: false);

        // The block's return value needs no outer parentheses (rustc warns on them), so render the
        // body to a buffer and drop one fully-enclosing pair.
        var bodyBuf = new StringBuilder();
        Write(let.Body, bodyBuf, coerceTo);
        sb.Append(StripOuterParens(bodyBuf.ToString()));
        sb.Append(" }");

        PopLocals(pushed);
    }

    /// <summary>
    /// Writes a <c>let</c> block's opening brace and bindings; caller writes the body and closing
    /// brace, then calls <see cref="PopLocals"/>. When <paramref name="cloneNonCopyPlaces"/> is set (the
    /// <see cref="WriteOwnedOperand"/> context, #1268), a binding's value is itself written as an owned
    /// value via <see cref="WriteOwnedOperand"/> — not just cloned when it's a bare place, but recursing
    /// into a compound (conditional/let/guard) value too (#1282) — otherwise binding it would move a
    /// non-Copy leaf out of <c>&amp;self</c>, and the block must still yield an owned value once its
    /// body is later cloned/consumed.
    /// </summary>
    private List<string> WriteLetBindings(IReadOnlyList<LetBinding> bindings, StringBuilder sb, bool cloneNonCopyPlaces)
    {
        var pushed = new List<string>();
        sb.Append("{ ");
        foreach (LetBinding b in bindings)
        {
            sb.Append("let ").Append(RustNaming.Field(b.Name)).Append(" = ");
            TypeRef? bindingType = _resolver.Infer(b.Value, EffectiveScope());
            if (cloneNonCopyPlaces)
            {
                WriteOwnedOperand(b.Value, sb);
            }
            else
            {
                Write(b.Value, sb, null);
            }

            sb.Append("; ");
            PushLocal(b.Name, bindingType);
            pushed.Add(b.Name);
        }

        return pushed;
    }

    private void PopLocals(List<string> pushed)
    {
        for (var i = pushed.Count - 1; i >= 0; i--)
        {
            PopLocal(pushed[i]);
        }
    }

    private void WriteIdentifier(string name, StringBuilder sb, string? enumHint, TypeRef? coerceTo, TypeRef? ownType = null)
    {
        // (1) Local (lambda/command/factory parameter, let binding): verbatim snake_case.
        if (_locals.Contains(name))
        {
            EmitCoerced(sb, coerceTo, ownType, () => sb.Append(RustNaming.Field(name)));
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
                sb.Append(_typeMapper.QualifyTypeName(enumType)).Append("::").Append(VariantOf(enumType, name));
                return;
            }
        }

        // (4) Member of the enclosing type: `self.<snake>` in a body (a stored field reads directly;
        // a derived member reads via its accessor), bare `<snake>` in a constructor/invariant.
        if (_memberNames.Contains(name))
        {
            EmitCoerced(sb, coerceTo, ownType, () =>
            {
                if (_mode == NameMode.Property)
                {
                    // A stored field reads directly; a derived member (or any member in projection
                    // mode, reading from a borrowed source) reads through its accessor method.
                    sb.Append(_memberReceiver).Append('.').Append(RustNaming.Field(name));
                    if (_membersAsAccessors || _derivedMembers.Contains(name))
                    {
                        sb.Append("()");
                    }
                }
                else
                {
                    sb.Append(RustNaming.Field(name));
                }
            });
            return;
        }

        // (5) An enum *type* reference (qualifier of `OrderStatus.Draft`): the PascalCase type,
        // module-qualified when the enum is owned by another bounded context.
        if (_index.Classify(name) == TypeKind.Enum)
        {
            sb.Append(_typeMapper.QualifyTypeName(name));
            return;
        }

        // (6) Unknown identifier: best-effort snake.
        sb.Append(RustNaming.Field(name));
    }

    /// <summary>
    /// Wraps an emitted Int identifier in <c>Decimal::from(…)</c> when a Decimal is expected — or, when
    /// the identifier's own <paramref name="ownType"/> is itself optional, maps inside the Option instead
    /// (<c>.map(Decimal::from)</c>): a bare <c>Decimal::from(...)</c> around an <c>Option&lt;i64&gt;</c>
    /// operand does not compile (#1343, mirrors WriteReconciledBranch's needsOptionalWiden, #1335).
    /// </summary>
    private static void EmitCoerced(StringBuilder sb, TypeRef? coerceTo, TypeRef? ownType, Action emit)
    {
        if (coerceTo?.Name != "Decimal")
        {
            emit();
            return;
        }

        if (ownType is { IsOptional: true })
        {
            emit();
            sb.Append(".map(Decimal::from)");
            return;
        }

        sb.Append("Decimal::from(");
        emit();
        sb.Append(')');
    }

    private void WriteMemberAccess(MemberAccessExpr ma, StringBuilder sb)
    {
        // Qualified enum-member access: `OrderStatus.Cancelled` -> `OrderStatus::Cancelled`.
        if (ma.Target is IdentifierExpr qualifier && !_memberNames.Contains(qualifier.Name)
            && !_locals.Contains(qualifier.Name) && _index.Classify(qualifier.Name) == TypeKind.Enum)
        {
            sb.Append(_typeMapper.QualifyTypeName(qualifier.Name)).Append("::").Append(VariantOf(qualifier.Name, ma.MemberName));
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

    /// <summary>
    /// Writes a String-typed expression as an owned <c>String</c> — the left side of a <c>+</c> concat.
    /// A nested concatenation already evaluates to an owned String; everything else is owned with
    /// <c>.to_string()</c>, which yields a <c>String</c> whether the operand is a <c>String</c> place
    /// (a field/local) or a <c>&amp;str</c> (a <c>.trim</c> accessor, a nested value's String field, a
    /// literal) — <c>.clone()</c> would leave a <c>&amp;str</c> a <c>&amp;str</c> and break <c>+</c>.
    /// </summary>
    private void WriteStringOwned(Expr expr, StringBuilder sb)
    {
        if (expr is BinaryExpr { Op: BinaryOp.Add } nested)
        {
            WriteBinary(nested, sb, parenthesize: true);
            return;
        }

        Write(expr, sb, null);
        sb.Append(".to_string()");
    }

    /// <summary>True when an expression's inferred type is optional — used to decide <c>Some(...)</c> wrapping.</summary>
    public bool IsOptional(Expr expr) => _resolver.Infer(expr, EffectiveScope())?.IsOptional == true;

    /// <summary>The semantic type an expression infers to in this value object's scope (locals included) —
    /// used to reconcile a derived member's body type with its declared type (numeric widening, #961).</summary>
    public TypeRef? InferType(Expr expr) => _resolver.Infer(expr, EffectiveScope());

    /// <summary>
    /// Translates an expression to an owned value for a <c>return</c>/<c>Ok(...)</c> position: a non-Copy
    /// place (a field/local such as the entity <c>id</c>, or a <c>.field()</c> accessor result) is cloned
    /// so the value is moved out by value rather than borrowed from <c>&amp;self</c>. A bare
    /// conditional/let/guard (no arithmetic operator at all) routes through <see cref="WriteOwnedOperand"/>
    /// instead, so a leaf place a branch would otherwise move out of <c>&amp;self</c> is cloned too
    /// (#1282) — the non-compound cases below are unchanged.
    /// </summary>
    public string TranslateOwned(Expr expr, string? expectedEnum = null)
    {
        if (expr is ConditionalExpr or LetExpr or GuardExpr)
        {
            var prevMode = _mode;
            _mode = NameMode.Property;
            _expectedEnum = expectedEnum;
            var ownedSb = new StringBuilder();
            WriteOwnedOperand(expr, ownedSb);
            _expectedEnum = null;
            _mode = prevMode;
            return ownedSb.ToString();
        }

        var rendered = Translate(expr, expectedEnum);
        TypeRef? type = _resolver.Infer(expr, EffectiveScope());

        // A String result may be `&str` (a `.trim` accessor, a nested value's String field, a literal)
        // or an owned `String`; `to_string()` owns either into the `String` the position expects, where
        // `.clone()` would leave a `&str` a `&str`.
        if (type is { Name: "String", IsOptional: false })
        {
            return rendered + ".to_string()";
        }

        var clone = IsNonCopyPlace(expr, type)
            || (expr is MemberAccessExpr && type is { } t && !_typeMapper.IsCopy(t));
        return clone ? rendered + ".clone()" : rendered;
    }

    /// <summary>
    /// Writes a string-typed argument as a <c>&amp;str</c> reference for the right side of Rust's
    /// string-concat <c>+</c> operator (<c>String + &amp;str</c>).
    /// <list type="bullet">
    ///   <item>A <c>String</c> literal is written as a <c>&amp;str</c> literal (<c>"…"</c>) — already
    ///   a <c>&amp;str</c>, no borrow needed.</item>
    ///   <item>An operand whose inferred type is <c>String</c> is written as <c>&amp;&lt;expr&gt;</c> —
    ///   <c>&amp;String</c> coerces to <c>&amp;str</c>.</item>
    ///   <item>Any other operand (e.g. <c>Int</c>, <c>Decimal</c>, <c>Bool</c>, an enum) is stringified
    ///   first: <c>&amp;&lt;expr&gt;.to_string()</c>.  Emitting a bare <c>&amp;&lt;expr&gt;</c> for a
    ///   non-<c>String</c> operand would produce e.g. <c>&amp;i64</c>, for which Rust has no
    ///   <c>Add&lt;String&gt;</c> impl — <c>cargo check</c> error E0369 (issue #837).</item>
    /// </list>
    /// Symmetric with <see cref="WriteStringOwned"/> (the left side), which already calls
    /// <c>.to_string()</c> on every non-<c>BinaryExpr</c> left operand.
    /// </summary>
    private void WriteStrRef(Expr expr, StringBuilder sb)
    {
        if (expr is LiteralExpr { Kind: LiteralKind.String } lit)
        {
            WriteLiteral(lit, sb, null);
            return;
        }

        TypeRef? type = _resolver.Infer(expr, EffectiveScope());
        if (type?.Name != "String")
        {
            // Non-String operand (e.g. Int, Decimal, Bool, enum): stringify it first.
            // &<expr>.to_string() gives a &String that coerces to &str, satisfying String + &str.
            sb.Append('&');
            Write(expr, sb, null);
            sb.Append(".to_string()");
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

    /// <summary>
    /// Resolves a referenced enum member to its emitted Rust variant via the shared per-enum
    /// member→variant map (#323), so a reference renders the SAME disambiguated variant the enum
    /// declaration emits (e.g. the second of <c>EUR</c>/<c>Eur</c> resolves to <c>Eur2</c>, not a second
    /// <c>Eur</c>). The map is keyed by <c>(context, enum name)</c>, so the owning context is resolved
    /// the same way the type name qualifies (<see cref="RustTypeMapper.ResolveOwnerContext"/>) — a bare
    /// reference binds to the current context's sibling, a qualified one to its owner's. This keeps two
    /// same-named enums in different contexts from aliasing onto one variant table (#437). Falls back to
    /// <see cref="RustNaming.Variant"/> for an enum/member the map does not carry, matching the
    /// pre-de-dup behavior.
    /// </summary>
    private string VariantOf(string enumName, string memberName) =>
        _typeMapper.ResolveOwnerContext(enumName) is { } owner
            && _enumVariants.TryGetValue((owner, enumName), out IReadOnlyDictionary<string, string>? byMember)
            && byMember.TryGetValue(memberName, out var variant)
                ? variant
                : RustNaming.Variant(memberName);

    /// <summary>True when an expression is a place (member/local) of a non-Copy type — so a by-value op must clone it.</summary>
    private bool IsNonCopyPlace(Expr expr, TypeRef? type)
    {
        if (type is null || _typeMapper.IsCopy(type))
        {
            return false;
        }

        return expr is IdentifierExpr || expr is MemberAccessExpr;
    }

    /// <summary>True when a type resolves to a <c>quantity</c> value object (mirrors the emitter-side <c>vo.IsQuantity</c> branch).</summary>
    private bool IsQuantityType(TypeRef? type) =>
        type is not null && _index.TryGetDecl(type.Name, out TypeDecl decl) && decl is ValueObjectDecl { IsQuantity: true };

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
