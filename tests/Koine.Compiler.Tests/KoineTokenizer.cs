using Antlr4.Runtime;
using Koine.Compiler.Grammar;

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
/// Tokenises <c>.koi</c> source for <see cref="GbnfMatcher"/> through the <b>real, generated
/// <see cref="KoineLexer"/></b> — the exact lexer the compiler runs — rather than a hand-maintained
/// parallel keyword/role/operator list. That parallel copy was a third place the keyword set lived
/// (lexer grammar, <c>GbnfExporter</c> rule table, this tokenizer), free to drift from the lexer and let
/// the GBNF tests pass against a tokenisation the compiler would never produce. Adapting the generated
/// lexer keeps the harness in lock-step with the language for free: the <c>matches /.../</c> regex mode,
/// trivia dropping, and the multi-word hyphenated context-map role tokens all come from the lexer, not a
/// re-listing.
/// </summary>
internal static class KoineTokenizer
{
    /// <summary>
    /// Lexes <paramref name="src"/> with <see cref="KoineLexer"/> and projects the parser-visible
    /// (default-channel) tokens onto the matcher's <see cref="KoineToken"/> shape. Whitespace, comments,
    /// and doc comments ride hidden channels in <c>KoineLexer.g4</c>, so they are dropped here exactly as
    /// the compiler's parser drops them (it reads only the default channel).
    ///
    /// <para>Returns <c>null</c> when the lexer reports a token-recognition error — a character no Koine
    /// token can start with (e.g. a stray <c>;</c> injected into a garbage variant). ANTLR otherwise
    /// silently skips the offending char and lexes on, so without this the matcher would accept input the
    /// compiler's lexer rejects.</para>
    /// </summary>
    public static List<KoineToken>? Tokenize(string src)
    {
        var lexer = new KoineLexer(new AntlrInputStream(src));
        lexer.RemoveErrorListeners();
        var errorSink = new ErrorSink();
        lexer.AddErrorListener(errorSink);

        var tokens = new List<KoineToken>();
        foreach (IToken token in lexer.GetAllTokens())
        {
            // The parser (and so the matcher) reads only the default channel; EOF is not a real token.
            if (token.Channel != TokenConstants.DefaultChannel || token.Type == TokenConstants.EOF)
            {
                continue;
            }

            tokens.Add(new KoineToken(KindOf(token.Type), token.Text));
        }

        return errorSink.HadError ? null : tokens;
    }

    /// <summary>Projects a generated <see cref="KoineLexer"/> token type onto the lexical
    /// <see cref="TokenKind"/> the GBNF recogniser distinguishes: the five literal/identifier terminals
    /// map to their kind; every other default-channel token (keyword, hyphenated role, operator,
    /// punctuation, and <c>true</c>/<c>false</c>) is exact-text-matched by a quoted GBNF literal.</summary>
    private static TokenKind KindOf(int tokenType) => tokenType switch
    {
        KoineLexer.Identifier => TokenKind.Identifier,
        KoineLexer.IntLiteral => TokenKind.Int,
        KoineLexer.DecimalLiteral => TokenKind.Decimal,
        KoineLexer.StringLiteral => TokenKind.String,
        KoineLexer.Regex => TokenKind.Regex,
        _ => TokenKind.Exact,
    };

    /// <summary>Records whether the lexer raised any token-recognition error during a tokenise pass.</summary>
    private sealed class ErrorSink : IAntlrErrorListener<int>
    {
        public bool HadError { get; private set; }

        public void SyntaxError(TextWriter output, IRecognizer recognizer, int offendingSymbol,
            int line, int charPositionInLine, string msg, RecognitionException e) => HadError = true;
    }
}
