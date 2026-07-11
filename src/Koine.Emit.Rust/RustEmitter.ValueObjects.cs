using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The value-object slice of <see cref="RustEmitter"/>. A Koine <c>value</c> emits as a struct with
/// private fields and a smart constructor <c>new(...) -&gt; Result&lt;Self, DomainError&gt;</c> that
/// runs the invariants before constructing; stored fields are exposed through accessors (by value for
/// <c>Copy</c> types, by <c>&amp;str</c>/<c>&amp;T</c> otherwise), constant-default members are set
/// inside <c>new</c>, and derived (computed) members become get-only methods. Demand-driven operators
/// (scalar <c>Mul</c>/<c>Div</c>, additive <c>Add</c>/subtractive <c>Sub</c>) are emitted only where the
/// model actually uses them (mirroring the C#/Python emitters) and build their result through that same
/// smart constructor, so a declared <c>invariant</c> holds for an operator's result too (#1270).
/// A <c>quantity</c> additionally gets unit-checked
/// <c>add</c>/<c>sub</c> (returning <c>Result</c>) and a scalar <c>scale</c>.
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitValueObject(StringBuilder sb, RustEmitContext emit, ValueObjectDecl vo, string context)
    {
        var name = RustNaming.ToPascalCase(vo.Name);
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);

        var stored = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var required = stored.Where(m => !HasConstantDefault(m)).ToList();

        // Every constant-defaulted member becomes a trailing `Option<T>` constructor parameter, unwrapped
        // to its default — matching the entity emitter's "optional trailing parameter" shape for the same
        // construct (#1380 for non-optional-declared members, #1463 for already-`T?`-declared ones). An
        // already-optional-declared member is additionally re-wrapped in `Some(...)` after unwrapping.
        var defaultedParams = stored.Where(HasConstantDefault).ToList();

        var typeMapper = new RustTypeMapper(emit.Index, context, _options);
        var translator = new RustExpressionTranslator(emit.Index, vo.Members, emit.EnumMemberToType, emit.EnumVariants, typeMapper, context);

        // The struct.
        WriteDoc(sb, vo.Doc, string.Empty);
        sb.Append("#[derive(Debug, Clone, PartialEq, Eq)]\n");
        sb.Append("pub struct ").Append(name).Append(" {\n");
        foreach (Member m in stored)
        {
            WriteDoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append(RustNaming.Field(m.Name)).Append(": ").Append(typeMapper.Map(m.Type)).Append(",\n");
        }
        sb.Append("}\n\n");

        // impl: smart constructor + accessors + derived methods.
        sb.Append("impl ").Append(name).Append(" {\n");
        WriteSmartConstructor(sb, emit, name, vo, required, defaultedParams, stored, translator, typeMapper);

        foreach (Member m in stored)
        {
            sb.Append('\n');
            WriteAccessor(sb, m, typeMapper);
        }

        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteDerived(sb, m, translator, typeMapper);
        }

        sb.Append("}\n");

        // Demand-driven / quantity operators. This value object's full operator demand, resolved once
        // from the analyzer's single-pass model (#1126): scalar multiply/divide factors, the `sum`-fold
        // `IsSummable` flag, the plain binary `+`/`-` ops, and the precomputed `NeedsAdd` union. `null` =
        // this VO needs no generated arithmetic (absent from the unified map, exactly as it was absent
        // from all four separate maps before). Read null-safely below, mirroring CSharpEmitter/PhpEmitter.
        var needs = emit.OperatorNeeds.GetValueOrDefault(vo.Name);

        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, name, required, defaultedParams, stored, typeMapper);
        }

        // A quantity's scalar Mul/Div (`base * 2`, `fee / 2`) has no unit to check — unlike its Add/Sub,
        // which route through the unit-checked inherent methods `WriteQuantityOps` emits above — so a
        // quantity shares the exact same demand-driven `impl std::ops::Mul`/`Div` a plain VO gets below
        // (#1084, sibling of #1068's Add/Sub fix). Before #1084, `RustExpressionTranslator.WriteBinary`
        // still lowered a quantity's `* scalar`/`/ scalar` to the native operator with no backing impl —
        // a real `cargo check` E0369.
        IReadOnlySet<string>? scalars = needs?.MultiplyFactors;
        if (scalars is { Count: > 0 } && stored.Any(IsNumericField))
        {
            WriteScalarOp(sb, name, required, defaultedParams, scalars, "*");
        }
        // `Div` is the division dual of `Mul` (#879, follow-up to the C# emitter's #832):
        // demand-generated only where the model actually divides this value object by a scalar
        // (fee / 2), never emitted unconditionally.
        IReadOnlySet<string>? divScalars = needs?.DivideFactors;
        if (divScalars is { Count: > 0 } && stored.Any(IsNumericField))
        {
            WriteScalarOp(sb, name, required, defaultedParams, divScalars, "/");
        }

        if (!vo.IsQuantity)
        {
            // `Add` is demand-generated when the VO is folded with `sum` OR appears in a plain
            // `base + base` (#887) — the analyzer precombines both into `NeedsAdd`; `Sub` is
            // demand-generated for a plain `base - base` (#887 — never generated for plain VOs before).
            // The call-site lowering in RustExpressionTranslator already emits the native `+`/`-`, i.e.
            // `std::ops::Add`/`std::ops::Sub`; this writes the impls. A quantity never reaches here — its
            // Add/Sub are the unit-checked inherent methods `WriteQuantityOps` already emitted above.
            bool needsAdd = needs?.NeedsAdd ?? false;
            bool needsSub = needs?.BinaryOps.Contains(BinaryOp.Sub) ?? false;
            if (needsAdd)
            {
                WriteAdditiveOp(sb, name, required, defaultedParams, "+");
            }
            if (needsSub)
            {
                WriteAdditiveOp(sb, name, required, defaultedParams, "-");
            }
        }
    }

    private void WriteSmartConstructor(
        StringBuilder sb, RustEmitContext emit, string name, ValueObjectDecl vo,
        IReadOnlyList<Member> required, IReadOnlyList<Member> defaultedParams, IReadOnlyList<Member> stored,
        RustExpressionTranslator translator, RustTypeMapper typeMapper)
    {
        var ctorParams = required.Select(m => RustNaming.Field(m.Name) + ": " + typeMapper.Map(m.Type)).ToList();
        ctorParams.AddRange(defaultedParams.Select(m => RustNaming.Field(m.Name) + ": " + typeMapper.Map(m.Type with { IsOptional = true })));
        sb.Append(Indent).Append("/// Creates a validated `").Append(name).Append("`, running its invariants.\n");
        sb.Append(Indent).Append("pub fn new(").Append(string.Join(", ", ctorParams)).Append(") -> Result<Self, DomainError> {\n");

        // A defaulted member unwraps its `Option<T>` parameter to the declared default (so invariants can
        // see the resolved value before the checks). The default's inferred type is reconciled against
        // the field's declared (underlying, if optional) type — the value-object dual of EmitEntity's
        // identical handling (#1380/#1436/#1437). `unwrap_or_else` (not `unwrap_or`): the latter always
        // evaluates its argument eagerly, so an overriding caller would still pay for constructing the
        // discarded default. An already-optional-declared member is then re-wrapped in `Some(...)`,
        // mirroring its original hardcoded shape (#1463).
        foreach (Member m in defaultedParams)
        {
            var defaultValue = CoercedDefaultValue(m, UnderlyingType(m.Type), translator, emit.Index);
            var field = RustNaming.Field(m.Name);
            sb.Append(Indent).Append(Indent).Append("let ").Append(field).Append(" = ")
              .Append(field).Append(".unwrap_or_else(|| ").Append(defaultValue).Append(");\n");

            if (m.Type.IsOptional)
            {
                sb.Append(Indent).Append(Indent).Append("let ").Append(field).Append(" = Some(")
                  .Append(field).Append(");\n");
            }
        }

        foreach (Invariant inv in vo.Invariants)
        {
            WriteInvariantGuard(sb, name, inv, translator, Indent + Indent);
        }

        // Construct: every stored field (required and now-unwrapped defaulted-param alike) binds its
        // same-named local.
        sb.Append(Indent).Append(Indent).Append("Ok(Self {\n");
        foreach (Member m in stored)
        {
            sb.Append(Indent).Append(Indent).Append(Indent).Append(RustNaming.Field(m.Name)).Append(",\n");
        }
        sb.Append(Indent).Append(Indent).Append("})\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>Emits one invariant guard: <c>if !(cond) { return Err(...) }</c> in the given name mode.</summary>
    internal void WriteInvariantGuard(
        StringBuilder sb, string typeName, Invariant inv, RustExpressionTranslator translator, string indent,
        RustExpressionTranslator.NameMode mode = RustExpressionTranslator.NameMode.Parameter)
    {
        string test;
        if (inv.Condition is GuardExpr guard)
        {
            // `body when cond` only requires body to hold when cond is true: fail iff cond && !body.
            test = translator.Translate(guard.Condition, mode) + " && " + Negate(translator.Translate(guard.Body, mode));
        }
        else
        {
            test = Negate(translator.Translate(inv.Condition, mode));
        }

        sb.Append(indent).Append("if ").Append(test).Append(" {\n");
        sb.Append(indent).Append(Indent).Append("return Err(DomainError::InvariantViolation { type_name: \"")
          .Append(typeName).Append("\", rule: ").Append(RuleLiteral(inv.Message ?? "invariant failed")).Append(" });\n");
        sb.Append(indent).Append("}\n");
    }

    /// <summary>Logically negates a translated condition, reusing its outer parens when fully wrapped.</summary>
    internal static string Negate(string condition) =>
        IsFullyParenthesized(condition) ? "!" + condition : "!(" + condition + ")";

    /// <summary>True when <paramref name="s"/> is wrapped in one matched outer parenthesis pair.</summary>
    private static bool IsFullyParenthesized(string s)
    {
        if (s.Length < 2 || s[0] != '(' || s[^1] != ')')
        {
            return false;
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
                    return false;
                }
            }
        }

        return depth == 0;
    }

    /// <summary>Emits a get-only accessor for a stored field (by value for Copy, by reference otherwise).</summary>
    private static void WriteAccessor(StringBuilder sb, Member m, RustTypeMapper typeMapper)
    {
        var field = RustNaming.Field(m.Name);
        WriteDoc(sb, m.Doc, Indent);
        if (typeMapper.IsCopy(m.Type))
        {
            sb.Append(Indent).Append("pub fn ").Append(field).Append("(&self) -> ").Append(typeMapper.Map(m.Type))
              .Append(" { self.").Append(field).Append(" }\n");
        }
        else if (m.Type is { Name: "String", IsOptional: false })
        {
            sb.Append(Indent).Append("pub fn ").Append(field).Append("(&self) -> &str { &self.").Append(field).Append(" }\n");
        }
        else
        {
            sb.Append(Indent).Append("pub fn ").Append(field).Append("(&self) -> &").Append(typeMapper.Map(m.Type))
              .Append(" { &self.").Append(field).Append(" }\n");
        }
    }

    /// <summary>Emits a derived (computed) member as a get-only method returning an owned value.</summary>
    private void WriteDerived(StringBuilder sb, Member m, RustExpressionTranslator translator, RustTypeMapper typeMapper)
    {
        var field = RustNaming.Field(m.Name);
        string body;

        // The underlying (non-optional) view of the declared type — mirrors the constant-default sites'
        // pattern (#1319/#1325). An optional-declared member's bare or conditional body may itself be a
        // bare, always-present value of a narrower/different (or even same) numeric type, which needs
        // coercing against this underlying type and Some(...)-wrapping below — but only when the body's
        // OWN inferred type isn't itself optional (#1329): a body that can itself yield an optional value
        // (e.g. a conditional whose branches reference other optional fields) is already Option-shaped
        // and must render exactly as today, or wrapping it here would double-wrap it.
        var underlyingType = UnderlyingType(m.Type);

        // A bare conditional/let/guard body (no arithmetic operator at all) has its own recursive
        // owned-value dispatch — a leaf place a branch would otherwise move out of `&self` must be
        // cloned, which neither the clone/`to_string` handling below (it only recognizes a bare
        // `IdentifierExpr`/`MemberAccessExpr` initializer) nor a plain `Translate` provide (#1282,
        // generalizing #1268's quantity-guard fix).
        if (m.Initializer is ConditionalExpr or LetExpr or GuardExpr)
        {
            body = translator.TranslateOwned(m.Initializer!, EnumExpectedRef(m, typeMapper));
            TypeRef? ownedBodyType = translator.InferType(m.Initializer!);
            if (NumericCoercionWrap(underlyingType, ownedBodyType) is { } ownedWrap)
            {
                body = $"{ownedWrap}({body})";
            }
            body = SomeWrapIfNeeded(body, m.Type, ownedBodyType);
        }
        else
        {
            body = RustExpressionTranslator.StripOuterParens(
                translator.Translate(m.Initializer!, RustExpressionTranslator.NameMode.Property, EnumExpectedRef(m, typeMapper)));
            TypeRef? bodyType = translator.InferType(m.Initializer!);

            // Reconcile the body's inferred numeric type with the declared (underlying) type. Rust has no
            // implicit numeric widening, so an `Int`-inferred body in a `-> Decimal` getter (a widening C#
            // does for free) must be wrapped in `Decimal::from(...)` or rustc rejects it as E0308 (#961) —
            // the derived-member dual of the scalar-operator coercion #937 fixed. Takes precedence over
            // the clone/`to_string` cases below (the wrapped value is always a `Copy` primitive, so no
            // clone is owed). Coercing against `underlyingType` (rather than `m.Type`) extends this to an
            // optional-declared member's bare, always-present numeric body (#1329).
            if (NumericCoercionWrap(underlyingType, bodyType) is { } wrap)
            {
                body = $"{wrap}({body})";
            }
            // A String-typed derived member whose body yields a borrowed &str (e.g. `name.trim`) must be
            // owned; a bare non-Copy field read must be cloned out of `&self`. Gated on `underlyingType`
            // (not `m.Type`) so an optional-declared `String?` member's `.trim()` body is owned too,
            // before `SomeWrapIfNeeded` below wraps it (#1332, mirrors #1325's constant-default fix).
            else if (underlyingType is { Name: "String" } && body.EndsWith(".trim()", StringComparison.Ordinal))
            {
                body += ".to_string()";
            }
            else if (m.Initializer is IdentifierExpr or MemberAccessExpr && !typeMapper.IsCopy(m.Type))
            {
                body += ".clone()";
            }

            body = SomeWrapIfNeeded(body, m.Type, bodyType);
        }

        WriteDoc(sb, m.Doc, Indent);
        sb.Append(Indent).Append("pub fn ").Append(field).Append("(&self) -> ").Append(typeMapper.Map(m.Type))
          .Append(" {\n");
        sb.Append(Indent).Append(Indent).Append(body).Append('\n');
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// Wraps <paramref name="body"/> in <c>Some(...)</c> when <paramref name="declared"/> is optional and
    /// <paramref name="bodyType"/> is itself definitely non-optional — an always-present value rendered
    /// against an <c>Option&lt;...&gt;</c>-returning accessor. Left unchanged when <paramref name="bodyType"/>
    /// is optional (or unknown), since such a body may already render as <c>Option</c>-shaped and a second
    /// wrap here would double-wrap it (#1329). Shared by <see cref="WriteDerived"/>'s two coercion call
    /// sites (the bare-body branch and the <c>ConditionalExpr</c>/<c>LetExpr</c>/<c>GuardExpr</c>
    /// owned-value branch).
    /// </summary>
    private static string SomeWrapIfNeeded(string body, TypeRef declared, TypeRef? bodyType) =>
        declared.IsOptional && bodyType is { IsOptional: false } ? $"Some({body})" : body;

    /// <summary>
    /// The Rust conversion function to wrap a derived member's body in when its inferred numeric type
    /// differs from its <paramref name="declared"/> type, or <c>null</c> when none is needed. Widening
    /// (<c>Int</c> body → <c>Decimal</c> declared) uses <c>Decimal::from</c> (#961); the narrowing dual
    /// (<c>Decimal</c> body → <c>Int</c> declared) uses <c>dec_to_i64</c>, mirroring <see cref="ScaleField"/>
    /// — that case is normally rejected upstream by the semantic validator (<c>KOI0217</c>), so the branch
    /// is defensive for direct emitter use. Same-type, non-numeric, and optional numeric bodies (which
    /// interact with <c>Option</c> wrapping and are out of scope) are left unchanged.
    /// </summary>
    private static string? NumericCoercionWrap(TypeRef declared, TypeRef? bodyType)
    {
        if (bodyType is null || declared.IsOptional || bodyType.IsOptional
            || !TypeResolver.IsNumeric(declared) || !TypeResolver.IsNumeric(bodyType)
            || declared.Name == bodyType.Name)
        {
            return null;
        }
        return declared.Name == "Decimal" ? "Decimal::from" : "crate::koine_runtime::dec_to_i64";
    }

    /// <summary>
    /// The non-optional view of a possibly-optional-declared type — gate ownership/coercion checks on
    /// this, never on <paramref name="declared"/> directly, or an optional-declared member's own bare
    /// or defaulted value falls through to the wrong branch (#1319/#1324, #1325, #1332: the same
    /// missing-underlying-type-check shape, independently discovered three times before this helper
    /// existed).
    /// </summary>
    private static TypeRef UnderlyingType(TypeRef declared) =>
        declared.IsOptional ? declared with { IsOptional = false } : declared;

    // ----------------------------------------------------------------------
    // Demand-driven operators
    // ----------------------------------------------------------------------

    /// <summary>
    /// The trailing-parameter carry-forward expression for a <c>defaultedParams</c> member (#1436): a
    /// plain-typed field's owned expression is <c>Some(...)</c>-wrapped to match its <c>Option&lt;T&gt;</c>
    /// constructor parameter. An already-optional-declared field (#1463) is already <c>Option</c>-shaped —
    /// wrapping it again would double-wrap into <c>Option&lt;Option&lt;T&gt;&gt;</c>, a real <c>cargo
    /// check</c> <c>E0308</c> against the constructor parameter — so it's passed through unwrapped.
    /// Reuses <see cref="SomeWrapIfNeeded"/> (the same "wrap unless already Option-shaped" rule
    /// <see cref="WriteDerived"/> applies): the target is always the ctor's <c>Option&lt;T&gt;</c>
    /// parameter shape, and the expression's current type is always <paramref name="m"/>'s own declared
    /// type, since <paramref name="ownedFieldExpr"/> reads straight off the struct field.
    /// </summary>
    private static string CarriedDefaultedArg(Member m, string ownedFieldExpr) =>
        SomeWrapIfNeeded(ownedFieldExpr, m.Type with { IsOptional = true }, m.Type);

    /// <summary>A scalar <c>Mul</c>/<c>Div</c> (e.g. <c>Money * quantity</c> or <c>fee / 2</c>): applies
    /// <paramref name="op"/> to each numeric field, carries the rest, and rebuilds through the validating
    /// constructor (#1270). <paramref name="op"/> is <c>"*"</c> or <c>"/"</c>. Each trailing
    /// <paramref name="defaultedParams"/> member (#1436/#1463) is carried from <c>self</c> via
    /// <see cref="CarriedDefaultedArg"/>, not reset to its default — the operator's <c>self</c> is owned,
    /// so no clone is needed, mirroring how a non-numeric <paramref name="required"/> field is already
    /// carried below.</summary>
    private void WriteScalarOp(
        StringBuilder sb, string name, IReadOnlyList<Member> required, IReadOnlyList<Member> defaultedParams,
        IReadOnlySet<string> scalars, string op)
    {
        bool isDiv = op == "/";
        var trait = isDiv ? "Div" : "Mul";
        var fn = isDiv ? "div" : "mul";
        var param = OperandName(required, isDiv ? "divisor" : "factor");

        foreach (var (rustFactor, isDecimal) in ScalarFactors(scalars))
        {
            var args = required.Select(m => ScaleField(m, "self." + RustNaming.Field(m.Name), param, isDecimal, op))
                .Concat(defaultedParams.Select(m => CarriedDefaultedArg(m, "self." + RustNaming.Field(m.Name))));

            sb.Append('\n');
            sb.Append("impl std::ops::").Append(trait).Append('<').Append(rustFactor).Append("> for ").Append(name).Append(" {\n");
            sb.Append(Indent).Append("type Output = ").Append(name).Append(";\n");
            sb.Append(Indent).Append("fn ").Append(fn).Append("(self, ").Append(param).Append(": ").Append(rustFactor).Append(") -> ").Append(name).Append(" {\n");
            WriteValidatingConstruction(sb, name, args, op);
            sb.Append(Indent).Append("}\n");
            sb.Append("}\n");
        }
    }

    /// <summary>An additive <c>Add</c>/<c>Sub</c> (for <c>sum</c> folds and plain value-object arithmetic,
    /// #887): applies <paramref name="op"/> to each numeric field pairwise, carries the rest from self, and
    /// rebuilds through the validating constructor (#1270). <paramref name="op"/> is <c>"+"</c> or <c>"-"</c>.
    /// Each trailing <paramref name="defaultedParams"/> member (#1436/#1463) is likewise carried from
    /// <c>self</c> via <see cref="CarriedDefaultedArg"/>, not reset to its default — e.g. combining two
    /// <c>Money</c> whose overridden <c>currency</c> is <c>Usd</c> must not silently coerce the result back
    /// to the declared default (the <c>EUR + USD -&gt; EUR</c> failure mode the C# emitter's own
    /// carried-member handling guards against). <c>self</c> is owned here, so no clone is needed.</summary>
    private void WriteAdditiveOp(
        StringBuilder sb, string name, IReadOnlyList<Member> required, IReadOnlyList<Member> defaultedParams, string op)
    {
        bool isSub = op == "-";
        var trait = isSub ? "Sub" : "Add";
        var fn = isSub ? "sub" : "add";
        var other = OperandName(required, "other");

        var args = required.Select(m =>
        {
            var f = RustNaming.Field(m.Name);
            return IsNumericField(m)
                ? m.Type.IsOptional
                    ? $"self.{f}.zip({other}.{f}).map(|(a, b)| a {op} b)"
                    : $"self.{f} {op} {other}.{f}"
                : "self." + f;
        }).Concat(defaultedParams.Select(m => CarriedDefaultedArg(m, "self." + RustNaming.Field(m.Name))));

        sb.Append('\n');
        sb.Append("impl std::ops::").Append(trait).Append(" for ").Append(name).Append(" {\n");
        sb.Append(Indent).Append("type Output = ").Append(name).Append(";\n");
        sb.Append(Indent).Append("fn ").Append(fn).Append("(self, ").Append(other).Append(": ").Append(name).Append(") -> ").Append(name).Append(" {\n");
        WriteValidatingConstruction(sb, name, args, op);
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");
    }

    /// <summary>
    /// The shared body of a demand-driven operator: rebuild the result through the value object's own
    /// validating constructor so every declared <c>invariant</c> runs on it, exactly as it would on a
    /// hand-written <c>Name::new(...)</c> (#1270). Before this, both writers emitted a raw
    /// <c>Name { field: ... }</c> struct literal, which skips <c>new</c> entirely — so
    /// <c>Money::new(dec(10)).unwrap() * -20</c> silently produced a negative <c>Money</c>.
    /// <para>
    /// The <c>std::ops</c> traits are infallible by contract — <c>Mul::Output</c> cannot be a
    /// <c>Result</c> without breaking operator chaining (<c>fee * 2 / 3</c>) and the <c>koine_sum</c>
    /// fold, whose <c>T: std::ops::Add&lt;Output = T&gt;</c> bound a <c>Result</c>-returning <c>Add</c>
    /// would no longer satisfy — so a violated invariant surfaces as a panic carrying the
    /// <c>DomainError</c>. That is the exact Rust analogue of the C# emitter's <c>=&gt; new Money(args)</c>,
    /// whose constructor <em>throws</em> on the same violation, and it mirrors how the emitted runtime
    /// already panics on an unrepresentable narrowing (<c>dec_to_i64</c>). Callers wanting a
    /// <c>Result</c> keep the ordinary route: <c>Name::new(...)</c> itself.
    /// </para>
    /// </summary>
    private static void WriteValidatingConstruction(StringBuilder sb, string name, IEnumerable<string> args, string op)
    {
        sb.Append(Indent).Append(Indent).Append(name).Append("::new(").Append(string.Join(", ", args)).Append(")\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append(".expect(\"").Append(name).Append(": `").Append(op).Append("` violated an invariant\")\n");
    }

    /// <summary>
    /// The operator's operand parameter name, underscore-prefixed when no constructor parameter is
    /// numeric — every numeric field then carries a constant default, so the validating constructor
    /// re-derives it and the operand is genuinely unread. Keeps the emitted crate warning-free.
    /// </summary>
    private static string OperandName(IReadOnlyList<Member> required, string name) =>
        required.Any(IsNumericField) ? name : "_" + name;

    /// <summary>
    /// True when a member is one of the two numeric field types an arithmetic operator scales or
    /// combines (optional or not — <c>Int?</c> still names <c>Int</c>); every other field is carried
    /// through unchanged.
    /// </summary>
    private static bool IsNumericField(Member m) => m.Type.Name is "Int" or "Decimal";

    /// <summary>
    /// A quantity's unit-checked <c>add</c>/<c>sub</c> (returning <c>Result</c>) and scalar <c>scale</c>.
    /// All three rebuild their result through the validating constructor <c>Name::new(...)</c> rather
    /// than a raw struct literal, so every declared <c>invariant</c> runs on the result too — the
    /// quantity-inherent-method sibling of the demand-driven operator fix in
    /// <see cref="WriteValidatingConstruction"/> (#1270, #1318). <c>add</c>/<c>sub</c> return
    /// <c>Result</c> already, so the unit-mismatch guard and the invariant check compose: <c>new</c>'s
    /// own <c>Result</c> becomes the method's return value directly. <c>scale</c> is infallible by
    /// signature, so it <c>.expect(...)</c>s the constructor, mirroring #1270's infallible operator
    /// bodies (and reusing <see cref="WriteValidatingConstruction"/> for the same message shape).
    /// </summary>
    private void WriteQuantityOps(
        StringBuilder sb, string name, IReadOnlyList<Member> required, IReadOnlyList<Member> defaultedParams,
        IReadOnlyList<Member> stored, RustTypeMapper typeMapper)
    {
        Member? amount = stored.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = stored.FirstOrDefault(m => !ReferenceEquals(m, amount) && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return;
        }

        var amt = RustNaming.Field(amount.Name);
        var u = RustNaming.Field(unit.Name);

        // A constant-default `amount`/`unit` is absent from `required`, so `new(...)` can't be handed
        // the combined/scaled value for it — that field is domain-nonsensical for a quantity anyway
        // (its whole point is a per-instance amount and a checked-but-real unit), but semantics doesn't
        // reject it (#1318's stated scope is emitter-local, not `Semantics/`). `RustExpressionTranslator`
        // unconditionally lowers a quantity's `+`/`-` to `.add`/`.sub`, so silently emitting NEITHER
        // method here — as an earlier version of this fix did — leaves the call site calling a method
        // that no longer exists (a real `cargo` E0599), which is worse than the invariant gap #1318 is
        // fixing. So fall back to the pre-#1318 raw-literal construction for just this edge case,
        // preserving the shape (and thus the compilability) call sites already depend on; the common —
        // and only sensible — case still gets the validating-constructor fix below.
        bool canRouteThroughNew = !HasConstantDefault(amount) && !HasConstantDefault(unit);

        string RawLiteral(string amtExpr) =>
            name + " {\n" + string.Concat(stored.Select(m =>
            {
                var f = RustNaming.Field(m.Name);
                var v = ReferenceEquals(m, amount) ? amtExpr : "self." + f;
                return Indent + Indent + Indent + f + ": " + v + ",\n";
            })) + Indent + Indent + "}";

        // Builds the `Name::new(...)` argument list over `required`, in declared order, substituting
        // `amtExpr` for the amount field, then a trailing carried-forward arg per `defaultedParams` member
        // (#1436/#1463, via `CarriedDefaultedArg`) — carried from `self`, not reset to its default, for the
        // same reason `WriteAdditiveOp`/`WriteScalarOp` carry theirs. The `&self` receiver means any
        // non-`Copy` carried field (required or defaulted) must be cloned out of `self` (units are `Copy`
        // enums, so the common case clones nothing).
        IEnumerable<string> NewArgs(string amtExpr) =>
            required.Select(m =>
            {
                if (ReferenceEquals(m, amount))
                {
                    return amtExpr;
                }
                var f = "self." + RustNaming.Field(m.Name);
                return typeMapper.IsCopy(m.Type) ? f : f + ".clone()";
            }).Concat(defaultedParams.Select(m =>
            {
                var f = "self." + RustNaming.Field(m.Name);
                var owned = typeMapper.IsCopy(m.Type) ? f : f + ".clone()";
                return CarriedDefaultedArg(m, owned);
            }));

        sb.Append('\n');
        sb.Append("impl ").Append(name).Append(" {\n");
        foreach (var (method, op) in new[] { ("add", "+"), ("sub", "-") })
        {
            sb.Append(Indent).Append("/// Combines two quantities, requiring matching units.\n");
            sb.Append(Indent).Append("pub fn ").Append(method).Append("(&self, other: &").Append(name)
              .Append(") -> Result<").Append(name).Append(", DomainError> {\n");
            sb.Append(Indent).Append(Indent).Append("if self.").Append(u).Append(" != other.").Append(u).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("return Err(DomainError::UnitMismatch { type_name: \"").Append(name).Append("\" });\n");
            sb.Append(Indent).Append(Indent).Append("}\n");
            var amtExpr = $"self.{amt} {op} other.{amt}";
            if (canRouteThroughNew)
            {
                sb.Append(Indent).Append(Indent).Append(name).Append("::new(")
                  .Append(string.Join(", ", NewArgs(amtExpr))).Append(")\n");
            }
            else
            {
                sb.Append(Indent).Append(Indent).Append("Ok(").Append(RawLiteral(amtExpr)).Append(")\n");
            }
            sb.Append(Indent).Append("}\n\n");
        }

        sb.Append(Indent).Append("/// Scales the amount by a factor, carrying the unit.\n");
        sb.Append(Indent).Append("pub fn scale(&self, factor: Decimal) -> ").Append(name).Append(" {\n");
        var scaleExpr = $"self.{amt} * factor";
        if (canRouteThroughNew)
        {
            WriteValidatingConstruction(sb, name, NewArgs(scaleExpr), "scale");
        }
        else
        {
            sb.Append(Indent).Append(Indent).Append(RawLiteral(scaleExpr)).Append('\n');
        }
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");
    }

    /// <summary>The Rust factor types for a set of scalar needs, each with whether it is Decimal-typed.</summary>
    private static IEnumerable<(string RustType, bool IsDecimal)> ScalarFactors(IReadOnlySet<string> scalars)
    {
        if (scalars.Contains("int"))
        {
            yield return ("i64", false);
        }
        if (scalars.Contains("decimal"))
        {
            yield return ("Decimal", true);
        }
        if (!scalars.Contains("int") && !scalars.Contains("decimal"))
        {
            yield return ("i64", false);
        }
    }

    /// <summary>Applies <paramref name="op"/> (<c>"*"</c>/<c>"/"</c>) to one field expression against an
    /// operand (factor or divisor), coercing across Int/Decimal as needed.</summary>
    private static string ScaleField(Member m, string fieldExpr, string operand, bool operandIsDecimal, string op)
    {
        // An optional numeric field is Option<T>; the operator (and Decimal::from) can't apply to it
        // directly, so map over it and run the exact non-optional coercion on the unwrapped value `v`.
        var lhs = m.Type.IsOptional ? "v" : fieldExpr;
        var coercion = m.Type.Name switch
        {
            "Decimal" => operandIsDecimal ? $"{lhs} {op} {operand}" : $"{lhs} {op} Decimal::from({operand})",
            "Int" => operandIsDecimal
                ? $"crate::koine_runtime::dec_to_i64(Decimal::from({lhs}) {op} {operand})"
                : $"{lhs} {op} {operand}",
            _ => null,
        };
        return WrapOptional(m, fieldExpr, coercion);
    }

    /// <summary>
    /// Renders a per-field coercion: a non-numeric field (<paramref name="coercion"/> is null) passes
    /// through unchanged; an optional numeric field maps the coercion (written against a bound <c>v</c>)
    /// over its <c>Option</c>; a non-optional numeric field returns the coercion directly (byte-identical
    /// to the pre-optional behaviour).
    /// </summary>
    private static string WrapOptional(Member m, string fieldExpr, string? coercion)
    {
        if (coercion is null)
        {
            return fieldExpr;
        }

        return m.Type.IsOptional ? $"{fieldExpr}.map(|v| {coercion})" : coercion;
    }

    /// <summary>True when a stored member carries a constant default (an initializer that is not derived).</summary>
    private static bool HasConstantDefault(Member m) => m.Initializer is not null;

    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;

    private static string? EnumExpectedRef(Member m, RustTypeMapper typeMapper) =>
        typeMapper.IsEnum(m.Type) ? m.Type.Name : null;
}
