using Koine.Compiler.Ast;

namespace Koine.Compiler.Diagnostics;

public enum DiagnosticSeverity { Error, Warning }

/// <summary>
/// A compiler diagnostic with a stable <see cref="Code"/> (e.g. <c>KOI0201</c>) and a
/// <see cref="SourceSpan"/> (1-based position plus the originating file). Formatting into
/// the <c>file:line:col: severity CODE: message</c> shape is the CLI's responsibility.
/// </summary>
public sealed record Diagnostic(
    DiagnosticSeverity Severity,
    string Code,
    string Message,
    SourceSpan Span)
{
    public int Line => Span.Line;
    public int Column => Span.Column;

    /// <summary>The originating source file, when known (multi-file builds).</summary>
    public string? File => Span.File;

    public static Diagnostic Error(string code, string message, SourceSpan span) =>
        new(DiagnosticSeverity.Error, code, message, span);

    public static Diagnostic Error(string code, string message, int line, int column) =>
        new(DiagnosticSeverity.Error, code, message, new SourceSpan(line, column));

    public static Diagnostic Warning(string code, string message, SourceSpan span) =>
        new(DiagnosticSeverity.Warning, code, message, span);

    public static Diagnostic Warning(string code, string message, int line, int column) =>
        new(DiagnosticSeverity.Warning, code, message, new SourceSpan(line, column));

    public override string ToString() =>
        $"{Line}:{Column}: {Severity.ToString().ToLowerInvariant()} {Code}: {Message}";
}
