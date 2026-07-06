using System.Text;

namespace Koine.Compiler;

/// <summary>
/// Kotlin-specific identifier casing and hard-keyword escaping helpers. Types are <c>PascalCase</c>,
/// members (properties/functions/parameters) are <c>camelCase</c>, and packages are lowercase segments.
/// Kept here so the target-agnostic <see cref="Ast"/> stays free of Kotlin conventions.
/// <para>
/// Unlike Java (which has no inline keyword escape and so <em>renames</em> a colliding identifier with a
/// trailing underscore), Kotlin escapes a hard keyword used as an identifier by wrapping it in backticks
/// (<c>`when`</c>, <c>`object`</c>, <c>`in`</c>) — the Kotlin analogue of C#'s <c>@name</c> and Rust's
/// <c>r#name</c>. Only the <em>hard</em> keywords need this; Kotlin's <em>soft</em>/modifier keywords
/// (<c>value</c>, <c>data</c>, <c>get</c>, <c>set</c>, …) are legal as identifiers and pass through.
/// Member names route through <see cref="EscapeIdentifier"/>; PascalCase type names cannot collide with
/// the all-lowercase hard-keyword set, so <see cref="ToTypeName"/> does not.
/// </para>
/// </summary>
internal static class KotlinNaming
{
    // The Kotlin *hard* keyword set (Kotlin language spec §"Keywords and operators"): always reserved,
    // so a member/parameter named like one of these is backtick-escaped by EscapeIdentifier. Soft and
    // modifier keywords (value, data, sealed, get, set, in-a-different-position, …) are legal as
    // identifiers and are deliberately absent. `typeof` is reserved for future use — escaped too so a
    // model member named `typeof` never surprises kotlinc.
    private static readonly HashSet<string> HardKeywords = new(StringComparer.Ordinal)
    {
        "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface",
        "is", "null", "object", "package", "return", "super", "this", "throw", "true", "try", "typealias",
        "typeof", "val", "var", "when", "while",
    };

    /// <summary>
    /// Converts an identifier to <c>PascalCase</c> (type names). Handles snake_case, camelCase, and
    /// already-PascalCase inputs: <c>order_line</c> → <c>OrderLine</c>, <c>unitPrice</c> → <c>UnitPrice</c>,
    /// <c>OrderLine</c> → <c>OrderLine</c>.
    /// </summary>
    public static string ToTypeName(string raw) => ToPascalCase(raw);

    /// <summary>
    /// Converts an identifier to <c>camelCase</c> (properties, functions, parameters), then backtick-escapes
    /// it if it collides with a Kotlin hard keyword (<see cref="EscapeIdentifier"/>): <c>UnitPrice</c> →
    /// <c>unitPrice</c>, <c>unit_price</c> → <c>unitPrice</c>, <c>when</c> → <c>`when`</c>.
    /// </summary>
    public static string ToMemberName(string raw)
    {
        var pascal = ToPascalCase(raw);
        if (string.IsNullOrEmpty(pascal))
        {
            return pascal;
        }

        var camel = char.ToLowerInvariant(pascal[0]) + pascal[1..];
        return EscapeIdentifier(camel);
    }

    /// <summary>
    /// The lowercase Kotlin package segment for a bounded-context name: letters are lowercased and word
    /// separators are dropped so the result is a single idiomatic segment (<c>Billing</c> → <c>billing</c>,
    /// <c>OrderManagement</c> → <c>ordermanagement</c>).
    /// </summary>
    public static string ToPackageSegment(string raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return raw;
        }

        var sb = new StringBuilder(raw.Length);
        foreach (var c in raw)
        {
            if (c != '_')
            {
                sb.Append(char.ToLowerInvariant(c));
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// Backtick-escapes a Kotlin <b>hard keyword</b> used as an identifier (<c>when</c> → <c>`when`</c>,
    /// <c>object</c> → <c>`object`</c>, <c>in</c> → <c>`in`</c>) so the emitted name is legal; a
    /// non-keyword (or a soft/modifier keyword, which is legal as an identifier) passes through unchanged.
    /// </summary>
    public static string EscapeIdentifier(string raw) => HardKeywords.Contains(raw) ? "`" + raw + "`" : raw;

    /// <summary>
    /// Converts <paramref name="name"/> to <c>PascalCase</c>. Handles snake_case, camelCase, and
    /// already-PascalCase inputs. Shared by <see cref="ToTypeName"/> and the <see cref="ToMemberName"/>
    /// camelCase step.
    /// </summary>
    public static string ToPascalCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        if (char.IsUpper(name[0]) && !name.Contains('_'))
        {
            return name;
        }

        var sb = new StringBuilder(name.Length);
        var capitaliseNext = true;
        foreach (var c in name)
        {
            if (c == '_')
            {
                capitaliseNext = true;
            }
            else if (capitaliseNext)
            {
                sb.Append(char.ToUpperInvariant(c));
                capitaliseNext = false;
            }
            else
            {
                sb.Append(c);
            }
        }

        return sb.ToString();
    }
}
