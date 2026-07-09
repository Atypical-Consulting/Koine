using System.Text;

namespace Koine.Compiler;

/// <summary>
/// The shared word-boundary splitter (#1239) behind every emit-target casing helper that needs to
/// decompose a PascalCase/camelCase/mixed identifier into its constituent words —
/// <see cref="RouteDerivation.Kebab"/> and the per-language <c>ToSnakeCase</c> helpers
/// (<c>RustNaming</c>, <c>PythonNaming</c>, <c>PhpNaming</c>) all independently coded the same
/// boundary rule before this extraction; this is now the one place it lives.
/// Operates on ASCII letters only (<see cref="char.IsAsciiLetterUpper(char)"/> /
/// <see cref="char.IsAsciiLetterLower(char)"/>), matching the Koine grammar's identifier rule
/// (<c>[a-zA-Z_][a-zA-Z0-9_]*</c> — <c>src/Koine.Compiler/Grammar/KoineLexer.g4</c>): a non-ASCII
/// letter is never treated as a word-boundary trigger. Every real <c>.koi</c>-sourced name is
/// therefore unaffected; the one caller that can see non-ASCII text is a free-text
/// <c>koine.config</c> namespace-map key fed to <c>RustNaming</c>/<c>PythonNaming.ToSnakeCase</c>,
/// which can never match a (grammar-enforced ASCII) real context name anyway.
/// </summary>
public static class IdentifierWords
{
    /// <summary>
    /// Splits <paramref name="name"/> into its constituent words, in order, preserving each word's
    /// original casing (callers lowercase/uppercase and join with their own separator). A new word
    /// starts before an uppercase letter that either follows a lowercase letter
    /// (<c>unitP</c>rice → <c>unit</c> | <c>Price</c>), ends a run of uppercase letters immediately
    /// followed by a lowercase one — an acronym boundary (<c>XMLI</c>mport → <c>XML</c> |
    /// <c>Import</c>) — or, when <paramref name="splitAfterDigit"/> is <see langword="true"/>, follows
    /// a digit (<c>V2I</c>mport → <c>V2</c> | <c>Import</c>). <paramref name="splitAfterDigit"/> is
    /// explicit rather than defaulted because the four pre-extraction implementations genuinely
    /// disagreed on it: <see cref="RouteDerivation.Kebab"/> always split after a digit; the per-language
    /// <c>ToSnakeCase</c> helpers never did — see #1239's discovery of that divergence. Non-letter
    /// characters (underscores, …) other than a boundary-eligible digit are never boundaries
    /// themselves; they stay attached to whichever word they trail.
    /// </summary>
    public static IReadOnlyList<string> Split(string name, bool splitAfterDigit)
    {
        var words = new List<string>();
        var start = 0;
        for (var i = 1; i < name.Length; i++)
        {
            var c = name[i];
            if (!char.IsAsciiLetterUpper(c))
            {
                continue;
            }

            var afterWord = char.IsAsciiLetterLower(name[i - 1])
                || (splitAfterDigit && char.IsAsciiDigit(name[i - 1]));
            var acronymEnd = char.IsAsciiLetterUpper(name[i - 1])
                && i + 1 < name.Length && char.IsAsciiLetterLower(name[i + 1]);
            if (afterWord || acronymEnd)
            {
                words.Add(name[start..i]);
                start = i;
            }
        }

        words.Add(name[start..]);
        return words;
    }

    /// <summary>
    /// Collapses any run of consecutive <paramref name="separator"/> characters already present in
    /// <paramref name="value"/> down to one. Internal normalization shared by the per-language
    /// <c>ToSnakeCase</c> wrappers (Rust/Python/Php) for input that already contains separator
    /// characters (e.g. a partially snake_cased name) — separator-specific, not part of the public
    /// word-splitting contract, so it isn't declared in <c>PublicAPI.Unshipped.txt</c> (#1239 code
    /// review: this used to be copy-pasted identically into all three language projects).
    /// </summary>
    internal static string CollapseSeparatorRuns(string value, char separator)
    {
        var sb = new StringBuilder(value.Length);
        foreach (var c in value)
        {
            if (c == separator && sb.Length > 0 && sb[sb.Length - 1] == separator)
            {
                continue;
            }

            sb.Append(c);
        }

        return sb.ToString();
    }
}
