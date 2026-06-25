using System.Text;
using Antlr4.Runtime;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Formatting;

/// <summary>The result of formatting a source: the canonical text and whether it differed from the input.</summary>
public sealed record FormatResult(string Text, bool Changed);

/// <summary>
/// A single canonical-formatting text edit over a 0-based, end-exclusive line/character range:
/// <see cref="NewText"/> replaces the source between (<see cref="StartLine"/>, <see cref="StartCharacter"/>)
/// and (<see cref="EndLine"/>, <see cref="EndCharacter"/>). Produced by <see cref="KoineFormatter.FormatRange"/>.
/// Coordinates are 0-based document line/column indices — the universal text-edit convention, not a
/// target- or protocol-specific concept — so each backend copies them straight into its own wire shape.
/// </summary>
public sealed record FormatRangeEdit(int StartLine, int StartCharacter, int EndLine, int EndCharacter, string NewText);

/// <summary>
/// Canonical formatter for <c>.koi</c> source (R17.3). It is a TOKEN-STREAM
/// reprinter, not an AST printer: it lexes the source (ordinary comments ride the
/// HIDDEN channel, doc comments the DOC channel — see <c>KoineLexer.g4</c>) and
/// re-emits the tokens with canonical whitespace. Driving off the token stream lets
/// it preserve every comment, emit string/regex literals byte-for-byte, and handle
/// every construct without duplicating the grammar.
///
/// <para><b>Canonical style:</b> 2-space indentation by brace depth; K&amp;R braces
/// (<c>{</c> stays on the declaration line, <c>}</c> on its own line); exactly one
/// space after <c>:</c> with the type columns of a contiguous run of <c>name: Type</c>
/// fields aligned; single spaces around binary operators; no space around <c>.</c>,
/// inside generics, or after <c>(</c>; runs of blank lines collapse to one (and none
/// hug a brace). Source line breaks are preserved (the formatter normalizes layout, it
/// does not reflow), which — together with re-emitting the exact token text — makes it
/// idempotent: <c>Format(Format(x)) == Format(x)</c>.</para>
///
/// <para><b>Role vs. <see cref="AstPrinter"/>:</b> this is the CANONICAL, file-level
/// pretty-printer (normalizes layout). For VERBATIM AST-level round-trip / refactors that must
/// preserve the original whitespace and comments, use <see cref="AstPrinter"/> instead (#5). Rename
/// is a third, text-level path (layout-preserving edits over the original source). The three are
/// intentionally separate; do not fold one into another.</para>
/// </summary>
public sealed class KoineFormatter
{
    private const string IndentUnit = "  ";

    // The only generic types in Koine; a '<' right after one of these opens a type
    // argument list (no surrounding spaces) rather than being a comparison operator.
    private static readonly HashSet<string> GenericTypeNames = new(StringComparer.Ordinal)
        { "List", "Set", "Map", "Range" };

    public FormatResult Format(string source)
    {
        List<IToken> tokens = Lex(source);
        var formatted = Render(tokens);
        return new FormatResult(formatted, !string.Equals(formatted, source, StringComparison.Ordinal));
    }

    /// <summary>
    /// Range formatting (LSP <c>textDocument/rangeFormatting</c>) over the requested 0-based selection.
    /// The formatter is whole-document + idempotent, so this formats the whole document, reduces the
    /// difference to its minimal changed line-region (the longest common leading/trailing run of
    /// identical lines collapsed away), and INTERSECTS that region with the selected lines — returning a
    /// single whole-line <see cref="FormatRangeEdit"/>, or <c>null</c> when the selection contains nothing
    /// that needs reformatting (including an already-canonical document). When the changed block keeps its
    /// line count (pure indentation/spacing, no blank-line collapse) the selection's lines map 1:1 onto
    /// the formatted lines and only that sub-range is emitted; otherwise the whole changed region is.
    /// <paramref name="startCharacter"/> is accepted for selection fidelity but unused — the formatter
    /// operates on whole lines; <paramref name="endCharacter"/> only distinguishes the editor's
    /// "N whole lines" gesture (a selection ending at column 0 of the next line excludes that line).
    /// </summary>
    public FormatRangeEdit? FormatRange(string source, int startLine, int startCharacter, int endLine, int endCharacter)
    {
        _ = startCharacter; // whole-line formatter: the selection's start column does not affect the edit
        var result = Format(source);
        if (!result.Changed)
        {
            return null;
        }

        var orig = SplitLines(source);
        var fmt = SplitLines(result.Text);

        // Render() terminates every line with '\n', so the formatted text ALWAYS ends in a newline
        // (a trailing empty line). A source that does NOT would otherwise differ on that last element
        // alone, forcing suffix=0 and expanding every edit to EOF. Diff against copies normalized to a
        // common trailing empty line so the content lines align; reconstruct edits against the real
        // `orig` below (so the EOF anchor stays valid and no past-EOF position is ever emitted).
        var od = orig.Length > 0 && orig[^1].Length == 0 ? orig : [.. orig, ""];
        var fd = fmt.Length > 0 && fmt[^1].Length == 0 ? fmt : [.. fmt, ""];

        // Minimal changed line-region: collapse the longest common leading/trailing run of identical lines.
        var prefix = 0;
        while (prefix < od.Length && prefix < fd.Length
            && string.Equals(od[prefix], fd[prefix], StringComparison.Ordinal))
        {
            prefix++;
        }

        var suffix = 0;
        while (suffix < od.Length - prefix && suffix < fd.Length - prefix
            && string.Equals(od[^(suffix + 1)], fd[^(suffix + 1)], StringComparison.Ordinal))
        {
            suffix++;
        }

        var changedStart = prefix;                  // inclusive original-line index
        var changedEnd = od.Length - suffix;        // exclusive original-line index
        var fmtStart = prefix;
        var fmtEnd = fd.Length - suffix;

        // The selection as an inclusive [first, last] line span. A selection ending at column 0 of a
        // later line (the "select N whole lines" gesture) does not include that trailing line.
        var first = Math.Max(0, startLine);
        var last = endCharacter == 0 && endLine > startLine ? endLine - 1 : endLine;
        last = Math.Min(last, orig.Length - 1);

        // Intersect the changed region with the selection ([first, last] inclusive → [first, last+1) exclusive).
        var lo = Math.Max(changedStart, first);
        var hi = Math.Min(changedEnd, last + 1);
        if (lo >= hi)
        {
            return null; // the selection touches nothing that needs reformatting
        }

        int editStart, editEnd, fmtFrom, fmtTo;
        if (changedEnd - changedStart == fmtEnd - fmtStart)
        {
            // Equal line counts → 1:1 correspondence, so clip precisely to the selected sub-range.
            editStart = lo;
            editEnd = hi;
            fmtFrom = fmtStart + (lo - changedStart);
            fmtTo = fmtStart + (hi - changedStart);
        }
        else
        {
            // Line count changed within the block → intra-block correspondence is ambiguous; emit the
            // whole minimal changed region (still gated on the selection intersecting it).
            editStart = changedStart;
            editEnd = changedEnd;
            fmtFrom = fmtStart;
            fmtTo = fmtEnd;
        }

        // The trailing "" added to `fd` for diffing is always part of the common suffix (suffix >= 1),
        // so [fmtFrom, fmtTo) never reaches it — the replacement carries only real formatted lines.
        var replacement = string.Join("\n", fd[fmtFrom..fmtTo]);

        // Whole-line replacement of original lines [editStart, editEnd). The span runs from the start of
        // line editStart to the start of line editEnd, so the replacement carries a trailing newline.
        // When editEnd reaches the real last line (a source with no trailing newline), there is no
        // following newline to consume, so anchor the end at that line's end and drop the trailing one.
        if (editEnd < orig.Length)
        {
            return new FormatRangeEdit(editStart, 0, editEnd, 0, replacement + "\n");
        }

        var lastLine = orig.Length - 1;
        return new FormatRangeEdit(editStart, 0, lastLine, orig[lastLine].Length, replacement);
    }

    /// <summary>Splits text into lines on CRLF/CR/LF (mirrors the LSP/WASM backends' own SplitLines).</summary>
    private static string[] SplitLines(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');

    private static List<IToken> Lex(string source)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();   // never throw on malformed input — format best-effort
        // Drop EOF and whitespace: the formatter computes its own canonical whitespace from token
        // geometry (lines/columns), so it must not see the raw WS tokens. WS now rides the TRIVIA
        // channel (for lossless AST trivia, #5) instead of being lexer-`skip`ped, so it would
        // otherwise appear in GetAllTokens(); comments stay (HIDDEN/DOC) so they are preserved.
        return lexer.GetAllTokens()
            .Where(t => t.Type != TokenConstants.EOF && t.Channel != KoineLexer.TRIVIA)
            .ToList();
    }

    // ---- A rendered logical line --------------------------------------------

    private sealed record Line(int IndentDepth, bool IsBlank, bool IsField, string FieldName, string Body);

    private static string Render(IReadOnlyList<IToken> tokens)
    {
        List<List<IToken>> groups = GroupByLine(tokens);
        var lines = new List<Line>();

        var depth = 0;
        var prevEndLine = -1;
        var prevLastType = -1;

        foreach (List<IToken> group in groups)
        {
            var startLine = group[0].Line;

            // Blank-line policy: collapse 2+ to one; never hug an opening or closing brace.
            if (prevEndLine >= 0)
            {
                var hadBlank = startLine - prevEndLine - 1 > 0;
                var prevOpened = prevLastType == KoineLexer.LBRACE;
                var curCloses = group[0].Type == KoineLexer.RBRACE;
                if (hadBlank && !prevOpened && !curCloses)
                {
                    lines.Add(new Line(0, IsBlank: true, IsField: false, "", ""));
                }
            }

            var leadingClose = 0;
            while (leadingClose < group.Count && group[leadingClose].Type == KoineLexer.RBRACE)
            {
                leadingClose++;
            }

            var indentDepth = Math.Max(0, depth - leadingClose);

            if (IsFieldLine(group))
            {
                var name = group[0].Text;
                var body = RenderTokens(group.Skip(2)); // tokens after `name :`
                lines.Add(new Line(indentDepth, IsBlank: false, IsField: true, name, body));
            }
            else
            {
                lines.Add(new Line(indentDepth, IsBlank: false, IsField: false, "", RenderTokens(group)));
            }

            var opens = group.Count(t => t.Type == KoineLexer.LBRACE);
            var closes = group.Count(t => t.Type == KoineLexer.RBRACE);
            depth = Math.Max(0, depth + opens - closes);

            prevEndLine = group.Max(EndLineOf);
            prevLastType = group[^1].Type;
        }

        return Emit(lines);
    }

    /// <summary>Groups tokens into source lines (a token's start line). Trailing comments stay on their line.</summary>
    private static List<List<IToken>> GroupByLine(IReadOnlyList<IToken> tokens)
    {
        var groups = new List<List<IToken>>();
        var currentLine = -1;
        foreach (IToken t in tokens)
        {
            if (t.Line != currentLine)
            {
                groups.Add(new List<IToken>());
                currentLine = t.Line;
            }
            groups[^1].Add(t);
        }
        return groups;
    }

    /// <summary>
    /// A <c>name : type …</c> member line, eligible for <c>:</c>-column alignment. The
    /// name may be a soft keyword (the grammar's <c>softName</c> admits e.g. <c>quantity</c>,
    /// <c>from</c>, <c>by</c> as member names), so we test for a word-like first token rather
    /// than only <c>Identifier</c>.
    /// </summary>
    private static bool IsFieldLine(List<IToken> group) =>
        group.Count >= 2
        && group[1].Type == KoineLexer.COLON
        && IsWordStart(group[0].Text);

    private static bool IsWordStart(string? s) =>
        !string.IsNullOrEmpty(s) && (char.IsLetter(s[0]) || s[0] == '_');

    private static int EndLineOf(IToken t) => Parsing.TokenGeometry.EndLineOf(t);

    /// <summary>Renders a token run with canonical inter-token spacing (no leading indent).</summary>
    private static string RenderTokens(IEnumerable<IToken> tokens)
    {
        var sb = new StringBuilder();
        IToken? prev = null;
        var genericDepth = 0;

        foreach (IToken t in tokens)
        {
            if (prev is not null && NeedsSpace(prev, t, genericDepth))
            {
                sb.Append(' ');
            }

            // Track generic nesting so '<'/'>' inside a type argument list stay tight
            // and don't get operator spacing.
            if (t.Type == KoineLexer.LT && IsGenericOpen(prev))
            {
                genericDepth++;
            }
            else if (t.Type == KoineLexer.GT && genericDepth > 0)
            {
                genericDepth--;
            }

            sb.Append(t.Text);
            prev = t;
        }
        return sb.ToString();
    }

    private static bool IsGenericOpen(IToken? prev) =>
        prev is not null && GenericTypeNames.Contains(prev.Text);

    /// <summary>Whether a space goes between <paramref name="prev"/> and <paramref name="cur"/>.</summary>
    private static bool NeedsSpace(IToken prev, IToken cur, int genericDepth)
    {
        int p = prev.Type, c = cur.Type;

        // Punctuation that glues to the preceding token.
        if (c is KoineLexer.COMMA or KoineLexer.COLON or KoineLexer.QUESTION or KoineLexer.RPAREN)
        {
            return false;
        }

        // Member access / qualified names: no space either side of '.'.
        if (c == KoineLexer.DOT || p == KoineLexer.DOT)
        {
            return false;
        }

        if (p == KoineLexer.LPAREN)
        {
            return false;   // no space just inside '('
        }

        if (p == KoineLexer.AT)
        {
            return false;        // @annotation glued to its name
        }

        if (p == KoineLexer.NOT)
        {
            return false;       // unary ! glued to its operand
        }

        // Generic type argument lists: List<OrderLine>, Map<K, V>.
        if (c == KoineLexer.LT && IsGenericOpen(prev))
        {
            return false;  // before the opening '<'
        }

        if (p == KoineLexer.LT && genericDepth > 0)
        {
            return false;     // after an opening generic '<'
        }

        if (c == KoineLexer.GT && genericDepth > 0)
        {
            return false;     // before a closing generic '>'
        }

        // Call / construction parentheses glue to the callee (foo(...), Currency("€", 2)).
        if (c == KoineLexer.LPAREN && (p == KoineLexer.Identifier || p == KoineLexer.RPAREN || p == KoineLexer.GT))
        {
            return false;
        }

        return true;
    }

    /// <summary>Assembles the final text: aligns field groups, applies indentation, one trailing newline.</summary>
    private static string Emit(List<Line> lines)
    {
        var rendered = new List<string>(lines.Count);

        for (var i = 0; i < lines.Count; i++)
        {
            Line line = lines[i];
            if (line.IsBlank)
            {
                rendered.Add("");
                continue;
            }

            if (!line.IsField)
            {
                rendered.Add(Indent(line.IndentDepth) + line.Body);
                continue;
            }

            // A field is part of a contiguous alignment group: consecutive field lines at
            // the same depth, unbroken by a blank, comment, or any non-field line. Pad the
            // `name:` so every type in the group starts at the same column.
            var groupMax = line.FieldName.Length;
            for (var j = i + 1; j < lines.Count; j++)
            {
                if (!lines[j].IsField || lines[j].IndentDepth != line.IndentDepth)
                {
                    break;
                }

                groupMax = Math.Max(groupMax, lines[j].FieldName.Length);
            }
            // Re-scan backwards too, so every member of the group shares one width.
            for (var j = i - 1; j >= 0; j--)
            {
                if (!lines[j].IsField || lines[j].IndentDepth != line.IndentDepth)
                {
                    break;
                }

                groupMax = Math.Max(groupMax, lines[j].FieldName.Length);
            }

            var head = (line.FieldName + ":").PadRight(groupMax + 2);
            rendered.Add(Indent(line.IndentDepth) + head + line.Body);
        }

        var sb = new StringBuilder();
        foreach (var r in rendered)
        {
            sb.Append(r.TrimEnd()).Append('\n');
        }

        return sb.ToString();
    }

    private static string Indent(int depth) => string.Concat(Enumerable.Repeat(IndentUnit, depth));
}
