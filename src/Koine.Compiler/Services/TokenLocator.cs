using Antlr4.Runtime;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Services;

/// <summary>
/// Lexer-only "what is under the cursor" engine shared by every IntelliSense
/// feature. It reuses the real <see cref="KoineLexer"/> (so the <c>matches</c>
/// regex mode switch is reproduced for free) and never depends on a successful
/// parse, so completion keeps working on syntactically-broken documents.
/// </summary>
internal sealed record TokenContext(
    IToken? PrecedingToken,
    IToken? TokenBeforePreceding,
    IToken? CurrentToken,
    string Partial,
    string? EnclosingKeyword,
    bool InsideStringOrRegex);

internal static class TokenLocator
{
    // Keywords that introduce a `{ }` block, used to label the enclosing scope.
    private static readonly HashSet<string> BlockKeywords = new(StringComparer.Ordinal)
    {
        "context", "value", "quantity", "entity", "aggregate", "enum", "event",
        "spec", "service", "policy", "repository", "states",
    };

    /// <summary>
    /// Locates the token context at an LSP 0-based <paramref name="line"/>/<paramref name="character"/>.
    /// Never throws: lexer error listeners are removed and malformed input yields a
    /// context with null tokens.
    /// </summary>
    public static TokenContext Locate(string source, int line, int character)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();
        var stream = new CommonTokenStream(lexer);
        stream.Fill();
        var tokens = stream.GetTokens();

        int targetLine = line + 1;     // ANTLR Line is 1-based
        int targetCol = character;     // ANTLR Column is 0-based, == LSP character

        var def = new List<IToken>();
        bool insideStringOrRegex = false;

        foreach (var t in tokens)
        {
            if (t.Type == TokenConstants.EOF)
                continue;

            if (t.Channel != TokenConstants.DefaultChannel)
            {
                // Off-channel tokens are `///` doc comments. They are intentionally
                // treated as not-code: a cursor inside a doc comment sets
                // insideStringOrRegex so completion is suppressed there too, per spec.
                // (Don't "fix" this branch — suppression inside doc comments is desired.)
                if (Contains(t, targetLine, targetCol))
                    insideStringOrRegex = true;
                continue;
            }

            def.Add(t);

            if ((t.Type == KoineLexer.StringLiteral || t.Type == KoineLexer.Regex)
                && Contains(t, targetLine, targetCol))
                insideStringOrRegex = true;
        }

        IToken? current = null;
        foreach (var t in def)
        {
            if (IsWord(t) && Contains(t, targetLine, targetCol))
            {
                current = t;
                break;
            }
        }

        int boundaryLine = current?.Line ?? targetLine;
        int boundaryCol = current?.Column ?? targetCol;
        IToken? preceding = null;
        foreach (var t in def)
        {
            if (ReferenceEquals(t, current))
                continue;
            if (EndsAtOrBefore(t, boundaryLine, boundaryCol))
                preceding = t;
        }

        IToken? beforePreceding = null;
        if (preceding is not null)
        {
            foreach (var t in def)
            {
                if (ReferenceEquals(t, preceding)) break;
                if (EndsAtOrBefore(t, preceding.Line, preceding.Column))
                    beforePreceding = t;
            }
        }

        string partial = current is null
            ? ""
            : current.Text.Substring(0, Math.Clamp(targetCol - current.Column, 0, current.Text.Length));

        return new TokenContext(preceding, beforePreceding, current, partial,
            EnclosingKeyword(def, targetLine, targetCol), insideStringOrRegex);
    }

    private static bool IsWord(IToken t)
    {
        if (t.Type == KoineLexer.Identifier) return true;
        var s = t.Text;
        return s.Length > 0 && (char.IsLetter(s[0]) || s[0] == '_');
    }

    /// <summary>True when the cursor sits within <c>(start, end]</c> of the token on its line.</summary>
    private static bool Contains(IToken t, int line, int col)
    {
        if (t.Line != line) return false;
        int start = t.Column;
        int end = start + (t.Text?.Length ?? 0);
        return col > start && col <= end;
    }

    private static bool EndsAtOrBefore(IToken t, int line, int col)
    {
        if (t.Line < line) return true;
        if (t.Line > line) return false;
        return t.Column + (t.Text?.Length ?? 0) <= col;
    }

    private static bool Before(IToken t, int line, int col) =>
        t.Line < line || (t.Line == line && t.Column < col);

    /// <summary>
    /// The keyword of the innermost <c>{ }</c> block enclosing the cursor (e.g.
    /// <c>service</c>, <c>entity</c>), or <c>null</c> at file scope. A forward scan
    /// pushes the most recent block keyword on each <c>{</c> and pops on <c>}</c>.
    /// </summary>
    private static string? EnclosingKeyword(List<IToken> def, int line, int col)
    {
        var stack = new Stack<string>();
        string? pending = null;
        foreach (var t in def)
        {
            if (!Before(t, line, col))
                break;
            if (t.Type == KoineLexer.LBRACE)
            {
                stack.Push(pending ?? "");
                pending = null;
            }
            else if (t.Type == KoineLexer.RBRACE)
            {
                if (stack.Count > 0) stack.Pop();
                pending = null;
            }
            else if (BlockKeywords.Contains(t.Text))
            {
                pending = t.Text;
            }
        }
        if (stack.Count == 0) return null;
        var top = stack.Peek();
        return top.Length == 0 ? null : top;
    }
}
