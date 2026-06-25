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
    /// The Rust enum-variant name for a Koine enum member: <c>UpperCamelCase</c>, normalizing an
    /// all-caps acronym member to title case so the variant is lint-clean (<c>EUR</c> → <c>Eur</c>,
    /// <c>Draft</c> → <c>Draft</c>, <c>ORDER_PLACED</c> → <c>OrderPlaced</c>).
    /// </summary>
    public static string Variant(string name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return name;
        }

        var hasLower = name.Any(char.IsLower);
        var hasUnderscore = name.Contains('_');
        if (!hasLower && !hasUnderscore)
        {
            return char.ToUpperInvariant(name[0]) + name[1..].ToLowerInvariant();
        }

        return ToPascalCase(name);
    }

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

    /// <summary>
    /// Chooses the name of the Rust emitter's synthetic domain-event collector field, guaranteed not to
    /// collide with any of <paramref name="usedNames"/> (the entity's user field/accessor/command/factory
    /// names). Prefers the idiomatic <c>events</c>; when a user member occupies it, falls back to
    /// <c>domain_events</c>, then numbered suffixes. The drain accessor (<c>drain_&lt;name&gt;</c>) is kept
    /// collision-free too, so both the field and its accessors stay unique. Routing every synthetic-field
    /// reference through this keeps the C#-safe model (<c>events</c> never collides with C#'s
    /// <c>_domainEvents</c>) compiling for Rust as well, without leaking the concern out of the emitter.
    /// </summary>
    public static string SyntheticEventsField(IEnumerable<string> usedNames)
    {
        var used = new HashSet<string>(usedNames, StringComparer.Ordinal);
        if (IsFree("events", used))
        {
            return "events";
        }

        if (IsFree("domain_events", used))
        {
            return "domain_events";
        }

        for (var i = 2; ; i++)
        {
            var candidate = "domain_events_" + i;
            if (IsFree(candidate, used))
            {
                return candidate;
            }
        }
    }

    /// <summary>A synthetic field name is free when neither it nor its <c>drain_</c> accessor collides.</summary>
    private static bool IsFree(string name, HashSet<string> used) =>
        !used.Contains(name) && !used.Contains("drain_" + name);

    /// <summary>
    /// The name of a factory's event-collector <em>local</em> (<c>let &lt;name&gt;: Vec&lt;DomainEvent&gt; = …</c>),
    /// guaranteed not to shadow any of that factory's <paramref name="parameterFieldNames"/>. The
    /// entity-wide synthetic field name <paramref name="eventsField"/> (from <see cref="SyntheticEventsField"/>)
    /// is reused verbatim — keeping the struct field, accessor, and <c>drain_</c> names unchanged — unless a
    /// parameter snake_cases to the same identifier, in which case the binding would shadow that parameter
    /// for the rest of the factory body (so a later <c>Self::new(…)</c> / field assignment would read the
    /// <c>Vec</c> local instead of the parameter). Only then is it disambiguated with a numbered suffix.
    /// The public field keeps <paramref name="eventsField"/>; this is purely the local it is assigned from.
    /// </summary>
    public static string FactoryEventsLocal(string eventsField, IEnumerable<string> parameterFieldNames)
    {
        var used = new HashSet<string>(parameterFieldNames, StringComparer.Ordinal);
        if (!used.Contains(eventsField))
        {
            return eventsField;
        }

        for (var i = 2; ; i++)
        {
            var candidate = eventsField + "_" + i;
            if (!used.Contains(candidate))
            {
                return candidate;
            }
        }
    }

    /// <summary>
    /// Maps an enum's members (in declaration order) to DISTINCT Rust binding names for the
    /// smart-enum <c>match_</c>/<c>switch</c> closure parameters. Each binding is the member's
    /// <see cref="Field"/> form; when two members collapse to the same snake_case identifier —
    /// e.g. <c>userID</c> and <c>userId</c> both snake_case to <c>user_id</c> — the later ones get a
    /// deterministic <c>_2</c>, <c>_3</c>, … suffix so every binding is a distinct, compiling Rust
    /// identifier (a bare <c>match</c> over them would otherwise bind the same name twice — invalid
    /// Rust). The first occurrence keeps the idiomatic un-suffixed name, so non-colliding enums are
    /// byte-for-byte unchanged, and the suffix loop keeps incrementing past any member whose natural
    /// snake_case already equals a disambiguated name. Suffixing happens on the pre-escape snake form
    /// so the result stays keyword-safe (it is re-escaped via <see cref="EscapeMember"/>).
    /// </summary>
    public static IReadOnlyList<string> UniqueBindings(IEnumerable<string> memberNames)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        var bindings = new List<string>();
        foreach (var name in memberNames)
        {
            // Disambiguate on the pre-escape snake form (a `_2` suffix) so the re-escaped result stays
            // keyword-safe.
            bindings.Add(Disambiguate(used, ToSnakeCase(name), "_", EscapeMember));
        }

        return bindings;
    }

    /// <summary>
    /// Maps an enum's members (in declaration order) to DISTINCT Rust enum-variant names. Each variant
    /// is the member's <see cref="Variant"/> form; when two members collapse to the same variant — e.g.
    /// <c>EUR</c> and <c>Eur</c> both fold to <c>Eur</c> — the later ones get a deterministic <c>2</c>,
    /// <c>3</c>, … suffix (<c>Eur</c>, <c>Eur2</c>) so every variant is a distinct, compiling Rust
    /// identifier (two identical variants are an <c>E0428</c> duplicate definition). The first occurrence
    /// keeps the idiomatic un-suffixed name, so non-colliding enums are byte-for-byte unchanged, and the
    /// suffix loop keeps incrementing past any member whose natural variant already equals a disambiguated
    /// name (a member literally named <c>Eur2</c>). The suffix omits the underscore that
    /// <see cref="UniqueBindings"/> uses so the result stays <c>PascalCase</c>-idiomatic; variants are
    /// never keywords-as-raw-identifiers, so no <see cref="EscapeMember"/> step is needed (#323).
    /// </summary>
    public static IReadOnlyList<string> UniqueVariants(IEnumerable<string> memberNames)
    {
        var used = new HashSet<string>(StringComparer.Ordinal);
        var variants = new List<string>();
        foreach (var name in memberNames)
        {
            variants.Add(Disambiguate(used, Variant(name), separator: string.Empty));
        }

        return variants;
    }

    /// <summary>
    /// Renders <paramref name="baseName"/> (through <paramref name="escape"/>) into a name not already in
    /// <paramref name="used"/>, appending a <c><paramref name="separator"/>2</c>, <c>…3</c>, … suffix to
    /// the pre-escape base until the escaped candidate is free, then records it. Shared by
    /// <see cref="UniqueBindings"/> (snake_case, <c>_</c>-separated, keyword-escaped) and
    /// <see cref="UniqueVariants"/> (PascalCase, no separator, identity escape).
    /// </summary>
    private static string Disambiguate(
        HashSet<string> used,
        string baseName,
        string separator,
        Func<string, string>? escape = null)
    {
        escape ??= static s => s;
        var candidate = escape(baseName);
        for (var n = 2; !used.Add(candidate); n++)
        {
            candidate = escape(baseName + separator + n);
        }

        return candidate;
    }

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
