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

        var typeMapper = new JavaTypeMapper(emit.Index);
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

        sb.Append("}\n");
        return TypeFile(context, name, sb.ToString());
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
