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
    string? EnclosingTypeName,
    bool InsideStringOrRegex);

internal static class TokenLocator
{
    // Keywords that introduce a `{ }` block, used to label the enclosing scope.
    private static readonly HashSet<string> BlockKeywords = new(StringComparer.Ordinal)
    {
        "context", "module", "value", "quantity", "entity", "aggregate", "enum", "event",
        "spec", "service", "policy", "repository", "states", "readmodel",
    };

    // Block keywords whose declared type has fields that are in scope inside its body
    // (so an expression there can reference them) — used for field-name completion.
    private static readonly HashSet<string> FieldedTypeKeywords = new(StringComparer.Ordinal)
    {
        "value", "quantity", "entity", "aggregate",
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
                if (ReferenceEquals(t, preceding))
                    break;
                if (EndsAtOrBefore(t, preceding.Line, preceding.Column))
                    beforePreceding = t;
            }
        }

        string partial = current is null
            ? ""
            : current.Text.Substring(0, Math.Clamp(targetCol - current.Column, 0, current.Text.Length));

        var (enclosingKeyword, enclosingType) = EnclosingScope(def, targetLine, targetCol);
        return new TokenContext(preceding, beforePreceding, current, partial,
            enclosingKeyword, enclosingType, insideStringOrRegex);
    }

    private static bool IsWord(IToken t)
    {
        if (t.Type == KoineLexer.Identifier)
            return true;
        var s = t.Text;
        return s.Length > 0 && (char.IsLetter(s[0]) || s[0] == '_');
    }

    /// <summary>True when the cursor sits within <c>(start, end]</c> of the token on its line.</summary>
    private static bool Contains(IToken t, int line, int col)
    {
        if (t.Line != line)
            return false;
        int start = t.Column;
        int end = start + (t.Text?.Length ?? 0);
        return col > start && col <= end;
    }

    private static bool EndsAtOrBefore(IToken t, int line, int col)
    {
        if (t.Line < line)
            return true;
        if (t.Line > line)
            return false;
        return t.Column + (t.Text?.Length ?? 0) <= col;
    }

    private static bool Before(IToken t, int line, int col) =>
        t.Line < line || (t.Line == line && t.Column < col);

    /// <summary>
    /// The innermost <c>{ }</c> block enclosing the cursor: its introducing keyword
    /// (e.g. <c>service</c>, <c>entity</c>), and the name of the nearest enclosing
    /// fielded type (value/entity/aggregate/quantity) whose fields are in scope — used
    /// to offer field-name completions inside invariant/command/create bodies. A forward
    /// scan pushes each block's (keyword, name) on <c>{</c> and pops on <c>}</c>.
    /// </summary>
    private static (string? Keyword, string? FieldedType) EnclosingScope(List<IToken> def, int line, int col)
    {
        var stack = new Stack<(string Keyword, string? Name)>();
        string? pendingKeyword = null;
        string? pendingName = null;
        foreach (var t in def)
        {
            if (!Before(t, line, col))
                break;
            if (t.Type == KoineLexer.LBRACE)
            {
                stack.Push((pendingKeyword ?? "", pendingName));
                pendingKeyword = null;
                pendingName = null;
            }
            else if (t.Type == KoineLexer.RBRACE)
            {
                if (stack.Count > 0)
                    stack.Pop();
                pendingKeyword = null;
                pendingName = null;
            }
            else if (BlockKeywords.Contains(t.Text))
            {
                pendingKeyword = t.Text;
                pendingName = null;
            }
            else if (pendingKeyword is not null && pendingName is null && IsWord(t))
            {
                pendingName = t.Text; // the declared name following the block keyword
            }
        }

        string? keyword = stack.Count == 0 ? null : (stack.Peek().Keyword.Length == 0 ? null : stack.Peek().Keyword);

        string? fieldedType = null;
        foreach (var frame in stack) // Stack enumerates innermost-first
            if (FieldedTypeKeywords.Contains(frame.Keyword) && frame.Name is not null)
            {
                fieldedType = frame.Name;
                break;
            }

        return (keyword, fieldedType);
    }
}
