using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The smart-enum slice of <see cref="RustEmitter"/>. A Koine <c>enum</c> emits as a data-free Rust
/// <c>enum</c> of unit variants (so it is <c>Copy</c> and exhaustively matchable). Associated constant
/// data (e.g. <c>EUR("€", 2)</c>) is exposed not as enum payload but as one accessor method per
/// signature field, each an exhaustive <c>match</c> over the variants — idiomatic Rust, and adding a
/// variant becomes a compile error in those matches downstream (a feature).
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitEnum(StringBuilder sb, RustEmitContext emit, EnumDecl @enum)
    {
        var name = RustNaming.ToPascalCase(@enum.Name);

        WriteDoc(sb, @enum.Doc, string.Empty);
        sb.Append("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\n");
        sb.Append("pub enum ").Append(name).Append(" {\n");
        foreach (EnumMember member in @enum.Members)
        {
            WriteDoc(sb, member.Doc, Indent);
            sb.Append(Indent).Append(RustNaming.Variant(member.Name)).Append(",\n");
        }
        sb.Append("}\n");

        if (!@enum.HasAssociatedData)
        {
            return;
        }

        // One accessor method per signature field, each an exhaustive match over the variants.
        sb.Append('\n');
        sb.Append("impl ").Append(name).Append(" {\n");
        for (var i = 0; i < @enum.Signature.Count; i++)
        {
            Param field = @enum.Signature[i];
            var (returnType, _) = EnumDataReturn(field.Type);
            if (i > 0)
            {
                sb.Append('\n');
            }
            sb.Append(Indent).Append("pub fn ").Append(RustNaming.Field(field.Name))
              .Append("(&self) -> ").Append(returnType).Append(" {\n");
            sb.Append(Indent).Append(Indent).Append("match self {\n");
            foreach (EnumMember member in @enum.Members)
            {
                sb.Append(Indent).Append(Indent).Append(Indent)
                  .Append(name).Append("::").Append(RustNaming.Variant(member.Name)).Append(" => ")
                  .Append(EnumDataValue(field.Type, member.Args.Count > i ? member.Args[i] : null)).Append(",\n");
            }
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append("}\n");
        }
        sb.Append("}\n");
    }

    /// <summary>The accessor return type for a smart-enum associated-data field (a <c>'static</c> borrow for strings).</summary>
    private static (string ReturnType, bool ByRef) EnumDataReturn(TypeRef type) => type.Name switch
    {
        "String" => ("&'static str", true),
        "Int" => ("i64", false),
        "Bool" => ("bool", false),
        "Decimal" => ("Decimal", false),
        _ => ("i64", false),
    };

    /// <summary>The literal value for a smart-enum associated-data field of a given variant.</summary>
    private static string EnumDataValue(TypeRef type, Expr? arg)
    {
        if (arg is not LiteralExpr lit)
        {
            return type.Name switch { "String" => "\"\"", "Bool" => "false", _ => "0" };
        }

        return lit.Kind switch
        {
            LiteralKind.String => "\"" + EscapeRustString(lit.Text) + "\"",
            LiteralKind.Bool => lit.Text == "true" ? "true" : "false",
            LiteralKind.Decimal => "crate::koine_runtime::dec(\"" + lit.Text + "\")",
            _ => lit.Text,
        };
    }

    private static string EscapeRustString(string s)
    {
        var sb = new StringBuilder(s.Length + 2);
        foreach (var c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                default: sb.Append(c); break;
            }
        }
        return sb.ToString();
    }
}
