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
    private void EmitEnum(StringBuilder sb, EnumDecl @enum)
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

        sb.Append('\n');
        sb.Append("impl ").Append(name).Append(" {\n");

        // One accessor method per signature field, each an exhaustive match over the variants.
        for (var i = 0; i < @enum.Signature.Count; i++)
        {
            Param field = @enum.Signature[i];
            var returnType = EnumDataReturn(field.Type);
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
            sb.Append(Indent).Append("}\n\n");
        }

        EmitEnumApi(sb, name, @enum);

        sb.Append("}\n");
    }

    /// <summary>
    /// Emits the smart-enum API on a Rust enum — the analogue of the C#/TS <c>TryFromName</c>/
    /// <c>TryFromValue</c> and <c>Match</c>/<c>Switch</c>: non-throwing <c>from_name</c>/<c>from_value</c>
    /// lookups returning <c>Option</c>, and exhaustive <c>match_</c>/<c>switch</c> folds (one closure per
    /// variant, dispatched by a wildcard-free <c>match</c> so adding a member is a compile error at every
    /// call site — the closed-set safety a bare Rust <c>enum</c> match already gives, surfaced as a fluent API).
    /// </summary>
    private void EmitEnumApi(StringBuilder sb, string name, EnumDecl @enum)
    {
        IReadOnlyList<EnumMember> members = @enum.Members;
        var arms = members.Select(m => RustNaming.Field(m.Name)).ToList(); // closure parameter names

        // from_name — the non-throwing name lookup (`TryFromName` -> Option). The `_ => None` arm
        // covers the open &str input domain; it is NOT a wildcard over the (closed) variant set.
        sb.Append(Indent).Append("/// Looks up a variant by its declared name (a non-throwing `TryFromName`).\n");
        sb.Append(Indent).Append("pub fn from_name(name: &str) -> Option<Self> {\n");
        sb.Append(Indent).Append(Indent).Append("match name {\n");
        foreach (EnumMember m in members)
        {
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append('"').Append(EscapeRustString(m.Name)).Append("\" => Some(").Append(name).Append("::").Append(RustNaming.Variant(m.Name)).Append("),\n");
        }

        sb.Append(Indent).Append(Indent).Append(Indent).Append("_ => None,\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n\n");

        // from_value — the non-throwing ordinal lookup (`TryFromValue` -> Option).
        sb.Append(Indent).Append("/// Looks up a variant by its ordinal value (a non-throwing `TryFromValue`).\n");
        sb.Append(Indent).Append("pub fn from_value(value: i64) -> Option<Self> {\n");
        sb.Append(Indent).Append(Indent).Append("match value {\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append(i).Append(" => Some(").Append(name).Append("::").Append(RustNaming.Variant(members[i].Name)).Append("),\n");
        }

        sb.Append(Indent).Append(Indent).Append(Indent).Append("_ => None,\n");
        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n\n");

        // match_ — exhaustive fold to a value (`Match`), one closure per variant, no catch-all.
        sb.Append(Indent).Append("/// Exhaustively maps the variant to a value — one arm per member, no catch-all.\n");
        sb.Append(Indent).Append("pub fn match_<R>(\n");
        sb.Append(Indent).Append(Indent).Append("&self,\n");
        foreach (var arm in arms)
        {
            sb.Append(Indent).Append(Indent).Append(arm).Append(": impl FnOnce() -> R,\n");
        }

        sb.Append(Indent).Append(") -> R {\n");
        sb.Append(Indent).Append(Indent).Append("match self {\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append(name).Append("::").Append(RustNaming.Variant(members[i].Name)).Append(" => ").Append(arms[i]).Append("(),\n");
        }

        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n\n");

        // switch — exhaustive side-effecting dispatch (`Switch`), one closure per variant, no catch-all.
        sb.Append(Indent).Append("/// Exhaustively dispatches a side effect — one arm per member, no catch-all.\n");
        sb.Append(Indent).Append("pub fn switch(\n");
        sb.Append(Indent).Append(Indent).Append("&self,\n");
        foreach (var arm in arms)
        {
            sb.Append(Indent).Append(Indent).Append(arm).Append(": impl FnOnce(),\n");
        }

        sb.Append(Indent).Append(") {\n");
        sb.Append(Indent).Append(Indent).Append("match self {\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append(name).Append("::").Append(RustNaming.Variant(members[i].Name)).Append(" => ").Append(arms[i]).Append("(),\n");
        }

        sb.Append(Indent).Append(Indent).Append("}\n");
        sb.Append(Indent).Append("}\n");
    }

    /// <summary>The accessor return type for a smart-enum associated-data field (a <c>'static</c> borrow for strings).</summary>
    private static string EnumDataReturn(TypeRef type) => type.Name switch
    {
        "String" => "&'static str",
        "Int" => "i64",
        "Bool" => "bool",
        "Decimal" => "Decimal",
        _ => "i64",
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
