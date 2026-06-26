namespace Koine.Compiler.Services;

/// <summary>
/// Source-text geometry shared across the code-action / refactoring services: mapping a 0-based
/// absolute character offset to a 1-based <c>(line, column)</c>, and the identifier-boundary
/// predicates that keep a name match from landing on a substring. These were independently re-rolled
/// — byte-identically — in <see cref="RefactorService"/>, <see cref="KoineLanguageService"/>, and the
/// rename quick fix; a single definition keeps a future change to one from silently desyncing the
/// others.
/// </summary>
internal static class SourceTextGeometry
{
    /// <summary>
    /// The 1-based <c>(line, column)</c> of the 0-based absolute character <paramref name="offset"/>
    /// in <paramref name="text"/>. An out-of-range offset clamps to the end of the text.
    /// </summary>
    public static (int Line, int Column) LineColumn(string text, int offset)
    {
        var line = 1;
        var column = 1;
        var end = Math.Min(offset, text.Length);
        for (var i = 0; i < end; i++)
        {
            if (text[i] == '\n')
            {
                line++;
                column = 1;
            }
            else
            {
                column++;
            }
        }

        return (line, column);
    }

    /// <summary>
    /// True when the <paramref name="length"/>-character occurrence at <paramref name="at"/> in
    /// <paramref name="text"/> is a whole identifier — not bordered by another identifier character on
    /// either side — so a substring (<c>Money</c> inside <c>MoneyBag</c>) never matches.
    /// </summary>
    public static bool IsWholeWordAt(string text, int at, int length)
    {
        if (at > 0 && IsIdentifierChar(text[at - 1]))
        {
            return false;
        }

        var afterIndex = at + length;
        return afterIndex >= text.Length || !IsIdentifierChar(text[afterIndex]);
    }

    /// <summary>True when <paramref name="c"/> can appear inside an identifier (<c>[A-Za-z0-9_]</c>).</summary>
    public static bool IsIdentifierChar(char c) => char.IsLetterOrDigit(c) || c == '_';
}
