using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The value-object slice of <see cref="JavaEmitter"/>. A Koine <c>value</c> emits as a Java
/// <c>record</c> — immutable, value-equality and <c>toString</c> for free — whose <b>compact
/// constructor</b> runs the invariants before the (implicit) field assignments, throwing
/// <c>koine.runtime.DomainException</c> when one is violated (the record analogue of the Rust smart
/// constructor's <c>Result::Err</c> and the C# guarded constructor). Stored members become record
/// components; a derived (computed) member becomes a get-only accessor method. Optional components are
/// normalized to <c>Optional.empty()</c> and collection components to an unmodifiable copy, so a record
/// never holds a null <c>Optional</c> or an externally-mutable list.
/// <para>
/// Because a record's components are bare parameter names inside the compact constructor, invariant
/// expressions translate in <see cref="JavaExpressionTranslator.NameMode.Parameter"/> (bare
/// <c>camelCase</c>); a derived accessor body translates in
/// <see cref="JavaExpressionTranslator.NameMode.Property"/> (<c>this.x()</c>, since components are read
/// through their accessors). The translator emits fully-qualified stdlib types, so no imports are owed.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>Emits one value object as a validating <c>record</c> file (one public type per file).</summary>
    private EmittedFile EmitValueObject(JavaEmitContext emit, string context, ValueObjectDecl vo)
    {
        var name = JavaNaming.Type(vo.Name);
        var memberNames = new HashSet<string>(vo.Members.Select(m => m.Name), StringComparer.Ordinal);
        var stored = vo.Members.Where(m => !MemberAnalysis.IsDerived(m, memberNames)).ToList();
        var derived = vo.Members.Where(m => MemberAnalysis.IsDerived(m, memberNames)).ToList();

        var typeMapper = new JavaTypeMapper(emit.Index, context, PackageFor);
        // membersAsAccessors: a record's components are private, so a member read in an instance body
        // (a derived accessor) goes through `this.x()`. Parameter-mode reads (the invariants) are bare
        // component names regardless, so the same translator serves both.
        var translator = new JavaExpressionTranslator(
            emit.Index, vo.Members, typeMapper, context: context,
            memberReceiver: "this", membersAsAccessors: true);

        var sb = new StringBuilder();
        WriteJavadoc(sb, vo.Doc, string.Empty);

        var components = string.Join(
            ", ",
            stored.Select(m => typeMapper.Map(m.Type) + " " + JavaNaming.Member(m.Name)));
        sb.Append("public record ").Append(name).Append('(').Append(components).Append(") {\n");

        WriteCompactConstructor(sb, name, vo, stored, translator);

        foreach (Member m in derived)
        {
            sb.Append('\n');
            WriteDerivedAccessor(sb, m, typeMapper, translator);
        }

        // Demand-driven arithmetic methods — Java reference types carry no operators, so a value object
        // combined/scaled by the model gets `plus`/`minus`/`times`/`dividedBy` the translator lowers to.
        WriteValueObjectOperators(sb, emit, name, vo, stored);

        sb.Append("}\n");
        return TypeFile(context, name, sb.ToString());
    }

    private static readonly IReadOnlySet<BinaryOp> EmptyBinaryOps = new HashSet<BinaryOp>();

    /// <summary>
    /// Emits the demand-driven arithmetic methods a value object's uses require (R9), the Java analogue of
    /// the Rust backend's <c>impl Add/Mul/Div</c>: <c>plus</c>/<c>minus</c> for additive combination (a
    /// <c>sum</c> fold or a plain binary <c>+</c>/<c>-</c>), and <c>times</c>/<c>dividedBy</c> overloads for
    /// scalar scaling by a <c>long</c> (Koine <c>Int</c>) and/or a <c>java.math.BigDecimal</c> (Koine
    /// <c>Decimal</c>). Only the operators the model actually uses are emitted (via
    /// <see cref="OperatorNeedsAnalyzer"/>), so a value object never carries a method no one invokes.
    /// </summary>
    private static void WriteValueObjectOperators(
        StringBuilder sb, JavaEmitContext emit, string name, ValueObjectDecl vo, IReadOnlyList<Member> stored)
    {
        IReadOnlySet<BinaryOp> binaryOps =
            emit.BinaryNeeds.TryGetValue(vo.Name, out IReadOnlySet<BinaryOp>? ops) ? ops : EmptyBinaryOps;
        var hasNumeric = stored.Any(m => m.Type.Name is "Int" or "Decimal");

        // `plus`: a `sum` fold over this value object, or a plain binary `+`.
        if (emit.AdditiveNeeds.Contains(vo.Name) || binaryOps.Contains(BinaryOp.Add))
        {
            WriteAdditiveMethod(sb, name, stored, "plus", "+");
        }

        // `minus`: a plain binary `-`.
        if (binaryOps.Contains(BinaryOp.Sub))
        {
            WriteAdditiveMethod(sb, name, stored, "minus", "-");
        }

        // `times`/`dividedBy`: scalar scaling — one overload per scalar type the model uses.
        if (hasNumeric && emit.ScalarNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? mulScalars))
        {
            WriteScalarMethods(sb, name, stored, mulScalars, "times", "*");
        }

        if (hasNumeric && emit.ScalarDivNeeds.TryGetValue(vo.Name, out IReadOnlySet<string>? divScalars))
        {
            WriteScalarMethods(sb, name, stored, divScalars, "dividedBy", "/");
        }
    }

    /// <summary>
    /// Writes an additive method (<c>plus</c>/<c>minus</c>): a new value object whose numeric components are
    /// combined pairwise (<c>BigDecimal.add</c>/<c>subtract</c> for a <c>Decimal</c>, <c>+</c>/<c>-</c> for a
    /// <c>long</c>) and whose non-numeric components are carried from <c>this</c>.
    /// </summary>
    private static void WriteAdditiveMethod(
        StringBuilder sb, string name, IReadOnlyList<Member> stored, string method, string op)
    {
        sb.Append('\n');
        WriteJavadoc(sb, "Combines this " + name + " with another, component-wise.", Indent);
        sb.Append(Indent).Append("public ").Append(name).Append(' ').Append(method)
          .Append('(').Append(name).Append(" other) {\n");
        sb.Append(Indent).Append(Indent).Append("return new ").Append(name).Append('(')
          .Append(string.Join(", ", stored.Select(m => AdditiveComponent(m, op)))).Append(");\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>The component expression for an additive method: a pairwise numeric combine, or a carried non-numeric component.</summary>
    private static string AdditiveComponent(Member m, string op)
    {
        var field = JavaNaming.Member(m.Name);
        var self = "this." + field + "()";
        var other = "other." + field + "()";
        if (m.Type.Name is not ("Int" or "Decimal"))
        {
            return self; // carry a non-numeric component (e.g. a currency enum) from `this`.
        }

        if (m.Type.Name == "Decimal")
        {
            var dm = op == "+" ? "add" : "subtract";
            return m.Type.IsOptional
                ? self + ".flatMap(a -> " + other + ".map(a::" + dm + "))"
                : self + "." + dm + "(" + other + ")";
        }

        // Int -> long.
        return m.Type.IsOptional
            ? self + ".flatMap(a -> " + other + ".map(b -> a " + op + " b))"
            : self + " " + op + " " + other;
    }

    /// <summary>Writes the <c>times</c>/<c>dividedBy</c> overloads for the scalar types (<c>int</c>/<c>decimal</c>) the model scales this value object by.</summary>
    private static void WriteScalarMethods(
        StringBuilder sb, string name, IReadOnlyList<Member> stored, IReadOnlySet<string> scalars, string method, string op)
    {
        // "int" -> a `long` overload; "decimal" -> a `java.math.BigDecimal` overload. Defaulting to the
        // long overload when the analyzer recorded neither keeps the method callable (never reached today).
        if (scalars.Contains("int") || (!scalars.Contains("int") && !scalars.Contains("decimal")))
        {
            WriteScalarMethod(sb, name, stored, method, op, "long", factorIsDecimal: false);
        }

        if (scalars.Contains("decimal"))
        {
            WriteScalarMethod(sb, name, stored, method, op, "java.math.BigDecimal", factorIsDecimal: true);
        }
    }

    /// <summary>Writes one scalar-scaling overload (<c>times</c>/<c>dividedBy</c>) taking a <paramref name="javaType"/> factor.</summary>
    private static void WriteScalarMethod(
        StringBuilder sb, string name, IReadOnlyList<Member> stored, string method, string op, string javaType, bool factorIsDecimal)
    {
        var param = method == "times" ? "factor" : "divisor";
        sb.Append('\n');
        WriteJavadoc(sb, "Scales this " + name + " by a " + param + ".", Indent);
        sb.Append(Indent).Append("public ").Append(name).Append(' ').Append(method)
          .Append('(').Append(javaType).Append(' ').Append(param).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append("return new ").Append(name).Append('(')
          .Append(string.Join(", ", stored.Select(m => ScaleComponent(m, op, param, factorIsDecimal)))).Append(");\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>The component expression for a scalar-scaling method: the numeric component scaled by the operand, or a carried non-numeric component.</summary>
    private static string ScaleComponent(Member m, string op, string param, bool factorIsDecimal)
    {
        var field = "this." + JavaNaming.Member(m.Name) + "()";
        if (m.Type.Name is not ("Int" or "Decimal"))
        {
            return field; // carry a non-numeric component (e.g. a currency enum) unchanged.
        }

        var lhs = m.Type.IsOptional ? "v" : field;
        var coercion = ScaleExpr(m.Type.Name, lhs, op, param, factorIsDecimal);
        return m.Type.IsOptional ? field + ".map(v -> " + coercion + ")" : coercion;
    }

    /// <summary>
    /// Scales one numeric operand (<paramref name="lhs"/>) by <paramref name="param"/> under <paramref name="op"/>
    /// (<c>*</c>/<c>/</c>), crossing through <c>BigDecimal</c> and narrowing back to <c>long</c> as needed. A
    /// <c>Decimal</c> divide uses <c>MathContext.DECIMAL128</c> so a non-terminating quotient never throws.
    /// </summary>
    private static string ScaleExpr(string typeName, string lhs, string op, string param, bool factorIsDecimal)
    {
        if (typeName == "Decimal")
        {
            var operand = factorIsDecimal ? param : "java.math.BigDecimal.valueOf(" + param + ")";
            return op == "*"
                ? lhs + ".multiply(" + operand + ")"
                : lhs + ".divide(" + operand + ", java.math.MathContext.DECIMAL128)";
        }

        // Int -> long. A decimal factor crosses into BigDecimal then narrows back (truncating toward zero,
        // like a Java `(long)` cast); a long factor scales directly.
        if (factorIsDecimal)
        {
            var crossed = "java.math.BigDecimal.valueOf(" + lhs + ")"
                + (op == "*"
                    ? ".multiply(" + param + ")"
                    : ".divide(" + param + ", java.math.MathContext.DECIMAL128)");
            return crossed + ".longValue()";
        }

        return lhs + " " + op + " " + param;
    }

    /// <summary>
    /// Writes the record's compact constructor when there is anything to enforce: component
    /// normalizations (optional → <c>Optional.empty()</c>, collection → unmodifiable copy) followed by one
    /// guard per invariant. Emits nothing when the value object has neither, so a plain data record stays
    /// free of an empty constructor.
    /// </summary>
    private static void WriteCompactConstructor(
        StringBuilder sb, string name, ValueObjectDecl vo, IReadOnlyList<Member> stored,
        JavaExpressionTranslator translator)
    {
        var normalizable = stored.Where(NeedsNormalization).ToList();
        if (normalizable.Count == 0 && vo.Invariants.Count == 0)
        {
            return;
        }

        sb.Append(Indent).Append("public ").Append(name).Append(" {\n");

        foreach (Member m in normalizable)
        {
            WriteNormalization(sb, m, Indent + Indent);
        }

        foreach (Invariant inv in vo.Invariants)
        {
            WriteInvariantGuard(sb, inv, translator, Indent + Indent);
        }

        sb.Append(Indent).Append("}\n");
    }

    /// <summary>True when a component must be normalized in the compact constructor: a nullable (<c>Optional</c>) or a collection component.</summary>
    private static bool NeedsNormalization(Member m) => m.Type.IsOptional || JavaTypeMapper.IsCollection(m.Type);

    /// <summary>
    /// Reassigns one component to its normalized value inside the compact constructor: a nullable becomes a
    /// never-null <c>Optional</c>, and a <c>List</c>/<c>Set</c>/<c>Map</c> becomes an unmodifiable defensive
    /// copy — so the constructed record can never observe a null <c>Optional</c> or an aliased mutable
    /// collection. Optionality wins over the collection case (an optional list normalizes to <c>Optional</c>).
    /// </summary>
    private static void WriteNormalization(StringBuilder sb, Member m, string indent)
    {
        var field = JavaNaming.Member(m.Name);
        if (m.Type.IsOptional)
        {
            sb.Append(indent).Append(field).Append(" = ").Append(field)
              .Append(" == null ? java.util.Optional.empty() : ").Append(field).Append(";\n");
        }
        else if (JavaTypeMapper.IsMap(m.Type))
        {
            sb.Append(indent).Append(field).Append(" = java.util.Map.copyOf(").Append(field).Append(");\n");
        }
        else
        {
            var copy = JavaTypeMapper.IsSet(m.Type) ? "java.util.Set.copyOf" : "java.util.List.copyOf";
            sb.Append(indent).Append(field).Append(" = ").Append(copy).Append('(').Append(field).Append(");\n");
        }
    }

    /// <summary>
    /// Emits one invariant as a fail-fast guard: <c>if (&lt;failure&gt;) { throw new DomainException(msg); }</c>.
    /// A plain invariant fails when its condition does not hold (<c>!(cond)</c>); a <c>body when cond</c>
    /// guard fails only when the guard fires and the body does not (<c>(cond) &amp;&amp; !(body)</c>). The
    /// declared message is used verbatim, falling back to a generic default.
    /// </summary>
    private static void WriteInvariantGuard(
        StringBuilder sb, Invariant inv, JavaExpressionTranslator translator, string indent)
    {
        string failure;
        if (inv.Condition is GuardExpr guard)
        {
            var cond = translator.Translate(guard.Condition, JavaExpressionTranslator.NameMode.Parameter);
            var body = translator.Translate(guard.Body, JavaExpressionTranslator.NameMode.Parameter);
            failure = "(" + cond + ") && !(" + body + ")";
        }
        else
        {
            failure = "!(" + translator.Translate(inv.Condition, JavaExpressionTranslator.NameMode.Parameter) + ")";
        }

        sb.Append(indent).Append("if (").Append(failure).Append(") {\n");
        sb.Append(indent).Append(Indent).Append("throw new koine.runtime.DomainException(")
          .Append(JavaStringLiteral(inv.Message ?? "invariant violated")).Append(");\n");
        sb.Append(indent).Append("}\n");
    }

    /// <summary>Emits a derived (computed) member as a get-only accessor method reading through the record's components.</summary>
    private static void WriteDerivedAccessor(
        StringBuilder sb, Member m, JavaTypeMapper typeMapper, JavaExpressionTranslator translator)
    {
        WriteJavadoc(sb, m.Doc, Indent);
        var body = translator.Translate(m.Initializer!, JavaExpressionTranslator.NameMode.Property);
        sb.Append(Indent).Append("public ").Append(typeMapper.Map(m.Type)).Append(' ')
          .Append(JavaNaming.Member(m.Name)).Append("() {\n");
        sb.Append(Indent).Append(Indent).Append("return ").Append(body).Append(";\n");
        sb.Append(Indent).Append("}\n");
    }
}
