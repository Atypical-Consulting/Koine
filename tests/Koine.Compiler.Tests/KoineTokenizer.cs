namespace Koine.Compiler.Tests;

/// <summary>The lexical kind of a <see cref="KoineToken"/> the <see cref="GbnfMatcher"/> matches against.</summary>
internal enum TokenKind
{
    /// <summary>An exact-text token: a keyword, a context-map role, an operator, or punctuation.
    /// Matched by a quoted GBNF literal whose text is identical.</summary>
    Exact,

    /// <summary>A non-keyword identifier — matched by the GBNF <c>ident</c> terminal.</summary>
    Identifier,

    /// <summary>An integer literal — matched by the GBNF <c>int</c> terminal.</summary>
    Int,

    /// <summary>A decimal literal — matched by the GBNF <c>decimal</c> terminal.</summary>
    Decimal,

    /// <summary>A double-quoted string literal — matched by the GBNF <c>string</c> terminal.</summary>
    String,

    /// <summary>A <c>/.../</c> regex literal — matched by the GBNF <c>regex</c> terminal.</summary>
    Regex,
}

/// <summary>One lexed Koine token: its <see cref="Kind"/> plus its exact source <see cref="Text"/>.</summary>
internal readonly record struct KoineToken(TokenKind Kind, string Text);

/// <summary>
/// A faithful, test-only mini-lexer for <c>.koi</c> that mirrors <c>KoineLexer.g4</c> closely enough
/// to feed <see cref="GbnfMatcher"/>: it does maximal-munch keyword/operator recognition, drops
/// whitespace and comments (which ride hidden channels in the real lexer), reads a <c>matches /.../</c>
/// regex as a single token (the lexer's REGEX_MODE), and classifies the multi-word, hyphenated
/// context-map role keywords as single tokens.
///
/// <para>It returns <c>null</c> when it meets a character no Koine token can start with (e.g. a stray
/// <c>;</c> or <c>$</c> injected into a garbage variant) — which the matcher treats as "not in the
/// language", exactly as the real lexer would reject it.</para>
/// </summary>
internal static class KoineTokenizer
{
    /// <summary>The reserved words the lexer tokenises as keywords (so they never lex as identifiers),
    /// mirroring the keyword rules in <c>KoineLexer.g4</c>. <c>true</c>/<c>false</c> are included here:
    /// they are matched by the GBNF <c>bool</c> rule's quoted literals by text.</summary>
    private static readonly HashSet<string> Keywords = new(StringComparer.Ordinal)
    {
        "context", "value", "quantity", "entity", "aggregate", "enum", "identified", "by", "root",
        "invariant", "command", "requires", "result", "event", "emit", "states", "create", "spec",
        "on", "service", "operation", "policy", "as", "natural", "sequence", "guid", "versioned",
        "repository", "operations", "find", "usecase", "readmodel", "from", "query", "import",
        "module", "version", "contextmap", "partnership", "conformist", "acl", "integration",
        "publishes", "subscribes", "when", "if", "then", "else", "let", "in", "matches",
        "true", "false",
    };

    /// <summary>The hyphenated context-map role keywords — single tokens whose hyphen is part of the
    /// spelling (the only place a hyphen is legal in the language). Longest first so the maximal-munch
    /// match is unambiguous.</summary>
    private static readonly string[] HyphenRoles =
    {
        "anti-corruption-layer", "published-language", "customer-supplier", "shared-kernel", "open-host",
    };

    /// <summary>Multi- and single-character operators/punctuation, longest first for maximal munch.</summary>
    private static readonly string[] Operators =
    {
        "<->", "->", "=>", "??", "==", "!=", "<=", ">=", "&&", "||",
        "{", "}", "(", ")", ",", ":", ".", "?", "@", "=", "<", ">", "+", "-", "*", "/", "!",
    };

    /// <summary>Tokenises <paramref name="src"/>, or returns <c>null</c> on an unlexable character.</summary>
    public static List<KoineToken>? Tokenize(string src)
    {
        var tokens = new List<KoineToken>();
        int i = 0;
        int n = src.Length;
        while (i < n)
        {
            char c = src[i];

            if (c is ' ' or '\t' or '\r' or '\n')
            {
                i++;
                continue;
            }

            // Comments ride hidden channels in the real lexer: skip them entirely.
            if (c == '/' && i + 1 < n && src[i + 1] == '/')
            {
                while (i < n && src[i] != '\n')
                {
                    i++;
                }

                continue;
            }

            if (c == '/' && i + 1 < n && src[i + 1] == '*')
            {
                i += 2;
                while (i + 1 < n && !(src[i] == '*' && src[i + 1] == '/'))
                {
                    i++;
                }

                i = Math.Min(i + 2, n);
                continue;
            }

            if (c == '"')
            {
                int j = i + 1;
                while (j < n && src[j] != '"')
                {
                    j += src[j] == '\\' ? 2 : 1;
                }

                j = Math.Min(j + 1, n); // include the closing quote
                tokens.Add(new KoineToken(TokenKind.String, src[i..j]));
                i = j;
                continue;
            }

            if (char.IsDigit(c))
            {
                int j = i;
                while (j < n && char.IsDigit(src[j]))
                {
                    j++;
                }

                if (j < n && src[j] == '.' && j + 1 < n && char.IsDigit(src[j + 1]))
                {
                    j++;
                    while (j < n && char.IsDigit(src[j]))
                    {
                        j++;
                    }

                    tokens.Add(new KoineToken(TokenKind.Decimal, src[i..j]));
                }
                else
                {
                    tokens.Add(new KoineToken(TokenKind.Int, src[i..j]));
                }

                i = j;
                continue;
            }

            if (char.IsLetter(c) || c == '_')
            {
                // A hyphenated context-map role wins as a single token (maximal munch over the
                // Identifier + '-' + Identifier split that would otherwise apply).
                string? role = MatchHyphenRole(src, i);
                if (role is not null)
                {
                    tokens.Add(new KoineToken(TokenKind.Exact, role));
                    i += role.Length;
                    continue;
                }

                int j = i;
                while (j < n && (char.IsLetterOrDigit(src[j]) || src[j] == '_'))
                {
                    j++;
                }

                string word = src[i..j];
                i = j;
                if (Keywords.Contains(word))
                {
                    tokens.Add(new KoineToken(TokenKind.Exact, word));
                    if (word == "matches" && !TryReadRegex(src, ref i, tokens))
                    {
                        // `matches` not followed by a regex: malformed; bail out.
                        return null;
                    }
                }
                else
                {
                    tokens.Add(new KoineToken(TokenKind.Identifier, word));
                }

                continue;
            }

            string? op = MatchOperator(src, i);
            if (op is not null)
            {
                tokens.Add(new KoineToken(TokenKind.Exact, op));
                i += op.Length;
                continue;
            }

            // A character no Koine token can start with — not in the language.
            return null;
        }

        return tokens;
    }

    /// <summary>After a <c>matches</c> keyword, reads the following <c>/.../</c> regex as one token
    /// (the lexer's REGEX_MODE). Returns false if no regex literal follows.</summary>
    private static bool TryReadRegex(string src, ref int i, List<KoineToken> tokens)
    {
        int n = src.Length;
        while (i < n && (src[i] is ' ' or '\t' or '\r' or '\n'))
        {
            i++;
        }

        if (i >= n || src[i] != '/')
        {
            return false;
        }

        int j = i + 1;
        while (j < n && src[j] != '/' && src[j] != '\n')
        {
            j += src[j] == '\\' ? 2 : 1;
        }

        if (j >= n || src[j] != '/')
        {
            return false;
        }

        j++; // include the closing slash
        tokens.Add(new KoineToken(TokenKind.Regex, src[i..j]));
        i = j;
        return true;
    }

    private static string? MatchHyphenRole(string src, int i)
    {
        foreach (string role in HyphenRoles)
        {
            if (i + role.Length <= src.Length &&
                string.CompareOrdinal(src, i, role, 0, role.Length) == 0)
            {
                int end = i + role.Length;
                bool boundary = end >= src.Length || !(char.IsLetterOrDigit(src[end]) || src[end] == '_' || src[end] == '-');
                if (boundary)
                {
                    return role;
                }
            }
        }

        return null;
    }

    private static string? MatchOperator(string src, int i)
    {
        foreach (string op in Operators)
        {
            if (i + op.Length <= src.Length && string.CompareOrdinal(src, i, op, 0, op.Length) == 0)
            {
                return op;
            }
        }

        return null;
    }
}
