using System.ComponentModel;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Mcp;

/// <summary>One <c>.koi</c> source unit passed to a tool: a display path and its text.</summary>
public sealed record KoineFile(
    [property: Description("Relative path / display name, e.g. \"billing.koi\". Used in diagnostic file attribution.")]
    string Path,
    [property: Description("The .koi source text for this file.")]
    string Source)
{
    /// <summary>Maps the tool's file list to the compiler's <see cref="SourceFile"/> inputs.</summary>
    internal static IReadOnlyList<SourceFile> ToSources(IEnumerable<KoineFile> files) =>
        files.Select(f => new SourceFile(f.Path, f.Source)).ToList();
}

/// <summary>A compiler diagnostic, flattened for transport (1-based, end-exclusive spans).</summary>
public sealed record DiagnosticInfo(
    string Severity,
    string Code,
    string Message,
    string? File,
    int Line,
    int Column,
    int EndLine,
    int EndColumn)
{
    internal static DiagnosticInfo From(Diagnostic d) => new(
        d.Severity.ToString().ToLowerInvariant(),
        d.Code,
        d.Message,
        d.File,
        d.Line,
        d.Column,
        d.EndLine,
        d.EndColumn);

    internal static IReadOnlyList<DiagnosticInfo> From(IReadOnlyList<Diagnostic> diagnostics) =>
        diagnostics.Select(From).ToList();
}

/// <summary>The result of <c>koine_validate</c>.</summary>
public sealed record ValidationResult(
    bool Ok,
    int ErrorCount,
    int WarningCount,
    IReadOnlyList<DiagnosticInfo> Diagnostics)
{
    internal static ValidationResult From(IReadOnlyList<Diagnostic> diagnostics)
    {
        var errors = diagnostics.Count(d => d.Severity == DiagnosticSeverity.Error);
        return new ValidationResult(
            Ok: errors == 0,
            ErrorCount: errors,
            WarningCount: diagnostics.Count - errors,
            Diagnostics: DiagnosticInfo.From(diagnostics));
    }
}

/// <summary>A single generated output file.</summary>
public sealed record EmittedFileInfo(string Path, string Contents);

/// <summary>The result of <c>koine_compile</c>.</summary>
public sealed record CompilationResult(
    bool Success,
    int ErrorCount,
    int WarningCount,
    IReadOnlyList<DiagnosticInfo> Diagnostics,
    IReadOnlyList<EmittedFileInfo> Files)
{
    /// <summary>A self-inflicted failure (e.g. a bad target) reported as one error diagnostic.</summary>
    internal static CompilationResult Failed(string message) => new(
        Success: false,
        ErrorCount: 1,
        WarningCount: 0,
        Diagnostics: new[] { new DiagnosticInfo("error", "KOIMCP000", message, null, 0, 0, 0, 0) },
        Files: Array.Empty<EmittedFileInfo>());

    internal static CompilationResult From(CompileResult result)
    {
        var errors = result.Diagnostics.Count(d => d.Severity == DiagnosticSeverity.Error);
        return new CompilationResult(
            Success: result.Success,
            ErrorCount: errors,
            WarningCount: result.Diagnostics.Count - errors,
            Diagnostics: DiagnosticInfo.From(result.Diagnostics),
            Files: result.Files.Select(f => new EmittedFileInfo(f.RelativePath, f.Contents)).ToList());
    }
}

/// <summary>The result of <c>koine_format</c>.</summary>
public sealed record FormattingResult(
    string Text,
    bool Changed,
    IReadOnlyList<DiagnosticInfo> Diagnostics);
