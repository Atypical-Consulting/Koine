using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The smart-enum slice of <see cref="JavaEmitter"/>. A Koine <c>enum</c> maps onto a Java
/// <c>enum</c> — the closest thing to Koine's closed, exhaustively-matchable set of named members.
/// A bare-name enum is just its constant list (<c>public enum Colour { RED, GREEN, BLUE }</c>); a
/// smart enum carrying associated constant data (e.g. <c>EUR("€", 2)</c>) becomes a Java enum with one
/// <c>private final</c> field per signature entry, each constant invoking the (private) canonical
/// constructor with its literal values, and one public accessor method per field. That is the Java
/// idiom for an enum-with-data, and it mirrors the Rust/C# smart-enum emission one field at a time.
/// <para>
/// The constant identifiers are spelled <see cref="JavaNaming.EscapeIdentifier"/> of the raw member
/// name — byte-for-byte what <see cref="JavaExpressionTranslator"/> renders for an enum-constant
/// reference (<c>&lt;EnumType&gt;.&lt;member&gt;</c>), so a <c>when</c>-guard or derived field that
/// compares against a constant keeps compiling. A member named after a Java reserved word (e.g.
/// <c>default</c>) is renamed with a trailing underscore (<c>default_</c>) by the same helper.
/// </para>
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>Emits one smart enum as a Java <c>enum</c> file (one public type per file).</summary>
    private EmittedFile EmitEnum(JavaEmitContext emit, string context, EnumDecl @enum)
    {
        var name = JavaNaming.Type(@enum.Name);

        var sb = new StringBuilder();
        WriteJavadoc(sb, @enum.Doc, string.Empty);
        sb.Append("public enum ").Append(name).Append(" {\n");

        if (@enum.HasAssociatedData)
        {
            var typeMapper = new JavaTypeMapper(emit.Index);
            // Enum constant args are literal expressions; the shared translator renders them exactly like
            // any other literal (Int -> `2L`, String -> escaped quotes, Decimal -> `new BigDecimal("…")`),
            // so the constant invocations stay consistent with the rest of the backend. There is no member
            // scope for a bare literal, so an empty member list suffices.
            var translator = new JavaExpressionTranslator(
                emit.Index, Array.Empty<Member>(), typeMapper, context: context);

            WriteDataConstants(sb, @enum, translator);
            WriteEnumFieldsAndAccessors(sb, name, @enum, typeMapper);
        }
        else
        {
            WritePlainConstants(sb, @enum);
        }

        sb.Append("}\n");
        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>
    /// Writes the constant list for a bare-name enum: one <see cref="JavaNaming.EscapeIdentifier"/>-spelled
    /// constant per member (comma-separated, no trailing <c>;</c> since the enum body carries nothing else).
    /// </summary>
    private static void WritePlainConstants(StringBuilder sb, EnumDecl @enum)
    {
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            EnumMember member = @enum.Members[i];
            WriteJavadoc(sb, member.Doc, Indent);
            sb.Append(Indent).Append(JavaNaming.EscapeIdentifier(member.Name));
            sb.Append(i == @enum.Members.Count - 1 ? "\n" : ",\n");
        }
    }

    /// <summary>
    /// Writes the constant list for a smart enum: each constant invokes the canonical constructor with its
    /// associated literal values (<c>GOLD(2L, "au")</c>). The last constant is terminated with <c>;</c> so the
    /// field/constructor/accessor members can follow.
    /// </summary>
    private static void WriteDataConstants(StringBuilder sb, EnumDecl @enum, JavaExpressionTranslator translator)
    {
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            EnumMember member = @enum.Members[i];
            WriteJavadoc(sb, member.Doc, Indent);
            sb.Append(Indent).Append(JavaNaming.EscapeIdentifier(member.Name)).Append('(');
            for (var a = 0; a < @enum.Signature.Count; a++)
            {
                if (a > 0)
                {
                    sb.Append(", ");
                }

                Param field = @enum.Signature[a];
                Expr? arg = member.Args.Count > a ? member.Args[a] : null;
                sb.Append(EnumConstantArg(field.Type, arg, translator));
            }

            sb.Append(')');
            sb.Append(i == @enum.Members.Count - 1 ? ";\n" : ",\n");
        }
    }

    /// <summary>
    /// Writes the <c>private final</c> fields, the private canonical constructor that assigns them, and one
    /// public accessor method per field — the Java idiom for an enum carrying constant data. Field names are
    /// <c>camelCase</c> (<see cref="JavaNaming.Member"/>) and types come from <see cref="JavaTypeMapper"/>.
    /// </summary>
    private static void WriteEnumFieldsAndAccessors(
        StringBuilder sb, string name, EnumDecl @enum, JavaTypeMapper typeMapper)
    {
        sb.Append('\n');
        foreach (Param field in @enum.Signature)
        {
            sb.Append(Indent).Append("private final ").Append(typeMapper.Map(field.Type)).Append(' ')
              .Append(JavaNaming.Member(field.Name)).Append(";\n");
        }

        sb.Append('\n');
        var parameters = string.Join(
            ", ",
            @enum.Signature.Select(p => typeMapper.Map(p.Type) + " " + JavaNaming.Member(p.Name)));
        sb.Append(Indent).Append("private ").Append(name).Append('(').Append(parameters).Append(") {\n");
        foreach (Param field in @enum.Signature)
        {
            var f = JavaNaming.Member(field.Name);
            sb.Append(Indent).Append(Indent).Append("this.").Append(f).Append(" = ").Append(f).Append(";\n");
        }

        sb.Append(Indent).Append("}\n");

        foreach (Param field in @enum.Signature)
        {
            sb.Append('\n');
            var f = JavaNaming.Member(field.Name);
            sb.Append(Indent).Append("public ").Append(typeMapper.Map(field.Type)).Append(' ')
              .Append(f).Append("() {\n");
            sb.Append(Indent).Append(Indent).Append("return this.").Append(f).Append(";\n");
            sb.Append(Indent).Append("}\n");
        }
    }

    /// <summary>
    /// The Java expression for one associated-data argument of a smart-enum constant: the literal rendered by
    /// the shared translator, or — should a member carry fewer args than the signature (a malformed model the
    /// validator normally rejects) — a benign type default so the emitted enum still compiles.
    /// </summary>
    private static string EnumConstantArg(TypeRef type, Expr? arg, JavaExpressionTranslator translator)
    {
        if (arg is not null)
        {
            return translator.Translate(arg);
        }

        return type.Name switch
        {
            "String" => "\"\"",
            "Bool" => "false",
            "Decimal" => "java.math.BigDecimal.ZERO",
            _ => "0L",
        };
    }
}
