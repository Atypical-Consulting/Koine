using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Grammar;

namespace Koine.Compiler.Parsing;

/// <summary>
/// Collects lexer and parser syntax errors as <see cref="Diagnostic"/>s with 1-based
/// line/column positions, stamped with the originating <see cref="_file"/> (R13.1).
/// </summary>
/// <remarks>
/// Soft-keyword post-processing: when the offending token is a soft keyword (the
/// <c>declKeyword</c> set in <c>KoineParser.g4</c>) or a fully-reserved word
/// (<c>invariant</c>/<c>matches</c>) used where a plain <c>Identifier</c> declaration name is
/// required, the raw ANTLR <c>KOI0001 "mismatched input … expecting Identifier"</c> is
/// replaced with a tailored, actionable <c>KOI0002</c>. The trigger keys on ANTLR's
/// "expecting Identifier" wording plus the offending token type; the emitted message is
/// entirely ours.
/// </remarks>
public sealed class SyntaxErrorListener : IAntlrErrorListener<IToken>, IAntlrErrorListener<int>
{
    private readonly List<Diagnostic> _errors = new();
    private readonly string? _file;

    public SyntaxErrorListener(string? file = null) => _file = file;

    public IReadOnlyList<Diagnostic> Errors => _errors;
    public bool HasErrors => _errors.Count > 0;

    /// <summary>
    /// Soft keywords (the grammar's <c>declKeyword</c> set, plus <c>when/if/then/else</c>): usable
    /// as field/parameter/member names, but NOT as the bare declaration name following
    /// <c>value</c>/<c>entity</c>/<c>command</c>/etc.
    /// </summary>
    private static readonly HashSet<int> SoftKeywords = new()
    {
        KoineLexer.CONTEXT, KoineLexer.VALUE, KoineLexer.QUANTITY, KoineLexer.ENTITY,
        KoineLexer.AGGREGATE, KoineLexer.ENUM, KoineLexer.IDENTIFIED, KoineLexer.BY,
        KoineLexer.ROOT, KoineLexer.COMMAND, KoineLexer.REQUIRES, KoineLexer.EVENT,
        KoineLexer.EMIT, KoineLexer.STATES, KoineLexer.CREATE, KoineLexer.SPEC,
        KoineLexer.ON, KoineLexer.SERVICE, KoineLexer.OPERATION, KoineLexer.POLICY,
        KoineLexer.AS, KoineLexer.NATURAL, KoineLexer.SEQUENCE, KoineLexer.GUID,
        KoineLexer.VERSIONED, KoineLexer.REPOSITORY, KoineLexer.OPERATIONS, KoineLexer.FIND,
        KoineLexer.USECASE, KoineLexer.READMODEL, KoineLexer.FROM, KoineLexer.QUERY,
        KoineLexer.IMPORT, KoineLexer.MODULE, KoineLexer.ACL, KoineLexer.INTEGRATION,
        KoineLexer.PUBLISHES, KoineLexer.SUBSCRIBES, KoineLexer.VERSION,
        KoineLexer.WHEN, KoineLexer.IF, KoineLexer.THEN, KoineLexer.ELSE,
    };

    /// <summary>
    /// Fully-reserved words: <c>invariant</c> (declaration ambiguity) and <c>matches</c>
    /// (pushes the regex lexer mode). These can never be a name anywhere.
    /// </summary>
    private static readonly HashSet<int> FullyReserved = new()
    {
        KoineLexer.INVARIANT, KoineLexer.MATCHES,
    };

    public void SyntaxError(TextWriter output, IRecognizer recognizer, IToken offendingSymbol,
        int line, int charPositionInLine, string msg, RecognitionException e)
    {
        var span = new SourceSpan(line, charPositionInLine + 1, _file);
        if (TryReservedWordDiagnostic(offendingSymbol, msg, span, out var reserved))
            _errors.Add(reserved);
        else
            _errors.Add(Diagnostic.Error(DiagnosticCodes.SyntaxError, msg, span));
    }

    public void SyntaxError(TextWriter output, IRecognizer recognizer, int offendingSymbol,
        int line, int charPositionInLine, string msg, RecognitionException e) =>
        _errors.Add(Diagnostic.Error(DiagnosticCodes.SyntaxError, msg, new SourceSpan(line, charPositionInLine + 1, _file)));

    /// <summary>
    /// When a (soft or fully-reserved) keyword appears in a hard-<c>Identifier</c> position —
    /// detected by ANTLR's "expecting Identifier" wording plus the offending token type —
    /// produce a tailored <c>KOI0002</c> instead of the generic syntax error.
    /// </summary>
    private static bool TryReservedWordDiagnostic(IToken? offendingSymbol, string msg, SourceSpan span, out Diagnostic diagnostic)
    {
        diagnostic = null!;
        if (offendingSymbol is null || !msg.Contains("expecting Identifier", StringComparison.Ordinal))
            return false;

        var word = offendingSymbol.Text;
        if (FullyReserved.Contains(offendingSymbol.Type))
        {
            diagnostic = Diagnostic.Error(
                DiagnosticCodes.ReservedWordInDeclarationName,
                $"'{word}' is fully reserved in Koine and can never be a name (field, type, or otherwise). Choose a different name.",
                span);
            return true;
        }

        if (SoftKeywords.Contains(offendingSymbol.Type))
        {
            diagnostic = Diagnostic.Error(
                DiagnosticCodes.ReservedWordInDeclarationName,
                $"'{word}' is a Koine keyword and cannot be used as a declaration name here. " +
                "Keywords are usable as field, parameter, and member names, but the name that immediately " +
                "follows 'value'/'entity'/'command'/etc. must be a plain identifier. " +
                $"Rename it (e.g. '{word}Name') or, if you meant a field, move it inside the body.",
                span);
            return true;
        }

        return false;
    }
}
