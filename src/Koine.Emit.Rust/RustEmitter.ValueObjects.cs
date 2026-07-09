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
/// model actually uses them (mirroring the C#/Python emitters). A <c>quantity</c> additionally gets unit-checked
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
        WriteSmartConstructor(sb, emit, name, vo, required, stored, translator, typeMapper);

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
            WriteQuantityOps(sb, name, stored);
        }

        // A quantity's scalar Mul/Div (`base * 2`, `fee / 2`) has no unit to check — unlike its Add/Sub,
        // which route through the unit-checked inherent methods `WriteQuantityOps` emits above — so a
        // quantity shares the exact same demand-driven `impl std::ops::Mul`/`Div` a plain VO gets below
        // (#1084, sibling of #1068's Add/Sub fix). Before #1084, `RustExpressionTranslator.WriteBinary`
        // still lowered a quantity's `* scalar`/`/ scalar` to the native operator with no backing impl —
        // a real `cargo check` E0369.
        IReadOnlySet<string>? scalars = needs?.MultiplyFactors;
        if (scalars is { Count: > 0 }
            && stored.Any(m => m.Type.Name is "Int" or "Decimal"))
        {
            WriteScalarOp(sb, name, stored, scalars, "*");
        }
        // `Div` is the division dual of `Mul` (#879, follow-up to the C# emitter's #832):
        // demand-generated only where the model actually divides this value object by a scalar
        // (fee / 2), never emitted unconditionally.
        IReadOnlySet<string>? divScalars = needs?.DivideFactors;
        if (divScalars is { Count: > 0 }
            && stored.Any(m => m.Type.Name is "Int" or "Decimal"))
        {
            WriteScalarOp(sb, name, stored, divScalars, "/");
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
                WriteAdditiveOp(sb, name, stored, "+");
            }
            if (needsSub)
            {
                WriteAdditiveOp(sb, name, stored, "-");
            }
        }
    }

    private void WriteSmartConstructor(
        StringBuilder sb, RustEmitContext emit, string name, ValueObjectDecl vo,
        IReadOnlyList<Member> required, IReadOnlyList<Member> stored,
        RustExpressionTranslator translator, RustTypeMapper typeMapper)
    {
        var paramList = string.Join(", ", required.Select(m => RustNaming.Field(m.Name) + ": " + typeMapper.Map(m.Type)));
        sb.Append(Indent).Append("/// Creates a validated `").Append(name).Append("`, running its invariants.\n");
        sb.Append(Indent).Append("pub fn new(").Append(paramList).Append(") -> Result<Self, DomainError> {\n");

        foreach (Invariant inv in vo.Invariants)
        {
            WriteInvariantGuard(sb, name, inv, translator, Indent + Indent);
        }

        // Construct: required fields bind their params; constant-default fields take their default expr.
        sb.Append(Indent).Append(Indent).Append("Ok(Self {\n");
        foreach (Member m in stored)
        {
            sb.Append(Indent).Append(Indent).Append(Indent).Append(RustNaming.Field(m.Name));
            if (HasConstantDefault(m))
            {
                sb.Append(": ").Append(translator.Translate(m.Initializer!, RustExpressionTranslator.NameMode.Parameter, EnumExpected(m, emit.Index)));
            }
            sb.Append(",\n");
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

        // A bare conditional/let/guard body (no arithmetic operator at all) has its own recursive
        // owned-value dispatch — a leaf place a branch would otherwise move out of `&self` must be
        // cloned, which neither the clone/`to_string` handling below (it only recognizes a bare
        // `IdentifierExpr`/`MemberAccessExpr` initializer) nor a plain `Translate` provide (#1282,
        // generalizing #1268's quantity-guard fix).
        if (m.Initializer is ConditionalExpr or LetExpr or GuardExpr)
        {
            body = translator.TranslateOwned(m.Initializer!, EnumExpectedRef(m, typeMapper));
            if (NumericCoercionWrap(m.Type, translator.InferType(m.Initializer!)) is { } ownedWrap)
            {
                body = $"{ownedWrap}({body})";
            }
        }
        else
        {
            body = RustExpressionTranslator.StripOuterParens(
                translator.Translate(m.Initializer!, RustExpressionTranslator.NameMode.Property, EnumExpectedRef(m, typeMapper)));

            // Reconcile the body's inferred numeric type with the declared type. Rust has no implicit
            // numeric widening, so an `Int`-inferred body in a `-> Decimal` getter (a widening C# does
            // for free) must be wrapped in `Decimal::from(...)` or rustc rejects it as E0308 (#961) — the
            // derived-member dual of the scalar-operator coercion #937 fixed. Takes precedence over the
            // clone/`to_string` cases below (the wrapped value is always a `Copy` primitive, so no clone
            // is owed).
            if (NumericCoercionWrap(m.Type, translator.InferType(m.Initializer!)) is { } wrap)
            {
                body = $"{wrap}({body})";
            }
            // A String-typed derived member whose body yields a borrowed &str (e.g. `name.trim`) must be
            // owned; a bare non-Copy field read must be cloned out of `&self`.
            else if (m.Type is { Name: "String", IsOptional: false } && body.EndsWith(".trim()", StringComparison.Ordinal))
            {
                body += ".to_string()";
            }
            else if (m.Initializer is IdentifierExpr or MemberAccessExpr && !typeMapper.IsCopy(m.Type))
            {
                body += ".clone()";
            }
        }

        WriteDoc(sb, m.Doc, Indent);
        sb.Append(Indent).Append("pub fn ").Append(field).Append("(&self) -> ").Append(typeMapper.Map(m.Type))
          .Append(" {\n");
        sb.Append(Indent).Append(Indent).Append(body).Append('\n');
        sb.Append(Indent).Append("}\n");
    }

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

    // ----------------------------------------------------------------------
    // Demand-driven operators
    // ----------------------------------------------------------------------

    /// <summary>A scalar <c>Mul</c>/<c>Div</c> (e.g. <c>Money * quantity</c> or <c>fee / 2</c>): applies
    /// <paramref name="op"/> to each numeric field, carries the rest. <paramref name="op"/> is <c>"*"</c> or <c>"/"</c>.</summary>
    private void WriteScalarOp(StringBuilder sb, string name, IReadOnlyList<Member> fields, IReadOnlySet<string> scalars, string op)
    {
        bool isDiv = op == "/";
        var trait = isDiv ? "Div" : "Mul";
        var fn = isDiv ? "div" : "mul";
        var param = isDiv ? "divisor" : "factor";

        foreach (var (rustFactor, isDecimal) in ScalarFactors(scalars))
        {
            sb.Append('\n');
            sb.Append("impl std::ops::").Append(trait).Append('<').Append(rustFactor).Append("> for ").Append(name).Append(" {\n");
            sb.Append(Indent).Append("type Output = ").Append(name).Append(";\n");
            sb.Append(Indent).Append("fn ").Append(fn).Append("(self, ").Append(param).Append(": ").Append(rustFactor).Append(") -> ").Append(name).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append(name).Append(" {\n");
            foreach (Member m in fields)
            {
                var f = RustNaming.Field(m.Name);
                sb.Append(Indent).Append(Indent).Append(Indent).Append(f).Append(": ")
                  .Append(ScaleField(m, "self." + f, param, isDecimal, op)).Append(",\n");
            }
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append("}\n");
            sb.Append("}\n");
        }
    }

    /// <summary>An additive <c>Add</c>/<c>Sub</c> (for <c>sum</c> folds and plain value-object arithmetic,
    /// #887): applies <paramref name="op"/> to each numeric field pairwise, carries the rest from self.
    /// <paramref name="op"/> is <c>"+"</c> or <c>"-"</c>.</summary>
    private void WriteAdditiveOp(StringBuilder sb, string name, IReadOnlyList<Member> fields, string op)
    {
        bool isSub = op == "-";
        var trait = isSub ? "Sub" : "Add";
        var fn = isSub ? "sub" : "add";

        sb.Append('\n');
        sb.Append("impl std::ops::").Append(trait).Append(" for ").Append(name).Append(" {\n");
        sb.Append(Indent).Append("type Output = ").Append(name).Append(";\n");
        sb.Append(Indent).Append("fn ").Append(fn).Append("(self, other: ").Append(name).Append(") -> ").Append(name).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append(name).Append(" {\n");
        foreach (Member m in fields)
        {
            var f = RustNaming.Field(m.Name);
            var value = m.Type.Name is "Int" or "Decimal"
                ? m.Type.IsOptional
                    ? $"self.{f}.zip(other.{f}).map(|(a, b)| a {op} b)"
                    : $"self.{f} {op} other.{f}"
                : "self." + f;
            sb.Append(Indent).Append(Indent).Append(Indent).Append(f).Append(": ").Append(value).Append(",\n");
        }
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");
        sb.Append("}\n");
    }

    /// <summary>A quantity's unit-checked <c>add</c>/<c>sub</c> (returning Result) and scalar <c>scale</c>.</summary>
    private void WriteQuantityOps(StringBuilder sb, string name, IReadOnlyList<Member> fields)
    {
        Member? amount = fields.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = fields.FirstOrDefault(m => !ReferenceEquals(m, amount) && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return;
        }

        var amt = RustNaming.Field(amount.Name);
        var u = RustNaming.Field(unit.Name);

        string Construct(string amtExpr) =>
            name + " {\n" + string.Concat(fields.Select(m =>
            {
                var f = RustNaming.Field(m.Name);
                var v = ReferenceEquals(m, amount) ? amtExpr : "self." + f;
                return Indent + Indent + Indent + f + ": " + v + ",\n";
            })) + Indent + Indent + "}";

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
            sb.Append(Indent).Append(Indent).Append("Ok(").Append(Construct($"self.{amt} {op} other.{amt}")).Append(")\n");
            sb.Append(Indent).Append("}\n\n");
        }

        sb.Append(Indent).Append("/// Scales the amount by a factor, carrying the unit.\n");
        sb.Append(Indent).Append("pub fn scale(&self, factor: Decimal) -> ").Append(name).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append(Construct($"self.{amt} * factor")).Append('\n');
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
