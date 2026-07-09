using System.Text;

namespace Koine.Compiler;

/// <summary>
/// PHP-specific identifier casing and keyword-escaping helpers. Class names are
/// <c>PascalCase</c>, method/property names are <c>camelCase</c>, constants are
/// <c>UPPER_SNAKE</c>, and namespaces follow <c>Koine\&lt;Context&gt;</c> shape.
/// PHP reserved words and type keywords are escaped by appending a trailing underscore
/// so the emitted code is valid everywhere an identifier appears.
/// </summary>
internal static class PhpNaming
{
    // PHP reserved words that cannot be used as class/function/method/constant names.
    // Includes language keywords, compile-time constants, and pseudo-types.
    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
    {
        // Language keywords
        "abstract", "and", "array", "as",
        "break",
        "callable", "case", "catch", "class", "clone", "const", "continue",
        "declare", "default", "die", "do",
        "echo", "else", "elseif", "empty", "enddeclare", "endfor", "endforeach",
        "endif", "endswitch", "endwhile", "enum", "eval", "exit", "extends",
        "final", "finally", "fn", "for", "foreach", "function",
        "global", "goto",
        "if", "implements", "include", "include_once", "instanceof", "insteadof",
        "interface", "isset",
        "list",
        "match", "mixed",
        "namespace", "never", "new",
        "object", "or",
        "print", "private", "protected", "public",
        "readonly", "require", "require_once", "return",
        "static", "switch",
        "throw", "trait", "try",
        "unset", "use",
        "var",
        "while",
        "xor",
        "yield",
        // Compile-time constants (cannot be used as identifiers)
        "null", "true", "false",
        // Type keywords (reserved as type declarations in PHP 8+)
        "string", "int", "float", "bool", "void", "iterable",
    };

    /// <summary>
    /// Returns the PascalCase class name for <paramref name="name"/>, escaping PHP reserved words
    /// with a trailing <c>_</c>. The check is done on the <em>raw</em> input (case-insensitive for
    /// type keywords like <c>int</c>/<c>string</c>) before PascalCasing, since those names can never
    /// be valid PHP class names. Examples: <c>order_line</c> → <c>OrderLine</c>,
    /// <c>class</c> → <c>class_</c>, <c>int</c> → <c>int_</c>.
    /// </summary>
    public static string ClassName(string name)
    {
        // Escape on the raw input: if the name itself is a PHP keyword, append _ and return as-is
        // (the emitter should not PascalCase a reserved word — e.g. "match" → "match_", not "Match_").
        if (Keywords.Contains(name))
        {
            return name + "_";
        }

        // Not a keyword: PascalCase it. Then double-check the pascalled result isn't somehow a keyword.
        var pascal = ToPascalCase(name);
        return EscapeIdentifier(pascal);
    }

    /// <summary>
    /// Returns the camelCase method name for <paramref name="name"/>, escaping PHP reserved words
    /// with a trailing <c>_</c> so the result is safe as a bare method name everywhere (a derived
    /// member named <c>match</c>/<c>list</c>/<c>fn</c> would otherwise emit a keyword → parse error).
    /// Examples: <c>UnitPrice</c> → <c>unitPrice</c>, <c>match</c> → <c>match_</c>.
    /// </summary>
    public static string MethodName(string name) => EscapeIdentifier(ToCamelCase(name));

    /// <summary>
    /// Returns the camelCase property name for <paramref name="name"/>, escaping PHP reserved words
    /// with a trailing <c>_</c> (same rationale as <see cref="MethodName"/>).
    /// Examples: <c>UnitPrice</c> → <c>unitPrice</c>, <c>match</c> → <c>match_</c>.
    /// </summary>
    public static string PropertyName(string name) => EscapeIdentifier(ToCamelCase(name));

    /// <summary>
    /// Returns the <c>UPPER_SNAKE</c> constant name for <paramref name="name"/>.
    /// Examples: <c>OrderStatus</c> → <c>ORDER_STATUS</c>.
    /// </summary>
    public static string ConstName(string name) => ToSnakeCase(name).ToUpperInvariant();

    /// <summary>
    /// Returns the PHP namespace for a bounded context in the form <c>Koine\&lt;Context&gt;</c>.
    /// The context name is PascalCased. Example: <c>billing</c> → <c>Koine\Billing</c>.
    /// </summary>
    public static string Namespace(string contextName) => $@"Koine\{ToPascalCase(contextName)}";

    /// <summary>
    /// Returns <paramref name="name"/> unchanged if it is not a PHP reserved word;
    /// appends a trailing <c>_</c> if it is.
    /// Examples: <c>match</c> → <c>match_</c>, <c>amount</c> → <c>amount</c>.
    /// </summary>
    public static string EscapeIdentifier(string name) =>
        Keywords.Contains(name) ? name + "_" : name;

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /// <summary>
    /// Converts an identifier to <c>PascalCase</c> (type names). Handles snake_case,
    /// camelCase, and already-PascalCase inputs.
    /// </summary>
    internal static string ToPascalCase(string name)
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
    /// Converts an identifier to <c>camelCase</c> (method/property names). Handles PascalCase,
    /// snake_case, and acronym inputs. Goes through snake_case then re-capitalises each word
    /// except the first, so acronyms are treated word-by-word:
    /// <c>ID</c> → <c>id</c>, <c>OrderID</c> → <c>orderId</c>, <c>UnitPrice</c> → <c>unitPrice</c>.
    /// Names that are already camelCase (start lowercase, no underscores) are returned as-is.
    /// </summary>
    private static string ToCamelCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        // Fast-path: already camelCase (starts lowercase, no underscores) — return unchanged.
        if (char.IsLower(name[0]) && !name.Contains('_'))
        {
            return name;
        }

        // Convert to snake_case first to split on word boundaries including acronyms.
        var snake = ToSnakeCase(name);

        // Then capitalise every word except the first.
        var segments = snake.Split('_');
        if (segments.Length == 0)
        {
            return snake;
        }

        var sb = new StringBuilder();
        sb.Append(segments[0]); // first word stays lowercase
        for (int i = 1; i < segments.Length; i++)
        {
            if (segments[i].Length == 0)
            {
                continue;
            }

            sb.Append(char.ToUpperInvariant(segments[i][0]));
            sb.Append(segments[i][1..]);
        }

        return sb.ToString();
    }

    /// <summary>
    /// Converts an identifier to <c>snake_case</c>. Handles PascalCase, camelCase, acronym runs:
    /// <c>UnitPrice</c> → <c>unit_price</c>, <c>URLPath</c> → <c>url_path</c>,
    /// <c>ID</c> → <c>id</c>. Digits never start a new word (<c>V2Import</c> → <c>v2import</c>, not
    /// <c>v2_import</c>) — unlike <see cref="RouteDerivation.Kebab"/>, which does split after a
    /// digit; passing <c>splitAfterDigit: false</c> below preserves this method's original behavior
    /// (#1239 code review: the two pre-extraction implementations genuinely disagreed on this). Thin
    /// wrapper over the shared <see cref="IdentifierWords.Split"/> boundary rule; the already-snake_case
    /// short-circuit below is Php-local input handling, not part of the shared core.
    /// </summary>
    private static string ToSnakeCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        // If it already looks like snake_case (all lower, digits, underscores) return as-is.
        if (IsAlreadySnakeCase(name))
        {
            return name;
        }

        var joined = string.Join('_', IdentifierWords.Split(name, splitAfterDigit: false)).ToLowerInvariant();
        return IdentifierWords.CollapseSeparatorRuns(joined, '_').TrimStart('_');
    }

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
