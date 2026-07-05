using System.Text;

namespace Koine.Compiler;

/// <summary>
/// Java-specific identifier casing and keyword-renaming helpers. Types are <c>PascalCase</c>, members
/// (fields/methods/parameters) are <c>camelCase</c>, and packages are lowercase segments. Kept here so
/// the target-agnostic <see cref="Ast"/> stays free of Java conventions.
/// <para>
/// Java has no escape syntax for a keyword-as-identifier (there is no C# <c>@name</c> nor Rust
/// <c>r#name</c>), so a Koine member/type whose name collides with a Java reserved word is deterministically
/// <em>renamed</em> with a trailing underscore (<c>class</c> → <c>class_</c>) by
/// <see cref="EscapeIdentifier"/>. Member names route through it; PascalCase type names cannot collide with
/// the all-lowercase keyword set, so <see cref="Type"/> does not.
/// </para>
/// </summary>
internal static class JavaNaming
{
    // The full Java 17 reserved-word set: keywords + the boolean/null literals + the contextual
    // keywords (`var`, `record`, `yield`, `sealed`, `permits`). A member/package named like one of
    // these is renamed with a trailing underscore (see EscapeIdentifier) — Java offers no inline escape.
    private static readonly HashSet<string> Reserved = new(StringComparer.Ordinal)
    {
        "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const",
        "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float",
        "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native",
        "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp",
        "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void",
        "volatile", "while",
        // Literals — reserved and not usable as identifiers.
        "true", "false", "null",
        // Contextual keywords (Java 10/14/16+). Renamed too so emitted names never surprise `javac`.
        "var", "record", "yield", "sealed", "permits",
        // Not keywords, but illegal as `record` component names (JLS 8.10.3): they collide with the
        // implicit `Object` methods a record may not override. Value objects, events and generated ids
        // emit as records whose components are named via Member, so a member named like one of these is
        // renamed with a trailing underscore too — and, on an entity class, this also keeps a member from
        // clashing with the generated `hashCode()`/`toString()`.
        "clone", "finalize", "getClass", "hashCode", "notify", "notifyAll", "toString", "wait",
    };

    /// <summary>
    /// Converts an identifier to <c>PascalCase</c> (type names). Handles snake_case, camelCase, and
    /// already-PascalCase inputs: <c>order_line</c> → <c>OrderLine</c>, <c>unitPrice</c> → <c>UnitPrice</c>,
    /// <c>OrderLine</c> → <c>OrderLine</c>.
    /// </summary>
    public static string Type(string raw) => ToPascalCase(raw);

    /// <summary>
    /// Converts an identifier to <c>camelCase</c> (fields, methods, parameters), then renames it if it
    /// collides with a Java reserved word (<see cref="EscapeIdentifier"/>): <c>UnitPrice</c> →
    /// <c>unitPrice</c>, <c>unit_price</c> → <c>unitPrice</c>, <c>class</c> → <c>class_</c>.
    /// </summary>
    public static string Member(string raw)
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
    /// The lowercase Java package segment for a bounded-context name: letters are lowercased and word
    /// separators are dropped so the result is a single idiomatic segment (<c>Billing</c> → <c>billing</c>,
    /// <c>OrderManagement</c> → <c>ordermanagement</c>). A segment colliding with a reserved word is
    /// renamed (<see cref="EscapeIdentifier"/>).
    /// </summary>
    public static string Package(string raw)
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

        return EscapeIdentifier(sb.ToString());
    }

    /// <summary>
    /// Deterministically renames a Java <b>reserved word</b> by appending a trailing underscore
    /// (<c>class</c> → <c>class_</c>, <c>new</c> → <c>new_</c>, <c>default</c> → <c>default_</c>) so the
    /// emitted identifier is legal; Java has no inline keyword-escape. A non-reserved identifier passes
    /// through unchanged.
    /// </summary>
    public static string EscapeIdentifier(string raw) => Reserved.Contains(raw) ? raw + "_" : raw;

    /// <summary>
    /// Converts <paramref name="name"/> to <c>PascalCase</c>. Handles snake_case, camelCase, and
    /// already-PascalCase inputs. Shared by <see cref="Type"/> and the <see cref="Member"/> camelCase step.
    /// </summary>
    private static string ToPascalCase(string name)
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
