using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// Shared Markdown rendering helpers for the two documentation surfaces (the glossary and the living
/// docs). Centralizes type-reference rendering, evolution tags, field tables, business-rule lists, and
/// text escaping so both emitters stay byte-consistent rather than carrying near-identical copies.
/// Target-agnostic: consumes only the <see cref="KoineModel"/>.
/// </summary>
public static class MarkdownDoc
{
    /// <summary>Renders a Koine type reference in source syntax (target-agnostic).</summary>
    public static string KoineType(TypeRef t)
    {
        var s = t switch
        {
            { Value: not null, Element: not null } => $"{t.Name}<{KoineType(t.Element)}, {KoineType(t.Value)}>",
            { Element: not null } => $"{t.Name}<{KoineType(t.Element)}>",
            _ => t.Name
        };
        return t.IsOptional ? s + "?" : s;
    }

    /// <summary>The evolution suffix for a type/field heading: <c> _(since v2; deprecated: reason)_</c> (R15.1).</summary>
    public static string Tag(TypeDecl t) => Tag(t.Since, t.Deprecated);

    public static string Tag(int? since, string? deprecated)
    {
        var parts = new List<string>();
        if (since is { } s)
        {
            parts.Add("since v" + s);
        }

        if (!string.IsNullOrEmpty(deprecated))
        {
            parts.Add("deprecated: " + deprecated);
        }

        return parts.Count == 0 ? string.Empty : " _(" + Prose(string.Join("; ", parts)) + ")_";
    }

    /// <summary>Writes the members of a type as a Markdown table, marking derived/computed fields.</summary>
    public static void WriteFields(StringBuilder sb, IReadOnlyList<Member> members)
    {
        if (members.Count == 0)
        {
            return;
        }

        var names = new HashSet<string>(members.Select(m => m.Name), StringComparer.Ordinal);

        sb.Append("\n| Field | Type | Description |\n| --- | --- | --- |\n");
        foreach (Member m in members)
        {
            var description = Cell(m.Doc);
            if (MemberAnalysis.IsDerived(m, names))
            {
                description = description.Length == 0 ? "_derived_" : "_derived_ — " + description;
            }

            var tag = Tag(m.Since, m.Deprecated);
            if (tag.Length != 0)
            {
                description = description.Length == 0 ? tag.Trim() : description + tag;
            }

            sb.Append("| ").Append(m.Name)
              .Append(" | `").Append(KoineType(m.Type)).Append('`')
              .Append(" | ").Append(description).Append(" |\n");
        }
    }

    /// <summary>Writes the business rules (invariants) of a type as a bulleted list.</summary>
    public static void WriteRules(StringBuilder sb, IReadOnlyList<Invariant> invariants)
    {
        if (invariants.Count == 0)
        {
            return;
        }

        sb.Append("\n**Business rules**\n");
        foreach (Invariant inv in invariants)
        {
            sb.Append("- ").Append(Prose(inv.Message ?? ExprDescriber.Describe(inv.Condition))).Append('\n');
        }
    }

    /// <summary>Renders the values of an enum, including any associated constant data (e.g. <c>EUR("€", 2)</c>).</summary>
    public static string EnumValues(EnumDecl en) =>
        string.Join(", ", en.Members.Select(m =>
            m.Args.Count == 0
                ? m.Name
                : $"{m.Name}({string.Join(", ", m.Args.Select(ExprDescriber.Describe))})"));

    /// <summary>Collapses a (possibly multi-line) doc into a single Markdown table cell.</summary>
    public static string Cell(string? doc) =>
        string.IsNullOrEmpty(doc) ? string.Empty : EscapeMarkdown(doc).Replace("\n", " ").Replace("|", "\\|");

    /// <summary>Normalizes a doc/rule for prose (single line, escaped).</summary>
    public static string Prose(string text) =>
        EscapeMarkdown(text).Replace("\r", string.Empty).Replace("\n", " ").Trim();

    /// <summary>Escapes characters Markdown/CommonMark treats as raw HTML or entities.</summary>
    public static string EscapeMarkdown(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
}
