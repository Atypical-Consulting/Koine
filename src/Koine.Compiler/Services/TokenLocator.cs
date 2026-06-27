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
    // (so an expression there can reference them) — used for field-name completion AND as
    // the field-rename scope (a field declared on one of these resolves its enclosing type).
    // `event` is included so renaming a field on an `event` (or the two-word
    // `integration event`, which also opens an `event`-keyword frame here) resolves its owner
    // — matching SemanticModel.MemberOf, which resolves members for EventDecl and
    // IntegrationEventDecl. Without it, such a field rename resolves enclosingType=null and is
    // a silent no-op.
    private static readonly HashSet<string> FieldedTypeKeywords = new(StringComparer.Ordinal)
    {
        "value", "quantity", "entity", "aggregate", "event",
    };

    /// <summary>
    /// Locates the token context at an LSP 0-based <paramref name="line"/>/<paramref name="character"/>.
    /// Never throws: lexer error listeners are removed and malformed input yields a
    /// context with null tokens.
    /// </summary>
    /// <param name="navigation">
    /// When <c>true</c>, the word-token under the cursor is matched with inclusive-start
    /// <c>[start, end]</c> containment so a cursor at an identifier's <em>first</em> column still
    /// resolves it — what hover, go-to-definition, find-references, rename, and call/type hierarchy
    /// want. The default <c>false</c> keeps completion's <c>(start, end]</c> bias, where a caret on a
    /// boundary belongs to the token to its left (so typing extends that token). String/regex/comment
    /// containment (which gates <see cref="TokenContext.InsideStringOrRegex"/>) is unaffected either way.
    /// </param>
    public static TokenContext Locate(string source, int line, int character, bool navigation = false)
    {
        var lexer = new KoineLexer(new AntlrInputStream(source));
        lexer.RemoveErrorListeners();
        var stream = new CommonTokenStream(lexer);
        stream.Fill();
        IList<IToken>? tokens = stream.GetTokens();

        int targetLine = line + 1;     // ANTLR Line is 1-based
        int targetCol = character;     // ANTLR Column is 0-based, == LSP character

        var def = new List<IToken>();
        bool insideStringOrRegex = false;

        foreach (IToken t in tokens)
        {
            if (t.Type == TokenConstants.EOF)
            {
                continue;
            }

            if (t.Channel != TokenConstants.DefaultChannel)
            {
                // Off-channel tokens are comments (DOC `///` and HIDDEN `//` / `/* */`) and, since
                // #5, whitespace on the TRIVIA channel. Comments are intentionally treated as
                // not-code: a cursor inside one sets insideStringOrRegex so completion is suppressed
                // there too, per spec. (Don't "fix" the comment case — suppression is desired.)
                // Whitespace, however, is NOT code-suppressing: a cursor in a WS gap is a perfectly
                // valid completion position (e.g. just after `x: `), so skip WS without suppressing.
                if (t.Type != KoineLexer.WS && t.Type != KoineLexer.REGEX_WS
                    && Contains(t, targetLine, targetCol))
                {
                    insideStringOrRegex = true;
                }

                continue;
            }

            def.Add(t);

            if ((t.Type == KoineLexer.StringLiteral || t.Type == KoineLexer.Regex)
                && Contains(t, targetLine, targetCol))
            {
                insideStringOrRegex = true;
            }
        }

        IToken? current = null;
        foreach (IToken t in def)
        {
            if (IsWord(t) && Contains(t, targetLine, targetCol, inclusiveStart: navigation))
            {
                current = t;
                break;
            }
        }

        int boundaryLine = current?.Line ?? targetLine;
        int boundaryCol = current?.Column ?? targetCol;
        IToken? preceding = null;
        foreach (IToken t in def)
        {
            if (ReferenceEquals(t, current))
            {
                continue;
            }

            if (EndsAtOrBefore(t, boundaryLine, boundaryCol))
            {
                preceding = t;
            }
        }

        IToken? beforePreceding = null;
        if (preceding is not null)
        {
            foreach (IToken t in def)
            {
                if (ReferenceEquals(t, preceding))
                {
                    break;
                }

                if (EndsAtOrBefore(t, preceding.Line, preceding.Column))
                {
                    beforePreceding = t;
                }
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
        {
            return true;
        }

        var s = t.Text;
        return s.Length > 0 && (char.IsLetter(s[0]) || s[0] == '_');
    }

    /// <summary>
    /// True when the cursor sits within the token on its line. The end is always inclusive; the
    /// <em>start</em> is exclusive by default (completion's <c>(start, end]</c> bias — a caret on the
    /// boundary belongs to the token on its left) and inclusive when <paramref name="inclusiveStart"/>
    /// is set (navigation's <c>[start, end]</c> — a cursor on the identifier's first column resolves it).
    /// </summary>
    private static bool Contains(IToken t, int line, int col, bool inclusiveStart = false)
    {
        if (t.Line != line)
        {
            return false;
        }

        int start = t.Column;
        int end = start + (t.Text?.Length ?? 0);
        return (inclusiveStart ? col >= start : col > start) && col <= end;
    }

    private static bool EndsAtOrBefore(IToken t, int line, int col)
    {
        if (t.Line < line)
        {
            return true;
        }

        if (t.Line > line)
        {
            return false;
        }

        return t.Column + (t.Text?.Length ?? 0) <= col;
    }

    private static bool Before(IToken t, int line, int col) =>
        t.Line < line || (t.Line == line && t.Column < col);

    /// <summary>
    /// The innermost <c>{ }</c> block enclosing the cursor: its introducing keyword
    /// (e.g. <c>service</c>, <c>entity</c>), and the name of the nearest enclosing
    /// fielded type (value/entity/aggregate/quantity/event) whose fields are in scope — used
    /// to offer field-name completions inside invariant/command/create bodies and as the
    /// field-rename scope. A forward
    /// scan pushes each block's (keyword, name) on <c>{</c> and pops on <c>}</c>.
    /// </summary>
    private static (string? Keyword, string? FieldedType) EnclosingScope(List<IToken> def, int line, int col)
    {
        var stack = new Stack<(string Keyword, string? Name)>();
        string? pendingKeyword = null;
        string? pendingName = null;
        foreach (IToken t in def)
        {
            if (!Before(t, line, col))
            {
                break;
            }

            if (t.Type == KoineLexer.LBRACE)
            {
                stack.Push((pendingKeyword ?? "", pendingName));
                pendingKeyword = null;
                pendingName = null;
            }
            else if (t.Type == KoineLexer.RBRACE)
            {
                if (stack.Count > 0)
                {
                    stack.Pop();
                }

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
        foreach ((string Keyword, string? Name) frame in stack) // Stack enumerates innermost-first
        {
            if (FieldedTypeKeywords.Contains(frame.Keyword) && frame.Name is not null)
            {
                fieldedType = frame.Name;
                break;
            }
        }

        return (keyword, fieldedType);
    }
}
