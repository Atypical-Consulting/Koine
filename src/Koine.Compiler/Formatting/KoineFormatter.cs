using System.Text;
using Antlr4.Runtime;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Formatting;

/// <summary>The result of formatting a source: the canonical text and whether it differed from the input.</summary>
public sealed record FormatResult(string Text, bool Changed);

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
        var tokens = Lex(source);
        var formatted = Render(tokens);
        return new FormatResult(formatted, !string.Equals(formatted, source, StringComparison.Ordinal));
    }

    private static List<IToken> Lex(string source)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();   // never throw on malformed input — format best-effort
        return lexer.GetAllTokens().Where(t => t.Type != TokenConstants.EOF).ToList();
    }

    // ---- A rendered logical line --------------------------------------------

    private sealed record Line(int IndentDepth, bool IsBlank, bool IsField, string FieldName, string Body);

    private static string Render(IReadOnlyList<IToken> tokens)
    {
        var groups = GroupByLine(tokens);
        var lines = new List<Line>();

        var depth = 0;
        var prevEndLine = -1;
        var prevLastType = -1;

        foreach (var group in groups)
        {
            var startLine = group[0].Line;

            // Blank-line policy: collapse 2+ to one; never hug an opening or closing brace.
            if (prevEndLine >= 0)
            {
                var hadBlank = startLine - prevEndLine - 1 > 0;
                var prevOpened = prevLastType == KoineLexer.LBRACE;
                var curCloses = group[0].Type == KoineLexer.RBRACE;
                if (hadBlank && !prevOpened && !curCloses)
                    lines.Add(new Line(0, IsBlank: true, IsField: false, "", ""));
            }

            var leadingClose = 0;
            while (leadingClose < group.Count && group[leadingClose].Type == KoineLexer.RBRACE)
                leadingClose++;
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
        foreach (var t in tokens)
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

    private static int EndLineOf(IToken t)
    {
        var text = t.Text;
        if (text is null) return t.Line;
        var newlines = 0;
        foreach (var c in text)
            if (c == '\n') newlines++;
        return t.Line + newlines;
    }

    /// <summary>Renders a token run with canonical inter-token spacing (no leading indent).</summary>
    private static string RenderTokens(IEnumerable<IToken> tokens)
    {
        var sb = new StringBuilder();
        IToken? prev = null;
        var genericDepth = 0;

        foreach (var t in tokens)
        {
            if (prev is not null && NeedsSpace(prev, t, genericDepth))
                sb.Append(' ');

            // Track generic nesting so '<'/'>' inside a type argument list stay tight
            // and don't get operator spacing.
            if (t.Type == KoineLexer.LT && IsGenericOpen(prev))
                genericDepth++;
            else if (t.Type == KoineLexer.GT && genericDepth > 0)
                genericDepth--;

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
            return false;

        // Member access / qualified names: no space either side of '.'.
        if (c == KoineLexer.DOT || p == KoineLexer.DOT)
            return false;

        if (p == KoineLexer.LPAREN) return false;   // no space just inside '('
        if (p == KoineLexer.AT) return false;        // @annotation glued to its name
        if (p == KoineLexer.NOT) return false;       // unary ! glued to its operand

        // Generic type argument lists: List<OrderLine>, Map<K, V>.
        if (c == KoineLexer.LT && IsGenericOpen(prev)) return false;  // before the opening '<'
        if (p == KoineLexer.LT && genericDepth > 0) return false;     // after an opening generic '<'
        if (c == KoineLexer.GT && genericDepth > 0) return false;     // before a closing generic '>'

        // Call / construction parentheses glue to the callee (foo(...), Currency("€", 2)).
        if (c == KoineLexer.LPAREN && (p == KoineLexer.Identifier || p == KoineLexer.RPAREN || p == KoineLexer.GT))
            return false;

        return true;
    }

    /// <summary>Assembles the final text: aligns field groups, applies indentation, one trailing newline.</summary>
    private static string Emit(List<Line> lines)
    {
        var rendered = new List<string>(lines.Count);

        for (var i = 0; i < lines.Count; i++)
        {
            var line = lines[i];
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
                if (!lines[j].IsField || lines[j].IndentDepth != line.IndentDepth) break;
                groupMax = Math.Max(groupMax, lines[j].FieldName.Length);
            }
            // Re-scan backwards too, so every member of the group shares one width.
            for (var j = i - 1; j >= 0; j--)
            {
                if (!lines[j].IsField || lines[j].IndentDepth != line.IndentDepth) break;
                groupMax = Math.Max(groupMax, lines[j].FieldName.Length);
            }

            var head = (line.FieldName + ":").PadRight(groupMax + 2);
            rendered.Add(Indent(line.IndentDepth) + head + line.Body);
        }

        var sb = new StringBuilder();
        foreach (var r in rendered)
            sb.Append(r.TrimEnd()).Append('\n');
        return sb.ToString();
    }

    private static string Indent(int depth) => string.Concat(Enumerable.Repeat(IndentUnit, depth));
}
