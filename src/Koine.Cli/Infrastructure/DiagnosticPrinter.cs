using Koine.Compiler.Diagnostics;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Writes compiler diagnostics in the MSBuild/Roslyn-parseable shape
/// <c>file:line:col: severity CODE: message</c> to stderr. This output is consumed by the
/// demo's MSBuild <c>KoineGenerate</c> target (and Roslyn), so it must stay plain text —
/// no ANSI escapes, no Spectre markup, ever.
/// </summary>
internal static class DiagnosticPrinter
{
    /// <summary>Prints every diagnostic; returns <c>true</c> if any was an error.</summary>
    public static bool Print(IEnumerable<Diagnostic> diagnostics, string fallbackFile)
    {
        var hasError = false;
        foreach (var diag in diagnostics)
        {
            if (diag.Severity == DiagnosticSeverity.Error)
            {
                hasError = true;
            }

            Console.Error.WriteLine(Format(diag, fallbackFile));
        }

        return hasError;
    }

    /// <summary>Prints only the error-severity diagnostics (used by <c>fmt</c> on a parse failure).</summary>
    public static void PrintErrors(IEnumerable<Diagnostic> diagnostics, string fallbackFile)
    {
        foreach (var diag in diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error))
        {
            Console.Error.WriteLine(Format(diag, fallbackFile));
        }
    }

    private static string Format(Diagnostic diag, string fallbackFile)
    {
        var severity = diag.Severity.ToString().ToLowerInvariant();
        return $"{diag.File ?? fallbackFile}:{diag.Line}:{diag.Column}: {severity} {diag.Code}: {diag.Message}";
    }
}
