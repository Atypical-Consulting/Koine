using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The value-object (and generated-identity) slice of <see cref="KotlinEmitter"/>. A Koine <c>value</c>
/// emits as a Kotlin <c>data class</c> — immutable, structural equality, <c>copy</c>/<c>toString</c> for
/// free — whose <c>init { }</c> block runs the invariants before the object escapes, throwing
/// <c>koine.runtime.DomainException</c> when one is violated (the data-class analogue of the Rust smart
/// constructor's <c>Result::Err</c> and the C# guarded constructor). Stored members become constructor
/// <c>val</c>s; a derived (computed) member becomes a get-only <c>val … get()</c> property, which — being a
/// body property, not a constructor component — is correctly excluded from equality. Demand-driven
/// arithmetic (scalar <c>times</c>/<c>div</c>, additive <c>plus</c>/<c>minus</c>) is emitted as
/// <c>operator fun</c>s only where the model uses them; a <c>quantity</c> gets unit-checked
/// <c>plus</c>/<c>minus</c> and a scalar <c>scale</c>.
/// <para>
/// A generated identity emits as an <c>@JvmInline value class</c> wrapping a <c>java.util.UUID</c> (the
/// default Guid strategy, with a <c>generate()</c> minter), a <c>Long</c> (a sequence or natural <c>Int</c>
/// key), or a <c>String</c> (a natural <c>String</c> key, validated non-blank in its <c>init</c>).
/// </para>
/// </summary>
public sealed partial class KotlinEmitter
{
    /// <summary>Emits one value object as a validating <c>data class</c> file (one top-level type per file).</summary>
    private EmittedFile EmitValueObject(KotlinEmitContext emit, string context, ValueObjectDecl vo)
    {
        var name = KotlinNaming.ToTypeName(vo.Name);
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        var stored = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var typeMapper = new KotlinTypeMapper(emit.Index, context, PackageFor);
        var translator = new KotlinExpressionTranslator(
            emit.Index, vo.Members, typeMapper, context, memberReceiver: "this", emit.EnumMemberToType);

        var sb = new StringBuilder();
        WriteKdoc(sb, vo.Doc, string.Empty);
        sb.Append("data class ").Append(name).Append("(\n");
        foreach (Member m in stored)
        {
            WriteKdoc(sb, m.Doc, Indent);
            sb.Append(Indent).Append("val ").Append(KotlinNaming.ToMemberName(m.Name)).Append(": ").Append(typeMapper.Map(m.Type));
            if (m.Initializer is not null)
            {
                sb.Append(" = ").Append(translator.Translate(
                    m.Initializer, KotlinExpressionTranslator.NameMode.Parameter, EnumExpected(m, emit.Index)));
            }

            sb.Append(",\n");
        }

        var hasBody = vo.Invariants.Count > 0 || derived.Count > 0 || VoHasOperators(emit, vo, stored);
        sb.Append(')');
        if (!hasBody)
        {
            sb.Append('\n');
            return TypeFile(context, name, sb.ToString());
        }

        sb.Append(" {\n");

        // Body sections are separated by a single blank line, but the first section hangs directly off the
        // opening brace (no leading blank) — so the shape stays consistent whether or not there are invariants.
        var wroteBody = false;

        // Invariants: an `init { }` guard block over the constructor-bound properties (Parameter mode: bare
        // property names, which resolve to the primary-constructor `val`s).
        if (vo.Invariants.Count > 0)
        {
            sb.Append(Indent).Append("init {\n");
            foreach (Invariant inv in vo.Invariants)
            {
                WriteInvariantGuard(sb, inv, translator, Indent + Indent, KotlinExpressionTranslator.NameMode.Parameter);
            }

            sb.Append(Indent).Append("}\n");
            wroteBody = true;
        }

        // Derived (computed) members: get-only properties over the stored properties.
        foreach (Member m in derived)
        {
            if (wroteBody)
            {
                sb.Append('\n');
            }

            WriteDerivedProperty(sb, emit, m, typeMapper, translator);
            wroteBody = true;
        }

        // Demand-driven / quantity operators.
        WriteValueObjectOperators(sb, emit, name, vo, stored, wroteBody);

        sb.Append("}\n");
        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>Emits a derived (computed) member as a get-only property reading through the stored properties.</summary>
    private static void WriteDerivedProperty(
        StringBuilder sb, KotlinEmitContext emit, Member m, KotlinTypeMapper typeMapper, KotlinExpressionTranslator translator)
    {
        WriteKdoc(sb, m.Doc, Indent);
        var body = translator.Translate(m.Initializer!, KotlinExpressionTranslator.NameMode.Property, EnumExpected(m, emit.Index));
        sb.Append(Indent).Append("val ").Append(KotlinNaming.ToMemberName(m.Name)).Append(": ")
          .Append(typeMapper.Map(m.Type)).Append(" get() = ").Append(body).Append('\n');
    }

    /// <summary>
    /// Emits one invariant as a fail-fast guard: <c>if (&lt;failure&gt;) throw DomainException(msg)</c>. A plain
    /// invariant fails when its condition does not hold (<c>!(cond)</c>); a <c>body when cond</c> guard fails
    /// only when the guard fires and the body does not (<c>(cond) &amp;&amp; !(body)</c>).
    /// </summary>
    internal static void WriteInvariantGuard(
        StringBuilder sb, Invariant inv, KotlinExpressionTranslator translator, string indent,
        KotlinExpressionTranslator.NameMode mode)
    {
        string failure;
        if (inv.Condition is GuardExpr guard)
        {
            var cond = translator.Translate(guard.Condition, mode);
            var body = translator.Translate(guard.Body, mode);
            failure = "(" + cond + ") && !(" + body + ")";
        }
        else
        {
            failure = "!(" + translator.Translate(inv.Condition, mode) + ")";
        }

        sb.Append(indent).Append("if (").Append(failure).Append(") throw koine.runtime.DomainException(")
          .Append(KotlinStringLiteral(inv.Message ?? "invariant violated")).Append(")\n");
    }

    // ----------------------------------------------------------------------
    // Demand-driven & quantity operators
    // ----------------------------------------------------------------------

    /// <summary>True when the value object emits at least one arithmetic operator (so it needs a class body).</summary>
    private static bool VoHasOperators(KotlinEmitContext emit, ValueObjectDecl vo, IReadOnlyList<Member> stored)
    {
        if (vo.IsQuantity)
        {
            return true;
        }

        var hasNumeric = stored.Any(m => m.Type.Name is "Int" or "Decimal");
        var binaryOps = emit.BinaryNeeds.TryGetValue(vo.Name, out var ops) ? ops : EmptyBinaryOps;
        return (hasNumeric && (emit.ScalarNeeds.ContainsKey(vo.Name) || emit.ScalarDivNeeds.ContainsKey(vo.Name)))
            || emit.AdditiveNeeds.Contains(vo.Name)
            || binaryOps.Count > 0;
    }

    private static readonly IReadOnlySet<BinaryOp> EmptyBinaryOps = new HashSet<BinaryOp>();

    /// <summary>Appends a single blank-line separator before a body section, unless it is the first thing in the class body.</summary>
    private static void Separate(StringBuilder sb, ref bool wroteBody)
    {
        if (wroteBody)
        {
            sb.Append('\n');
        }

        wroteBody = true;
    }

    /// <summary>
    /// Emits the demand-driven arithmetic operators a value object's uses require (R9): a <c>quantity</c> gets
    /// unit-checked <c>plus</c>/<c>minus</c> and a scalar <c>scale</c>; a plain value object gets
    /// <c>times</c>/<c>div</c> overloads where scaled, and <c>plus</c>/<c>minus</c> where summed or added.
    /// </summary>
    private static void WriteValueObjectOperators(
        StringBuilder sb, KotlinEmitContext emit, string name, ValueObjectDecl vo, IReadOnlyList<Member> stored, bool wroteBody)
    {
        if (vo.IsQuantity)
        {
            WriteQuantityOps(sb, name, stored, ref wroteBody);
            return;
        }

        var hasNumeric = stored.Any(m => m.Type.Name is "Int" or "Decimal");
        IReadOnlySet<BinaryOp> binaryOps =
            emit.BinaryNeeds.TryGetValue(vo.Name, out IReadOnlySet<BinaryOp>? ops) ? ops : EmptyBinaryOps;

        // `plus`: a `sum` fold over this value object, or a plain binary `+`. `minus`: a plain binary `-`.
        if (emit.AdditiveNeeds.Contains(vo.Name) || binaryOps.Contains(BinaryOp.Add))
        {
            WriteAdditiveOp(sb, name, stored, "plus", "+", ref wroteBody);
        }

        if (binaryOps.Contains(BinaryOp.Sub))
        {
            WriteAdditiveOp(sb, name, stored, "minus", "-", ref wroteBody);
        }

        // `times`/`div`: scalar scaling — one overload per scalar type the model uses.
        if (hasNumeric && emit.ScalarNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? mulScalars))
        {
            WriteScalarOps(sb, name, stored, mulScalars, "times", "*", ref wroteBody);
        }

        if (hasNumeric && emit.ScalarDivNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? divScalars))
        {
            WriteScalarOps(sb, name, stored, divScalars, "div", "/", ref wroteBody);
        }
    }

    /// <summary>Writes an additive operator (<c>plus</c>/<c>minus</c>): numeric components combined pairwise, non-numeric carried from <c>this</c>.</summary>
    private static void WriteAdditiveOp(
        StringBuilder sb, string name, IReadOnlyList<Member> stored, string method, string op, ref bool wroteBody)
    {
        Separate(sb, ref wroteBody);
        WriteKdoc(sb, "Combines this " + name + " with another, component-wise.", Indent);
        sb.Append(Indent).Append("operator fun ").Append(method).Append("(other: ").Append(name).Append("): ").Append(name)
          .Append(" = ").Append(name).Append('(')
          .Append(string.Join(", ", stored.Select(m => AdditiveComponent(m, op)))).Append(")\n");
    }

    /// <summary>The component expression for an additive operator: a pairwise numeric combine, or a carried non-numeric component.</summary>
    private static string AdditiveComponent(Member m, string op)
    {
        var field = "this." + KotlinNaming.ToMemberName(m.Name);
        var other = "other." + KotlinNaming.ToMemberName(m.Name);
        if (m.Type.Name is not ("Int" or "Decimal"))
        {
            return field; // carry a non-numeric component (e.g. a currency enum) from `this`.
        }

        if (m.Type.Name == "Decimal")
        {
            var dm = op == "+" ? "add" : "subtract";
            return m.Type.IsOptional
                ? field + "?.let { a -> " + other + "?.let { b -> a." + dm + "(b) } }"
                : field + "." + dm + "(" + other + ")";
        }

        // Int -> Long.
        return m.Type.IsOptional
            ? field + "?.let { a -> " + other + "?.let { b -> a " + op + " b } }"
            : field + " " + op + " " + other;
    }

    /// <summary>Writes the <c>times</c>/<c>div</c> overloads for the scalar types (<c>Long</c>/<c>BigDecimal</c>) the model scales this value object by.</summary>
    private static void WriteScalarOps(
        StringBuilder sb, string name, IReadOnlyList<Member> stored, IReadOnlySet<string> scalars, string method, string op, ref bool wroteBody)
    {
        // "int" -> a Long overload; "decimal" -> a java.math.BigDecimal overload. Defaulting to the Long
        // overload when the analyzer recorded neither keeps the operator callable (never reached today).
        if (scalars.Contains("int") || (!scalars.Contains("int") && !scalars.Contains("decimal")))
        {
            WriteScalarOp(sb, name, stored, method, op, "Long", operandIsDecimal: false, ref wroteBody);
        }

        if (scalars.Contains("decimal"))
        {
            WriteScalarOp(sb, name, stored, method, op, "java.math.BigDecimal", operandIsDecimal: true, ref wroteBody);
        }
    }

    /// <summary>Writes one scalar-scaling overload (<c>times</c>/<c>div</c>) taking a <paramref name="kotlinType"/> factor.</summary>
    private static void WriteScalarOp(
        StringBuilder sb, string name, IReadOnlyList<Member> stored, string method, string op, string kotlinType, bool operandIsDecimal, ref bool wroteBody)
    {
        var param = method == "times" ? "factor" : "divisor";
        Separate(sb, ref wroteBody);
        WriteKdoc(sb, "Scales this " + name + " by a " + param + ".", Indent);
        sb.Append(Indent).Append("operator fun ").Append(method).Append('(').Append(param).Append(": ").Append(kotlinType)
          .Append("): ").Append(name).Append(" = ").Append(name).Append('(')
          .Append(string.Join(", ", stored.Select(m => ScaleComponent(m, op, param, operandIsDecimal)))).Append(")\n");
    }

    /// <summary>The component expression for a scalar-scaling operator: the numeric component scaled by the operand, or a carried non-numeric component.</summary>
    private static string ScaleComponent(Member m, string op, string param, bool operandIsDecimal)
    {
        var field = "this." + KotlinNaming.ToMemberName(m.Name);
        if (m.Type.Name is not ("Int" or "Decimal"))
        {
            return field; // carry a non-numeric component (e.g. a currency enum) unchanged.
        }

        if (m.Type.IsOptional)
        {
            return field + "?.let { v -> " + ScaleExpr(m.Type.Name, "v", op, param, operandIsDecimal) + " }";
        }

        return ScaleExpr(m.Type.Name, field, op, param, operandIsDecimal);
    }

    /// <summary>
    /// Scales one numeric operand (<paramref name="lhs"/>) by <paramref name="param"/> under <paramref name="op"/>
    /// (<c>*</c>/<c>/</c>), crossing through <c>BigDecimal</c> and narrowing back to <c>Long</c> as needed. A
    /// <c>Decimal</c> divide uses <c>MathContext.DECIMAL128</c> so a non-terminating quotient never throws.
    /// </summary>
    private static string ScaleExpr(string typeName, string lhs, string op, string param, bool operandIsDecimal)
    {
        if (typeName == "Decimal")
        {
            var operand = operandIsDecimal ? param : "java.math.BigDecimal.valueOf(" + param + ")";
            return op == "*"
                ? lhs + ".multiply(" + operand + ")"
                : lhs + ".divide(" + operand + ", java.math.MathContext.DECIMAL128)";
        }

        // Int -> Long. A decimal factor crosses into BigDecimal then narrows back (truncating toward zero,
        // like a Kotlin `.toLong()`); a long factor scales directly.
        if (operandIsDecimal)
        {
            var crossed = "java.math.BigDecimal.valueOf(" + lhs + ")"
                + (op == "*"
                    ? ".multiply(" + param + ")"
                    : ".divide(" + param + ", java.math.MathContext.DECIMAL128)");
            return crossed + ".toLong()";
        }

        return lhs + " " + op + " " + param;
    }

    /// <summary>A quantity's unit-checked <c>plus</c>/<c>minus</c> (throwing on a unit mismatch) and a scalar <c>scale</c>.</summary>
    private static void WriteQuantityOps(StringBuilder sb, string name, IReadOnlyList<Member> stored, ref bool wroteBody)
    {
        Member? amount = stored.FirstOrDefault(m => m.Type.Name == "Decimal" && !m.Type.IsOptional);
        Member? unit = stored.FirstOrDefault(m => !ReferenceEquals(m, amount) && !m.Type.IsOptional);
        if (amount is null || unit is null)
        {
            return;
        }

        var amt = KotlinNaming.ToMemberName(amount.Name);
        var u = KotlinNaming.ToMemberName(unit.Name);

        string Construct(string amtExpr) => name + "(" + string.Join(", ", stored.Select(m =>
            ReferenceEquals(m, amount) ? amtExpr : "this." + KotlinNaming.ToMemberName(m.Name))) + ")";

        foreach (var (method, dm) in new[] { ("plus", "add"), ("minus", "subtract") })
        {
            Separate(sb, ref wroteBody);
            WriteKdoc(sb, "Combines two quantities, requiring matching units.", Indent);
            sb.Append(Indent).Append("operator fun ").Append(method).Append("(other: ").Append(name).Append("): ").Append(name).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append("if (this.").Append(u).Append(" != other.").Append(u).Append(") throw koine.runtime.DomainException(")
              .Append(KotlinStringLiteral("cannot combine " + name + " values with different units")).Append(")\n");
            sb.Append(Indent).Append(Indent).Append("return ").Append(Construct("this." + amt + "." + dm + "(other." + amt + ")")).Append('\n');
            sb.Append(Indent).Append("}\n");
        }

        Separate(sb, ref wroteBody);
        WriteKdoc(sb, "Scales the amount by a factor, carrying the unit.", Indent);
        sb.Append(Indent).Append("fun scale(factor: java.math.BigDecimal): ").Append(name).Append(" = ")
          .Append(Construct("this." + amt + ".multiply(factor)")).Append('\n');
    }

    // ----------------------------------------------------------------------
    // Generated identity value class
    // ----------------------------------------------------------------------

    /// <summary>How an entity's generated identity type is backed in Kotlin.</summary>
    private enum KotlinIdKind
    {
        /// <summary>A <c>java.util.UUID</c>-backed identity (the default Guid strategy) with a <c>generate()</c> minter.</summary>
        Uuid,

        /// <summary>A <c>Long</c>-backed identity (a store-assigned sequence, or a natural <c>Int</c> key).</summary>
        LongId,

        /// <summary>A <c>String</c>-backed identity (a natural <c>String</c> key), validated non-blank at construction.</summary>
        StringId,
    }

    /// <summary>
    /// Emits an entity's generated identity type as a branded <c>@JvmInline value class</c> wrapping a
    /// <c>java.util.UUID</c> (the default Guid strategy), a <c>Long</c> (a sequence or natural <c>Int</c> key),
    /// or a <c>String</c> (a natural <c>String</c> key). A String-backed id validates non-blank in its
    /// <c>init</c>; a UUID-backed id gains a companion <c>generate()</c> minter that mints a fresh v4 UUID.
    /// </summary>
    private EmittedFile EmitId(KotlinEmitContext emit, string context, EntityDecl entity)
    {
        var idName = KotlinNaming.ToTypeName(entity.IdentityName);
        (string kotlinType, KotlinIdKind kind) = KotlinIdBacking(entity);

        var sb = new StringBuilder();
        WriteKdoc(sb, "A strongly-typed identity value for " + KotlinNaming.ToTypeName(entity.Name) + ".", string.Empty);
        sb.Append("@JvmInline\n");
        sb.Append("value class ").Append(idName).Append("(val value: ").Append(kotlinType).Append(')');

        if (kind == KotlinIdKind.StringId)
        {
            // A natural string key cannot be blank — it is the entity's real-world identity.
            sb.Append(" {\n");
            sb.Append(Indent).Append("init {\n");
            sb.Append(Indent).Append(Indent).Append("if (value.isBlank()) throw koine.runtime.DomainException(")
              .Append(KotlinStringLiteral("identity value cannot be blank")).Append(")\n");
            sb.Append(Indent).Append("}\n");
            sb.Append("}\n");
        }
        else if (kind == KotlinIdKind.Uuid)
        {
            sb.Append(" {\n");
            sb.Append(Indent).Append("companion object {\n");
            WriteKdoc(sb, "Mints a fresh, random identity (a v4 UUID).", Indent + Indent);
            sb.Append(Indent).Append(Indent).Append("fun generate(): ").Append(idName)
              .Append(" = ").Append(idName).Append("(java.util.UUID.randomUUID())\n");
            sb.Append(Indent).Append("}\n");
            sb.Append("}\n");
        }
        else
        {
            sb.Append('\n');
        }

        return TypeFile(context, idName, sb.ToString());
    }

    /// <summary>The Kotlin backing type and kind of an entity's generated identity (per its <see cref="IdentityStrategy"/>).</summary>
    private static (string KotlinType, KotlinIdKind Kind) KotlinIdBacking(EntityDecl entity) => entity.IdStrategy switch
    {
        IdentityStrategy.Sequence => ("Long", KotlinIdKind.LongId),
        IdentityStrategy.Natural => entity.IdBackingType == "Int" ? ("Long", KotlinIdKind.LongId) : ("String", KotlinIdKind.StringId),
        _ => ("java.util.UUID", KotlinIdKind.Uuid), // Guid (default): a UUID-backed brand with a client-side generator.
    };

    /// <summary>The enum type expected for a member's value (so a bare enum member reference qualifies), or null.</summary>
    private static string? EnumExpected(Member m, ModelIndex index) =>
        index.Classify(m.Type.Name) == TypeKind.Enum ? m.Type.Name : null;
}
