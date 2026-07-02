using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The value-object slice of <see cref="RustEmitter"/>. A Koine <c>value</c> emits as a struct with
/// private fields and a smart constructor <c>new(...) -&gt; Result&lt;Self, DomainError&gt;</c> that
/// runs the invariants before constructing; stored fields are exposed through accessors (by value for
/// <c>Copy</c> types, by <c>&amp;str</c>/<c>&amp;T</c> otherwise), constant-default members are set
/// inside <c>new</c>, and derived (computed) members become get-only methods. Demand-driven operators
/// (scalar <c>Mul</c>, additive <c>Add</c>) are emitted only where the model actually uses them
/// (mirroring the C#/Python emitters). A <c>quantity</c> additionally gets unit-checked
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

        // Demand-driven / quantity operators.
        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, name, stored);
        }
        else
        {
            if (emit.ScalarNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? scalars)
                && stored.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarMul(sb, name, stored, scalars);
            }
            // `Div` is the division dual of `Mul` (#879, follow-up to the C# emitter's #832):
            // demand-generated only where the model actually divides this value object by a scalar
            // (fee / 2), never emitted unconditionally.
            if (emit.ScalarDivNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? divScalars)
                && stored.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarDiv(sb, name, stored, divScalars);
            }
            if (emit.AdditiveNeeds.Contains(vo.Name))
            {
                WriteAdditiveAdd(sb, name, stored);
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
        var body = RustExpressionTranslator.StripOuterParens(
            translator.Translate(m.Initializer!, RustExpressionTranslator.NameMode.Property, EnumExpectedRef(m, typeMapper)));

        // A String-typed derived member whose body yields a borrowed &str (e.g. `name.trim`) must be
        // owned; a bare non-Copy field read must be cloned out of `&self`.
        if (m.Type is { Name: "String", IsOptional: false } && body.EndsWith(".trim()", StringComparison.Ordinal))
        {
            body += ".to_string()";
        }
        else if (m.Initializer is IdentifierExpr or MemberAccessExpr && !typeMapper.IsCopy(m.Type))
        {
            body += ".clone()";
        }

        WriteDoc(sb, m.Doc, Indent);
        sb.Append(Indent).Append("pub fn ").Append(field).Append("(&self) -> ").Append(typeMapper.Map(m.Type))
          .Append(" {\n");
        sb.Append(Indent).Append(Indent).Append(body).Append('\n');
        sb.Append(Indent).Append("}\n");
    }

    // ----------------------------------------------------------------------
    // Demand-driven operators
    // ----------------------------------------------------------------------

    /// <summary>A scalar <c>Mul</c> (e.g. <c>Money * quantity</c>): scales each numeric field, carries the rest.</summary>
    private void WriteScalarMul(StringBuilder sb, string name, IReadOnlyList<Member> fields, IReadOnlySet<string> scalars)
    {
        foreach (var (rustFactor, isDecimal) in ScalarFactors(scalars))
        {
            sb.Append('\n');
            sb.Append("impl std::ops::Mul<").Append(rustFactor).Append("> for ").Append(name).Append(" {\n");
            sb.Append(Indent).Append("type Output = ").Append(name).Append(";\n");
            sb.Append(Indent).Append("fn mul(self, factor: ").Append(rustFactor).Append(") -> ").Append(name).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append(name).Append(" {\n");
            foreach (Member m in fields)
            {
                var f = RustNaming.Field(m.Name);
                sb.Append(Indent).Append(Indent).Append(Indent).Append(f).Append(": ")
                  .Append(ScaleField(m, "self." + f, "factor", isDecimal)).Append(",\n");
            }
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append("}\n");
            sb.Append("}\n");
        }
    }

    /// <summary>A scalar <c>Div</c> (e.g. <c>fee / 2</c>): the division dual of <see cref="WriteScalarMul"/>, dividing each numeric field, carrying the rest.</summary>
    private void WriteScalarDiv(StringBuilder sb, string name, IReadOnlyList<Member> fields, IReadOnlySet<string> scalars)
    {
        foreach (var (rustFactor, isDecimal) in ScalarFactors(scalars))
        {
            sb.Append('\n');
            sb.Append("impl std::ops::Div<").Append(rustFactor).Append("> for ").Append(name).Append(" {\n");
            sb.Append(Indent).Append("type Output = ").Append(name).Append(";\n");
            sb.Append(Indent).Append("fn div(self, divisor: ").Append(rustFactor).Append(") -> ").Append(name).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append(name).Append(" {\n");
            foreach (Member m in fields)
            {
                var f = RustNaming.Field(m.Name);
                sb.Append(Indent).Append(Indent).Append(Indent).Append(f).Append(": ")
                  .Append(DivideField(m, "self." + f, "divisor", isDecimal)).Append(",\n");
            }
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append("}\n");
            sb.Append("}\n");
        }
    }

    /// <summary>An additive <c>Add</c> (for <c>sum</c> folds): adds numeric fields pairwise, carries the rest from self.</summary>
    private void WriteAdditiveAdd(StringBuilder sb, string name, IReadOnlyList<Member> fields)
    {
        sb.Append('\n');
        sb.Append("impl std::ops::Add for ").Append(name).Append(" {\n");
        sb.Append(Indent).Append("type Output = ").Append(name).Append(";\n");
        sb.Append(Indent).Append("fn add(self, other: ").Append(name).Append(") -> ").Append(name).Append(" {\n");
        sb.Append(Indent).Append(Indent).Append(name).Append(" {\n");
        foreach (Member m in fields)
        {
            var f = RustNaming.Field(m.Name);
            var value = m.Type.Name is "Int" or "Decimal" ? $"self.{f} + other.{f}" : "self." + f;
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

    /// <summary>Scales one field expression by a factor, coercing across Int/Decimal as needed.</summary>
    private static string ScaleField(Member m, string fieldExpr, string factor, bool factorIsDecimal)
    {
        return m.Type.Name switch
        {
            "Decimal" => factorIsDecimal ? $"{fieldExpr} * {factor}" : $"{fieldExpr} * Decimal::from({factor})",
            "Int" => factorIsDecimal
                ? $"crate::koine_runtime::dec_to_i64(Decimal::from({fieldExpr}) * {factor})"
                : $"{fieldExpr} * {factor}",
            _ => fieldExpr,
        };
    }

    /// <summary>Divides one field expression by a divisor, coercing across Int/Decimal as needed — the division dual of <see cref="ScaleField"/>.</summary>
    private static string DivideField(Member m, string fieldExpr, string divisor, bool divisorIsDecimal)
    {
        return m.Type.Name switch
        {
            "Decimal" => divisorIsDecimal ? $"{fieldExpr} / {divisor}" : $"{fieldExpr} / Decimal::from({divisor})",
            "Int" => divisorIsDecimal ? fieldExpr : $"{fieldExpr} / {divisor}",
            _ => fieldExpr,
        };
    }

    /// <summary>True when a stored member carries a constant default (an initializer that is not derived).</summary>
    private static bool HasConstantDefault(Member m) => m.Initializer is not null;

    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;

    private static string? EnumExpectedRef(Member m, RustTypeMapper typeMapper) =>
        typeMapper.IsEnum(m.Type) ? m.Type.Name : null;
}
