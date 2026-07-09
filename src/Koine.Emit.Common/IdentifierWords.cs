namespace Koine.Compiler;

/// <summary>
/// The shared word-boundary splitter (#1239) behind every emit-target casing helper that needs to
/// decompose a PascalCase/camelCase/mixed identifier into its constituent words —
/// <see cref="RouteDerivation.Kebab"/> and the per-language <c>ToSnakeCase</c> helpers
/// (<c>RustNaming</c>, <c>PythonNaming</c>, <c>PhpNaming</c>) all independently coded the same
/// boundary rule before this extraction; this is now the one place it lives.
/// </summary>
public static class IdentifierWords
{
    /// <summary>
    /// Splits <paramref name="name"/> into its constituent words, in order, preserving each word's
    /// original casing (callers lowercase/uppercase and join with their own separator). A new word
    /// starts before an uppercase letter that either follows a lowercase letter/digit
    /// (<c>unitP</c>rice → <c>unit</c> | <c>Price</c>) or that ends a run of uppercase letters
    /// immediately followed by a lowercase one — an acronym boundary
    /// (<c>XMLI</c>mport → <c>XML</c> | <c>Import</c>). Non-letter characters (digits, underscores,
    /// …) are never boundaries themselves; they stay attached to whichever word they trail.
    /// </summary>
    public static IReadOnlyList<string> Split(string name)
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

            var afterWord = char.IsAsciiLetterLower(name[i - 1]) || char.IsAsciiDigit(name[i - 1]);
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
}
