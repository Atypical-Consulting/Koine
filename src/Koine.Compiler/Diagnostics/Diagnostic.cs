namespace Koine.Compiler.Diagnostics;

public enum DiagnosticSeverity { Error, Warning }

/// <summary>
/// A compiler diagnostic with a stable <see cref="Code"/> (e.g. <c>KOI0201</c>) and
/// a 1-based source position. Formatting into the
/// <c>file:line:col: severity CODE: message</c> shape is the CLI's responsibility
/// (it owns the file name).
/// </summary>
public sealed record Diagnostic(
    DiagnosticSeverity Severity,
    string Code,
    string Message,
    int Line,
    int Column)
{
    public static Diagnostic Error(string code, string message, int line, int column) =>
        new(DiagnosticSeverity.Error, code, message, line, column);

    public static Diagnostic Warning(string code, string message, int line, int column) =>
        new(DiagnosticSeverity.Warning, code, message, line, column);

    public override string ToString() =>
        $"{Line}:{Column}: {Severity.ToString().ToLowerInvariant()} {Code}: {Message}";
}
