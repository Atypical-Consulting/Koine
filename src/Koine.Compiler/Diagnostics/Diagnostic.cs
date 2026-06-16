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

    /// <summary>
    /// 1-based, end-EXCLUSIVE end line of the diagnostic range, or <c>0</c> when the end is
    /// unknown (point diagnostics raised from a bare line/column). When known, editors can
    /// underline the exact span instead of guessing the token width.
    /// </summary>
    public int EndLine { get; init; }

    /// <summary>
    /// 1-based, end-EXCLUSIVE end column of the diagnostic range, or <c>0</c> when the end is
    /// unknown. See <see cref="EndLine"/>.
    /// </summary>
    public int EndColumn { get; init; }

    /// <summary>True when this diagnostic carries a known end position (a real range).</summary>
    public bool HasEnd => EndLine > 0 && EndColumn > 0;

    /// <summary>The originating source file, when known (multi-file builds).</summary>
    public string? File => Span.File;

    /// <summary>
    /// Builds an error from a node's full <see cref="SourceSpan"/>, carrying the span's end so
    /// editors underline the exact range (multi-token / multi-line). Falls back gracefully:
    /// a zero-width point span leaves the end unknown.
    /// </summary>
    public static Diagnostic FromSpan(string code, string message, SourceSpan span) =>
        FromSpan(DiagnosticSeverity.Error, code, message, span);

    /// <summary>
    /// Builds a diagnostic of the given <paramref name="severity"/> from a node's full
    /// <see cref="SourceSpan"/>, carrying the span's end position when it has real width.
    /// </summary>
    public static Diagnostic FromSpan(DiagnosticSeverity severity, string code, string message, SourceSpan span)
    {
        var hasEnd = span.EndLine > span.Line || (span.EndLine == span.Line && span.EndColumn > span.Column);
        return new Diagnostic(severity, code, message, span)
        {
            EndLine = hasEnd ? span.EndLine : 0,
            EndColumn = hasEnd ? span.EndColumn : 0,
        };
    }

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
