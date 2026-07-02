using System.Text;

namespace Koine.Compiler.Emit.Python;

/// <summary>
/// Python-specific identifier casing and keyword-escaping helpers. Types are <c>PascalCase</c>,
/// members and parameters are <c>snake_case</c>, enum members are <c>UPPER_SNAKE</c>. Python
/// keywords and soft-keywords are escaped by appending a trailing underscore so the emitted
/// code is valid everywhere a member name appears.
/// <para>
/// Unlike TypeScript, Python reserves several identifiers as keywords or soft-keywords
/// (<c>match</c>, <c>case</c>, <c>type</c>, <c>_</c>), so an explicit escaping counterpart
/// to <see cref="CSharp.CSharpNaming.EscapeIdentifier"/> is required here.
/// </para>
/// </summary>
internal static class PythonNaming
{
    // Full set of Python hard keywords (keyword.kwlist in CPython 3.11+).
    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
    {
        "False", "None", "True",
        "and", "as", "assert", "async", "await",
        "break", "class", "continue", "def", "del",
        "elif", "else", "except", "finally", "for", "from",
        "global", "if", "import", "in", "is",
        "lambda", "nonlocal", "not", "or", "pass",
        "raise", "return", "try", "while", "with", "yield",
        // Soft keywords (context-sensitive but reserved to avoid collision):
        "match", "case", "type",
        // The lone underscore is special (discard / pattern wildcard) — escape it too.
        "_",
    };

    /// <summary>
    /// Converts an identifier to <c>PascalCase</c> (type names). Handles snake_case, camelCase,
    /// and already-PascalCase inputs: <c>order_line</c> → <c>OrderLine</c>,
    /// <c>OrderLine</c> → <c>OrderLine</c>, <c>unitPrice</c> → <c>UnitPrice</c>.
    /// </summary>
    public static string ToPascalCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        // Fast-path: already PascalCase (starts uppercase, no underscores).
        if (char.IsUpper(name[0]) && !name.Contains('_'))
        {
            return name;
        }

        // Split on underscores and capitalise each segment, then capitalise first letter of camel.
        var sb = new StringBuilder(name.Length);
        bool capitaliseNext = true;

        foreach (char c in name)
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

    /// <summary>
    /// Converts an identifier to <c>snake_case</c> (members, parameters, module filenames).
    /// Handles PascalCase, camelCase, already-snake_case inputs, and acronym runs:
    /// <c>UnitPrice</c> → <c>unit_price</c>, <c>unitPrice</c> → <c>unit_price</c>,
    /// <c>URLPath</c> → <c>url_path</c>, <c>subtotal</c> → <c>subtotal</c>.
    /// No leading underscore is ever produced.
    /// </summary>
    public static string ToSnakeCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        // If it already looks like snake_case (all lower, digits, underscores) return as-is
        // (preserves existing underscores without doubling them).
        if (IsAlreadySnakeCase(name))
        {
            return name;
        }

        var sb = new StringBuilder(name.Length + 4);

        // Insert underscores before transitions: lower→upper and upper→upper-followed-by-lower
        // (the latter handles acronym runs like "URLPath" → "url_path").
        for (int i = 0; i < name.Length; i++)
        {
            char c = name[i];

            if (c == '_')
            {
                // Pass through existing underscores; avoid doubles at the start.
                if (sb.Length > 0 && sb[sb.Length - 1] != '_')
                {
                    sb.Append('_');
                }
                continue;
            }

            if (char.IsUpper(c))
            {
                bool prevIsLower = i > 0 && char.IsLower(name[i - 1]);
                bool nextIsLower = i + 1 < name.Length && char.IsLower(name[i + 1]);
                bool prevIsUpper = i > 0 && char.IsUpper(name[i - 1]);
                bool prevIsUnderscore = i > 0 && name[i - 1] == '_';

                // Insert underscore before this capital if:
                //   1. Previous char was lowercase (e.g. unitP → unit_p)
                //   2. Previous was uppercase AND next is lowercase (last cap of an acronym run:
                //      URLPath → URL_Path → url_path)
                if (sb.Length > 0 && !prevIsUnderscore && (prevIsLower || (prevIsUpper && nextIsLower)))
                {
                    sb.Append('_');
                }

                sb.Append(char.ToLowerInvariant(c));
            }
            else
            {
                sb.Append(char.ToLowerInvariant(c));
            }
        }

        // Strip any leading underscore that might have been produced.
        var result = sb.ToString().TrimStart('_');
        return result;
    }

    /// <summary>
    /// Converts an identifier to <c>UPPER_SNAKE</c> (enum member names):
    /// <c>OrderStatus</c> → <c>ORDER_STATUS</c>.
    /// </summary>
    public static string ToUpperSnake(string name) =>
        ToSnakeCase(name).ToUpperInvariant();

    /// <summary>
    /// Returns <paramref name="name"/> unchanged if it is not a Python keyword or soft-keyword;
    /// appends a trailing <c>_</c> if it is. The bare underscore <c>_</c> is treated as a
    /// soft-keyword and becomes <c>__</c>.
    /// Examples: <c>match</c> → <c>match_</c>, <c>amount</c> → <c>amount</c>.
    /// </summary>
    public static string EscapeIdentifier(string name) =>
        Keywords.Contains(name) ? name + "_" : name;

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /// <summary>
    /// Returns true if <paramref name="name"/> is already in snake_case:
    /// all characters are lowercase letters, digits, or underscores, and there are no
    /// uppercase transitions.
    /// </summary>
    private static bool IsAlreadySnakeCase(string name)
    {
        foreach (char c in name)
        {
            if (char.IsUpper(c))
            {
                return false;
            }
        }

        return true;
    }
}
