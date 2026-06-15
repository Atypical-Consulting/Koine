using Antlr4.Runtime;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Parsing;

/// <summary>
/// Collects lexer and parser syntax errors as <see cref="Diagnostic"/>s with 1-based
/// line/column positions, stamped with the originating <see cref="_file"/> (R13.1).
/// </summary>
public sealed class SyntaxErrorListener : IAntlrErrorListener<IToken>, IAntlrErrorListener<int>
{
    private readonly List<Diagnostic> _errors = new();
    private readonly string? _file;

    public SyntaxErrorListener(string? file = null) => _file = file;

    public IReadOnlyList<Diagnostic> Errors => _errors;
    public bool HasErrors => _errors.Count > 0;

    public void SyntaxError(TextWriter output, IRecognizer recognizer, IToken offendingSymbol,
        int line, int charPositionInLine, string msg, RecognitionException e) =>
        _errors.Add(Diagnostic.Error(DiagnosticCodes.SyntaxError, msg, new SourceSpan(line, charPositionInLine + 1, _file)));

    public void SyntaxError(TextWriter output, IRecognizer recognizer, int offendingSymbol,
        int line, int charPositionInLine, string msg, RecognitionException e) =>
        _errors.Add(Diagnostic.Error(DiagnosticCodes.SyntaxError, msg, new SourceSpan(line, charPositionInLine + 1, _file)));
}
