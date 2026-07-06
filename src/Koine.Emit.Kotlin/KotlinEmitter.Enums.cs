using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The smart-enum slice of <see cref="KotlinEmitter"/>. A Koine <c>enum</c> maps onto a Kotlin
/// <c>enum class</c> — the closest thing to Koine's closed, exhaustively-<c>when</c>-matchable set of named
/// members, so no generated Match/Switch helpers are needed (a wildcard-free <c>when</c> over the entries is
/// exhaustive, and adding a member is a compile error at every call site). A bare-name enum is just its
/// entry list; a smart enum carrying associated constant data (e.g. <c>EUR("€", 2)</c>) becomes an
/// <c>enum class</c> whose primary constructor declares one <c>val</c> per signature entry — the <c>val</c>
/// <em>is</em> the accessor, so unlike the Java sibling there is no private-field-plus-getter boilerplate.
/// Every enum gains a companion <c>fromKey</c>/<c>tryFromKey</c> pair: the neutral-key lookups (by member
/// name) that stand in for the C#/Rust <c>TryFromName</c>, throwing <c>DomainException</c> vs returning null.
/// <para>
/// Entry identifiers are spelled <see cref="KotlinNaming.EscapeIdentifier"/> of the raw member name —
/// byte-for-byte what <see cref="KotlinExpressionTranslator"/> renders for an enum-member reference
/// (<c>&lt;EnumType&gt;.&lt;member&gt;</c>), so a <c>when</c>-guard or derived field comparing against a
/// member keeps compiling. A member named after a Kotlin hard keyword (e.g. <c>object</c>) is backtick-escaped.
/// </para>
/// </summary>
public sealed partial class KotlinEmitter
{
    /// <summary>Emits one smart enum as a Kotlin <c>enum class</c> file (one top-level type per file).</summary>
    private EmittedFile EmitEnum(KotlinEmitContext emit, string context, EnumDecl @enum)
    {
        var name = KotlinNaming.ToTypeName(@enum.Name);
        var typeMapper = new KotlinTypeMapper(emit.Index, context, PackageFor);

        var sb = new StringBuilder();
        WriteKdoc(sb, @enum.Doc, string.Empty);
        sb.Append("enum class ").Append(name);

        if (@enum.HasAssociatedData)
        {
            // The primary-constructor `val`s carry the associated data (Kotlin makes them the accessors).
            var parameters = string.Join(
                ", ", @enum.Signature.Select(p => "val " + KotlinNaming.ToMemberName(p.Name) + ": " + typeMapper.Map(p.Type)));
            sb.Append('(').Append(parameters).Append(')');
        }

        sb.Append(" {\n");
        WriteEntries(sb, emit, context, @enum, typeMapper);
        sb.Append('\n');
        WriteKeyLookups(sb, name);
        sb.Append("}\n");

        return TypeFile(context, name, sb.ToString());
    }

    /// <summary>
    /// Writes the enum entries, each terminated with <c>,</c> except the last which takes <c>;</c> (the enum
    /// always carries a companion object after the entries). A data-carrying entry invokes the primary
    /// constructor with its associated literal values (<c>EUR("€", 2L)</c>).
    /// </summary>
    private void WriteEntries(StringBuilder sb, KotlinEmitContext emit, string context, EnumDecl @enum, KotlinTypeMapper typeMapper)
    {
        // Enum entry args are literal expressions; the shared translator renders them exactly like any other
        // literal (Int -> `2L`, String -> escaped quotes, Decimal -> `java.math.BigDecimal("…")`). There is no
        // member scope for a bare literal, so an empty member list suffices.
        var translator = new KotlinExpressionTranslator(
            emit.Index, Array.Empty<Member>(), typeMapper, context, memberReceiver: "this", emit.EnumMemberToType);

        for (var i = 0; i < @enum.Members.Count; i++)
        {
            EnumMember member = @enum.Members[i];
            WriteKdoc(sb, member.Doc, Indent);
            sb.Append(Indent).Append(KotlinNaming.EscapeIdentifier(member.Name));

            if (@enum.HasAssociatedData)
            {
                sb.Append('(');
                for (var a = 0; a < @enum.Signature.Count; a++)
                {
                    if (a > 0)
                    {
                        sb.Append(", ");
                    }

                    Param field = @enum.Signature[a];
                    Expr? arg = member.Args.Count > a ? member.Args[a] : null;
                    sb.Append(EnumEntryArg(field.Type, arg, translator));
                }

                sb.Append(')');
            }

            sb.Append(i == @enum.Members.Count - 1 ? ";\n" : ",\n");
        }
    }

    /// <summary>
    /// Writes the companion <c>fromKey</c>/<c>tryFromKey</c> pair: the neutral-key lookups by member name.
    /// <c>tryFromKey</c> returns the matching entry or <c>null</c>; <c>fromKey</c> throws
    /// <c>DomainException</c> when no member matches (the throwing/nullable dual of the C#/Rust
    /// <c>TryFromName</c>).
    /// </summary>
    private static void WriteKeyLookups(StringBuilder sb, string name)
    {
        sb.Append(Indent).Append("companion object {\n");
        WriteKdoc(sb, "The member whose key (name) matches " + name + ", or null if none does.", Indent + Indent);
        sb.Append(Indent).Append(Indent).Append("fun tryFromKey(key: String): ").Append(name)
          .Append("? = entries.find { it.name == key }\n\n");
        WriteKdoc(sb, "The member whose key (name) matches " + name + ", throwing if none does.", Indent + Indent);
        sb.Append(Indent).Append(Indent).Append("fun fromKey(key: String): ").Append(name)
          .Append(" = tryFromKey(key) ?: throw koine.runtime.DomainException(\"no ").Append(name).Append(" with key '$key'\")\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>
    /// The Kotlin expression for one associated-data argument of a smart-enum entry: the literal rendered by
    /// the shared translator, or — should a member carry fewer args than the signature (a malformed model the
    /// validator normally rejects) — a benign type default so the emitted enum still compiles.
    /// </summary>
    private static string EnumEntryArg(TypeRef type, Expr? arg, KotlinExpressionTranslator translator)
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
