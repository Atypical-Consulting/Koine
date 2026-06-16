using Antlr4.Runtime;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Parsing;

/// <summary>
/// Shared geometry math over ANTLR tokens: counting the newlines a (possibly multi-line)
/// token spans, and turning a token's start/stop into a full <see cref="SourceSpan"/>
/// (1-based start, 1-based end-EXCLUSIVE, 0-based offset + length).
///
/// <para>A token such as a block comment or a multi-line string occupies several source
/// lines; its end line is its start line plus the newline count in its text, and its end
/// column is measured against the LAST line of the text. The single owner of this math so
/// the parser (node spans) and the formatter (blank-line policy) never disagree.</para>
/// </summary>
public static class TokenGeometry
{
    /// <summary>The number of <c>\n</c> characters in a token's text (0 for a single-line token).</summary>
    public static int NewlineCount(string? text)
    {
        if (text is null)
        {
            return 0;
        }

        var count = 0;
        foreach (var c in text)
        {
            if (c == '\n')
            {
                count++;
            }
        }

        return count;
    }

    /// <summary>The 1-based line just at the end of a token (its start line plus its newline count).</summary>
    public static int EndLineOf(IToken token) => token.Line + NewlineCount(token.Text);

    /// <summary>
    /// The full <see cref="SourceSpan"/> from a start token through a (possibly multi-line) stop
    /// token. ANTLR <c>Column</c> is 0-based, so the 1-based start column is <c>Start.Column + 1</c>.
    /// The end column is end-EXCLUSIVE: for a single-line stop token it is
    /// <c>Stop.Column + 1 + stopLength</c>; for a multi-line stop token it is measured from the
    /// start of the last line of the stop token's text.
    /// </summary>
    public static SourceSpan SpanOf(IToken start, IToken stop, string? file)
    {
        var startLine = start.Line;
        var startColumn = start.Column + 1; // ANTLR Column is 0-based; SourceSpan is 1-based.

        var stopText = stop.Text ?? string.Empty;
        var newlines = NewlineCount(stopText);
        var endLine = stop.Line + newlines;

        int endColumn;
        if (newlines == 0)
        {
            // Single-line stop token: end column is one past its last character.
            endColumn = stop.Column + 1 + stopText.Length;
        }
        else
        {
            // Multi-line stop token: end column is the length of the text after the last newline,
            // 1-based exclusive => lastLineLength + 1.
            var lastNewline = stopText.LastIndexOf('\n');
            var lastLineLength = stopText.Length - lastNewline - 1;
            endColumn = lastLineLength + 1;
        }

        var offset = start.StartIndex;
        var length = stop.StopIndex - start.StartIndex + 1;
        if (length < 0)
        {
            length = 0;
        }

        return new SourceSpan(startLine, startColumn, endLine, endColumn, offset, length, file);
    }

    /// <summary>The full <see cref="SourceSpan"/> of a single token (used for identifier name spans).</summary>
    public static SourceSpan SpanOf(IToken token, string? file) => SpanOf(token, token, file);
}
