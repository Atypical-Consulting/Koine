using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// The value-object slice of <see cref="PythonEmitter"/>. A Koine <c>value</c> emits as a
/// <c>@dataclass(frozen=True)</c>: stored members are typed fields, constant defaults are dataclass
/// defaults, computed (derived) members are <c>@property</c> getters, and invariants run in
/// <c>__post_init__</c> raising <see cref="PyRuntime"/>'s <c>DomainInvariantViolationError</c>.
/// Frozen-dataclass equality and hashing come free from <c>frozen=True</c> (structural by field).
/// A <c>quantity</c> additionally gets unit-checked <c>__add__</c>/<c>__sub__</c> and scalar
/// <c>__mul__</c>/<c>__truediv__</c> dunder operators (mirroring the C#/TS quantity semantics).
/// </summary>
public sealed partial class PythonEmitter
{
    private EmittedFile EmitValueObject(PyEmitContext emit, ValueObjectDecl vo, string ns, PythonTypeMapper typeMapper)
    {
        var name = PythonNaming.ToPascalCase(vo.Name);
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);

        // Stored/default members become dataclass fields; derived members become @property getters.
        var fields = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        // Dataclass requires non-defaulted fields before defaulted ones. A constant-default member
        // (Initializer present, not derived) carries a default; an optional field defaults to None.
        var ordered = fields.OrderBy(m => HasDefault(m) ? 1 : 0).ToList();

        var translator = new PythonExpressionTranslator(emit.Index, vo.Members, emit.EnumMemberToType, typeMapper, ContextOf(ns));

        var sb = new StringBuilder();
        sb.Append("@dataclass(frozen=True)\n");
        sb.Append("class ").Append(name).Append(":\n");

        var classDoc = vo.Doc;
        if (!string.IsNullOrEmpty(classDoc))
        {
            WriteDoc(sb, classDoc, Indent);
        }

        // Fields.
        if (ordered.Count == 0 && string.IsNullOrEmpty(classDoc) && vo.Invariants.Count == 0 && derived.Count == 0 && !vo.IsQuantity)
        {
            sb.Append(Indent).Append("pass\n");
        }

        foreach (Member m in ordered)
        {
            WriteDoc(sb, m.Doc, Indent);
            var field = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            sb.Append(Indent).Append(field).Append(": ").Append(typeMapper.Map(m.Type));
            if (DefaultExpr(m, translator, emit.Index) is { } def)
            {
                sb.Append(" = ").Append(def);
            }
            sb.Append('\n');
        }

        // Invariants run in __post_init__ once all fields are bound (self.<field> reads).
        if (vo.Invariants.Count > 0)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("def __post_init__(self) -> None:\n");
            foreach (Invariant inv in vo.Invariants)
            {
                WriteInvariantGuard(sb, name, inv, translator);
            }
        }

        // Computed (derived) members as read-only @property getters.
        foreach (Member m in derived)
        {
            sb.Append('\n');
            sb.Append(Indent).Append("@property\n");
            sb.Append(Indent).Append("def ").Append(PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name)))
              .Append("(self) -> ").Append(typeMapper.Map(m.Type)).Append(":\n");
            WriteDoc(sb, m.Doc, Indent + Indent);
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(translator.Translate(m.Initializer!, EnumExpected(m, emit.Index))).Append('\n');
        }

        // A quantity gets unit-checked add/sub and scalar mul/truediv dunder operators. A plain value
        // object gets a scalar `__mul__` and/or an additive `__add__` ONLY where the model actually
        // uses them (R9, demand-driven — mirrors the C#/TS emitters), so we never emit an unused (or
        // non-typechecking) operator.
        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, vo, name, ordered, emit.Index);
        }
        else
        {
            if (emit.ScalarNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? scalars)
                && ordered.Any(m => m.Type.Name is "Int" or "Decimal"))
            {
                WriteScalarOp(sb, name, ordered, scalars);
            }
            if (emit.AdditiveNeeds.Contains(vo.Name))
            {
                WriteAdditiveOp(sb, name, ordered);
            }
        }

        return new EmittedFile(
            PathFor(ns, KindFolder.ValueObjects, vo.Name),
            Assemble(emit, ns, KindFolder.ValueObjects, sb.ToString(), name));
    }

    /// <summary>Emits one invariant guard inside <c>__post_init__</c> (self.<i>field</i> reads).</summary>
    private void WriteInvariantGuard(StringBuilder sb, string typeName, Invariant inv, PythonExpressionTranslator translator)
    {
        const PythonExpressionTranslator.NameMode mode = PythonExpressionTranslator.NameMode.Property;

        // A `when`-guarded invariant (GuardExpr) only checks the body when the guard holds:
        //   if <guard> and not (<body>): raise …
        string test;
        if (inv.Condition is GuardExpr guard)
        {
            test = translator.Translate(guard.Condition, mode) + " and " + Negate(translator.Translate(guard.Body, mode));
        }
        else
        {
            test = Negate(translator.Translate(inv.Condition, mode));
        }

        sb.Append(Indent).Append(Indent).Append("if ").Append(test).Append(":\n");
        sb.Append(Indent).Append(Indent).Append(Indent)
          .Append("raise DomainInvariantViolationError(\"").Append(typeName).Append("\", ")
          .Append(RuleLiteral(inv.Message ?? "invariant failed")).Append(")\n");
    }

    /// <summary>
    /// Logically negates a translated condition for a guard test. When the condition is already a
    /// single fully-parenthesized group (the translator parenthesizes binary expressions), reuse
    /// those parens (<c>not (a &gt;= 0)</c>) instead of doubling them (<c>not ((a &gt;= 0))</c>).
    /// </summary>
    private static string Negate(string condition) =>
        IsFullyParenthesized(condition) ? "not " + condition : "not (" + condition + ")";

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
                // The opening paren is closed before the end → not a single enclosing group.
                if (depth == 0 && i != s.Length - 1)
                {
                    return false;
                }
            }
        }
        return depth == 0;
    }

    /// <summary>
    /// A quantity's unit-checked binary ops and scalar scaling. <c>__add__</c>/<c>__sub__</c> require
    /// matching units (raising a domain error otherwise); <c>__mul__</c>/<c>__truediv__</c> scale the
    /// amount by a <c>Decimal</c>/<c>int</c> scalar, carrying the unit. The amount is the (required)
    /// <c>Decimal</c> field; the unit is the other (required) field.
    /// </summary>
    private void WriteQuantityOps(StringBuilder sb, ValueObjectDecl vo, string name, IReadOnlyList<Member> fields, ModelIndex index)
    {
        Member? amount = fields.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = fields.FirstOrDefault(m => !ReferenceEquals(m, amount) && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return;
        }

        var amt = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(amount.Name));
        var u = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(unit.Name));

        // Build a constructor call placing amount/unit by their declared (field) order.
        string Construct(string amtExpr, string unitExpr) =>
            name + "(" + string.Join(", ", fields.Select(m =>
                ReferenceEquals(m, amount) ? amtExpr
                : ReferenceEquals(m, unit) ? unitExpr
                : "self." + PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name)))) + ")";

        foreach (var (dunder, verb, op) in new[] { ("__add__", "add", "+"), ("__sub__", "subtract", "-") })
        {
            sb.Append('\n');
            sb.Append(Indent).Append("def ").Append(dunder).Append("(self, other: ").Append(name).Append(") -> ").Append(name).Append(":\n");
            sb.Append(Indent).Append(Indent).Append("if self.").Append(u).Append(" != other.").Append(u).Append(":\n");
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append("raise DomainInvariantViolationError(\"").Append(name)
              .Append("\", \"cannot ").Append(verb).Append(" quantities of different units\")\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct($"self.{amt} {op} other.{amt}", $"self.{u}")).Append('\n');
        }

        foreach (var (dunder, op) in new[] { ("__mul__", "*"), ("__truediv__", "/") })
        {
            sb.Append('\n');
            sb.Append(Indent).Append("def ").Append(dunder).Append("(self, factor: Decimal | int) -> ").Append(name).Append(":\n");
            sb.Append(Indent).Append(Indent).Append("return ")
              .Append(Construct($"self.{amt} {op} factor", $"self.{u}")).Append('\n');
        }
    }

    /// <summary>
    /// A value object's scalar <c>__mul__(factor)</c> (e.g. <c>Money * quantity</c>): scales each
    /// numeric field by the factor and carries the rest unchanged. The factor type is the union of
    /// the scalar Python types the model actually multiplies this value object by (<c>int</c> and/or
    /// <c>Decimal</c>). <c>Decimal * int</c> and <c>Decimal * Decimal</c> stay <c>Decimal</c>, so the
    /// constructed value object's fields keep their declared types.
    /// </summary>
    private void WriteScalarOp(StringBuilder sb, string name, IReadOnlyList<Member> fields, IReadOnlySet<string> scalars)
    {
        var numeric = new HashSet<string>(fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name), StringComparer.Ordinal);
        var factorType = ScalarUnion(scalars);

        string Arg(Member m)
        {
            var field = "self." + PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            return numeric.Contains(m.Name) ? $"{field} * factor" : field;
        }

        sb.Append('\n');
        sb.Append(Indent).Append("def __mul__(self, factor: ").Append(factorType).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(name).Append('(')
          .Append(string.Join(", ", fields.Select(Arg))).Append(")\n");
    }

    /// <summary>
    /// A value object's additive <c>__add__(other)</c> (for <c>sum</c> folds): adds each numeric
    /// field pairwise, carrying the rest from <c>self</c>. Used where the model <c>sum</c>s the value
    /// object (e.g. <c>lines.sum(l =&gt; l.subtotal)</c> producing a <c>Money</c> total).
    /// </summary>
    private void WriteAdditiveOp(StringBuilder sb, string name, IReadOnlyList<Member> fields)
    {
        var numeric = new HashSet<string>(fields.Where(m => m.Type.Name is "Int" or "Decimal").Select(m => m.Name), StringComparer.Ordinal);

        string Arg(Member m)
        {
            var snake = PythonNaming.EscapeIdentifier(PythonNaming.ToSnakeCase(m.Name));
            return numeric.Contains(m.Name) ? $"self.{snake} + other.{snake}" : "self." + snake;
        }

        sb.Append('\n');
        sb.Append(Indent).Append("def __add__(self, other: ").Append(name).Append(") -> ").Append(name).Append(":\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(name).Append('(')
          .Append(string.Join(", ", fields.Select(Arg))).Append(")\n");
    }

    /// <summary>The Python factor-type annotation for a set of scalar needs (<c>int</c>/<c>decimal</c>).</summary>
    private static string ScalarUnion(IReadOnlySet<string> scalars)
    {
        var parts = new List<string>();
        if (scalars.Contains("int"))
        {
            parts.Add("int");
        }
        if (scalars.Contains("decimal"))
        {
            parts.Add("Decimal");
        }
        return parts.Count == 0 ? "Decimal | int" : string.Join(" | ", parts);
    }

    // ----------------------------------------------------------------------
    // Field default classification
    // ----------------------------------------------------------------------

    /// <summary>True when a stored field carries a dataclass default (a constant initializer or an optional → None).</summary>
    private static bool HasDefault(Member m) => m.Initializer is not null || m.Type.IsOptional;

    /// <summary>
    /// The dataclass default expression for a field, or <c>null</c> when the field is required. A
    /// constant-default member renders its (literal/enum) initializer; an optional field with no
    /// initializer defaults to <c>None</c>. Mutable collection defaults are never produced — Koine
    /// collection types already map to immutable <c>tuple</c>/<c>frozenset</c> values, and a constant
    /// initializer for one would be an immutable literal.
    /// </summary>
    /// <param name="index">
    /// The model index used to resolve the field's declared type so that an enum-member default is
    /// always qualified with the <em>correct</em> enum class — not the first owner found in a global
    /// scan (which is ambiguous when two contexts both declare a member with the same name).
    /// </param>
    private static string? DefaultExpr(Member m, PythonExpressionTranslator translator, ModelIndex index)
    {
        if (m.Initializer is not null)
        {
            // A constant default (not derived) — render the literal/enum-member expression directly.
            // Pass the field's own declared enum type as the hint so an ambiguous member name (one
            // that exists in multiple enums) resolves to the correct owner rather than the first
            // match the translator finds in the global enum-member → type map.
            return translator.Translate(m.Initializer, NameModeForDefault(m), EnumExpected(m, index));
        }
        if (m.Type.IsOptional)
        {
            return "None";
        }
        return null;
    }

    /// <summary>A default initializer is a constant; it never reads <c>self</c>, so it renders in Parameter mode.</summary>
    private static PythonExpressionTranslator.NameMode NameModeForDefault(Member m) =>
        PythonExpressionTranslator.NameMode.Parameter;

    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
}
