using System.Text;

namespace Koine.Compiler;

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
    /// No leading underscore is ever produced. Digits never start a new word (<c>V2Import</c> →
    /// <c>v2import</c>, not <c>v2_import</c>) — unlike <see cref="RouteDerivation.Kebab"/>, which does
    /// split after a digit; passing <c>splitAfterDigit: false</c> below preserves this method's
    /// original behavior (#1239 code review: the two pre-extraction implementations genuinely
    /// disagreed on this).
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

        // Thin wrapper over the shared IdentifierWords.Split boundary rule (#1239). The
        // already-snake_case short-circuit above is Python-local input handling, not part of the
        // shared core.
        var joined = string.Join('_', IdentifierWords.Split(name, splitAfterDigit: false)).ToLowerInvariant();
        return IdentifierWords.CollapseSeparatorRuns(joined, '_').TrimStart('_');
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
