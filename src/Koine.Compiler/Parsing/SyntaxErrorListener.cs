using Antlr4.Runtime;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Parsing;

/// <summary>
/// Collects lexer and parser syntax errors as <see cref="Diagnostic"/>s with
/// 1-based line/column positions.
/// </summary>
public sealed class SyntaxErrorListener : IAntlrErrorListener<IToken>, IAntlrErrorListener<int>
{
    private readonly List<Diagnostic> _errors = new();

    public IReadOnlyList<Diagnostic> Errors => _errors;
    public bool HasErrors => _errors.Count > 0;

    public void SyntaxError(TextWriter output, IRecognizer recognizer, IToken offendingSymbol,
        int line, int charPositionInLine, string msg, RecognitionException e) =>
        _errors.Add(Diagnostic.Error(DiagnosticCodes.SyntaxError, msg, line, charPositionInLine + 1));

    public void SyntaxError(TextWriter output, IRecognizer recognizer, int offendingSymbol,
        int line, int charPositionInLine, string msg, RecognitionException e) =>
        _errors.Add(Diagnostic.Error(DiagnosticCodes.SyntaxError, msg, line, charPositionInLine + 1));
}
