using System.Text;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// Rust-specific identifier casing and keyword-escaping helpers. Types and enum variants are
/// <c>PascalCase</c>, fields/methods/modules are <c>snake_case</c>, associated constants are
/// <c>SCREAMING_SNAKE_CASE</c>. Rust keywords are escaped as raw identifiers (<c>r#type</c>) so the
/// emitted code is valid wherever a Koine member name happens to collide with a Rust keyword.
/// </summary>
internal static class RustNaming
{
    // Rust 2021 reserved words. A field/method/module named like one of these is escaped as a raw
    // identifier (`r#name`). The handful that are NOT valid as raw identifiers (`crate`, `self`,
    // `super`, `Self`) get a trailing-underscore fallback instead (see EscapeIdentifier).
    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
    {
        "as", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern", "false", "fn",
        "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub", "ref",
        "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
        "use", "where", "while", "async", "await", "abstract", "become", "box", "do", "final",
        "macro", "override", "priv", "typeof", "unsized", "virtual", "yield", "try", "union",
    };

    // Raw identifiers (`r#kw`) cannot be formed for these; fall back to a trailing underscore.
    private static readonly HashSet<string> NonRawKeywords = new(StringComparer.Ordinal)
    {
        "crate", "self", "Self", "super",
    };

    /// <summary>
    /// Converts an identifier to <c>PascalCase</c> (type names, enum variants). Handles snake_case,
    /// camelCase, and already-PascalCase inputs: <c>order_line</c> → <c>OrderLine</c>,
    /// <c>unitPrice</c> → <c>UnitPrice</c>, <c>OrderLine</c> → <c>OrderLine</c>.
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

    /// <summary>
    /// Converts an identifier to <c>snake_case</c> (fields, methods, modules). Handles PascalCase,
    /// camelCase, already-snake_case inputs, and acronym runs: <c>UnitPrice</c> → <c>unit_price</c>,
    /// <c>unitPrice</c> → <c>unit_price</c>, <c>URLPath</c> → <c>url_path</c>. No leading underscore.
    /// </summary>
    public static string ToSnakeCase(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        if (IsAlreadySnakeCase(name))
        {
            return name;
        }

        var sb = new StringBuilder(name.Length + 4);
        for (var i = 0; i < name.Length; i++)
        {
            var c = name[i];
            if (c == '_')
            {
                if (sb.Length > 0 && sb[sb.Length - 1] != '_')
                {
                    sb.Append('_');
                }
                continue;
            }

            if (char.IsUpper(c))
            {
                var prevIsLower = i > 0 && char.IsLower(name[i - 1]);
                var nextIsLower = i + 1 < name.Length && char.IsLower(name[i + 1]);
                var prevIsUpper = i > 0 && char.IsUpper(name[i - 1]);
                var prevIsUnderscore = i > 0 && name[i - 1] == '_';
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

        return sb.ToString().TrimStart('_');
    }

    /// <summary>Converts an identifier to <c>SCREAMING_SNAKE_CASE</c> (associated constants).</summary>
    public static string ToScreamingSnake(string name) => ToSnakeCase(name).ToUpperInvariant();

    /// <summary>
    /// Returns a snake_case field/method/module name escaped as a Rust raw identifier (<c>r#type</c>)
    /// when it collides with a keyword, or with a trailing underscore for the few keywords that cannot
    /// be raw identifiers (<c>self</c> → <c>self_</c>). A non-keyword passes through unchanged.
    /// </summary>
    public static string EscapeMember(string snake)
    {
        if (!Keywords.Contains(snake))
        {
            return snake;
        }

        return NonRawKeywords.Contains(snake) ? snake + "_" : "r#" + snake;
    }

    /// <summary>The escaped snake_case rendering of a Koine member/parameter name.</summary>
    public static string Field(string name) => EscapeMember(ToSnakeCase(name));

    private static bool IsAlreadySnakeCase(string name)
    {
        foreach (var c in name)
        {
            if (char.IsUpper(c))
            {
                return false;
            }
        }

        return true;
    }
}
