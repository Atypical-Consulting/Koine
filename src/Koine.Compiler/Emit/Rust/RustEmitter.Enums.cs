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

        // Per-enum member→variant names, de-duplicated so members that PascalCase-collapse (e.g. `EUR`
        // and `Eur` both fold to `Eur`) emit distinct, compiling variants instead of a duplicate
        // definition (#323). Computed once and used at every variant-emission site below; member
        // references resolve through the same shared map in RustExpressionTranslator.
        IReadOnlyList<string> variants = RustNaming.UniqueVariants(@enum.MemberNames);

        WriteDoc(sb, @enum.Doc, string.Empty);
        sb.Append("#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]\n");
        sb.Append("pub enum ").Append(name).Append(" {\n");
        for (var i = 0; i < @enum.Members.Count; i++)
        {
            WriteDoc(sb, @enum.Members[i].Doc, Indent);
            sb.Append(Indent).Append(variants[i]).Append(",\n");
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
            for (var m = 0; m < @enum.Members.Count; m++)
            {
                EnumMember member = @enum.Members[m];
                sb.Append(Indent).Append(Indent).Append(Indent)
                  .Append(name).Append("::").Append(variants[m]).Append(" => ")
                  .Append(EnumDataValue(field.Type, member.Args.Count > i ? member.Args[i] : null)).Append(",\n");
            }
            sb.Append(Indent).Append(Indent).Append("}\n");
            sb.Append(Indent).Append("}\n\n");
        }

        EmitEnumApi(sb, name, @enum, variants);

        sb.Append("}\n");
    }

    /// <summary>
    /// Emits the smart-enum API on a Rust enum — the analogue of the C#/TS <c>TryFromName</c>/
    /// <c>TryFromValue</c> and <c>Match</c>/<c>Switch</c>: non-throwing <c>from_name</c>/<c>from_value</c>
    /// lookups returning <c>Option</c>, and exhaustive <c>match_</c>/<c>switch</c> folds (one closure per
    /// variant, dispatched by a wildcard-free <c>match</c> so adding a member is a compile error at every
    /// call site — the closed-set safety a bare Rust <c>enum</c> match already gives, surfaced as a fluent API).
    /// </summary>
    private void EmitEnumApi(StringBuilder sb, string name, EnumDecl @enum, IReadOnlyList<string> variants)
    {
        IReadOnlyList<EnumMember> members = @enum.Members;
        // Closure parameter names, one per member and shared by both the match_ and switch folds.
        // De-duplicated per enum so members that snake_case-collapse (e.g. `userID`/`userId` → both
        // `user_id`) still bind distinct, compiling Rust identifiers (#315). The PascalCase variant names
        // (`variants`) are de-duplicated the same way (#323) and shared across every site below.
        IReadOnlyList<string> arms = RustNaming.UniqueBindings(members.Select(m => m.Name));

        // from_name — the non-throwing name lookup (`TryFromName` -> Option). The `_ => None` arm
        // covers the open &str input domain; it is NOT a wildcard over the (closed) variant set.
        sb.Append(Indent).Append("/// Looks up a variant by its declared name (a non-throwing `TryFromName`).\n");
        sb.Append(Indent).Append("pub fn from_name(name: &str) -> Option<Self> {\n");
        sb.Append(Indent).Append(Indent).Append("match name {\n");
        for (var i = 0; i < members.Count; i++)
        {
            sb.Append(Indent).Append(Indent).Append(Indent)
              .Append('"').Append(EscapeRustString(members[i].Name)).Append("\" => Some(").Append(name).Append("::").Append(variants[i]).Append("),\n");
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
              .Append(i).Append(" => Some(").Append(name).Append("::").Append(variants[i]).Append("),\n");
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
              .Append(name).Append("::").Append(variants[i]).Append(" => ").Append(arms[i]).Append("(),\n");
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
              .Append(name).Append("::").Append(variants[i]).Append(" => ").Append(arms[i]).Append("(),\n");
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
