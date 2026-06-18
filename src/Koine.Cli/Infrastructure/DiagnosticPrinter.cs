using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;
using Spectre.Console;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Renders compiler diagnostics to stderr in one of two forms:
/// <list type="bullet">
/// <item>a <b>plain</b> <c>file:line:col: severity CODE: message</c> line (MSBuild/Roslyn-parseable),
/// used whenever stderr is redirected — pipes, the demo's MSBuild <c>KoineGenerate</c> target,
/// CI, the test runner; and</item>
/// <item>a <b>pretty</b>, colored, source-snippet form (rustc-style, with a caret under the span)
/// when stderr is an interactive terminal.</item>
/// </list>
/// The choice can be forced with <c>KOINE_DIAGNOSTICS=pretty|plain</c> (and pretty is suppressed
/// by <c>NO_COLOR</c>). The plain form is byte-stable — nothing downstream that parses diagnostics
/// is affected by the pretty path.
/// </summary>
internal static class DiagnosticPrinter
{
    private static bool UsePretty
    {
        get
        {
            var mode = Environment.GetEnvironmentVariable("KOINE_DIAGNOSTICS");
            if (Is(mode, "pretty") || Is(mode, "always"))
            {
                return true;
            }

            if (Is(mode, "plain") || Is(mode, "never"))
            {
                return false;
            }

            return !Console.IsErrorRedirected
                && string.IsNullOrEmpty(Environment.GetEnvironmentVariable("NO_COLOR"));
        }
    }

    private static bool Is(string? value, string token) =>
        string.Equals(value, token, StringComparison.OrdinalIgnoreCase);

    // Created fresh per render (not cached) so it always targets the current Console.Error —
    // the stream can be swapped (watch mode, tests) and there are only ever a handful of diagnostics.
    private static IAnsiConsole Err => AnsiConsole.Create(new AnsiConsoleSettings
    {
        Out = new AnsiConsoleOutput(Console.Error),
    });

    /// <summary>Prints every diagnostic; returns <c>true</c> if any was an error.</summary>
    public static bool Print(IReadOnlyList<Diagnostic> diagnostics, IReadOnlyList<SourceFile> sources, string fallbackFile)
    {
        var hasError = false;
        foreach (var diag in diagnostics)
        {
            if (diag.Severity == DiagnosticSeverity.Error)
            {
                hasError = true;
            }

            Write(diag, sources, fallbackFile);
        }

        return hasError;
    }

    /// <summary>Prints only the error-severity diagnostics (used by <c>fmt</c> on a parse failure).</summary>
    public static void PrintErrors(IReadOnlyList<Diagnostic> diagnostics, IReadOnlyList<SourceFile> sources, string fallbackFile)
    {
        foreach (var diag in diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error))
        {
            Write(diag, sources, fallbackFile);
        }
    }

    private static void Write(Diagnostic diag, IReadOnlyList<SourceFile> sources, string fallbackFile)
    {
        if (UsePretty)
        {
            WritePretty(diag, sources, fallbackFile);
        }
        else
        {
            Console.Error.WriteLine(Plain(diag, fallbackFile));
        }
    }

    private static string Plain(Diagnostic diag, string fallbackFile)
    {
        var severity = diag.Severity.ToString().ToLowerInvariant();
        return $"{diag.File ?? fallbackFile}:{diag.Line}:{diag.Column}: {severity} {diag.Code}: {diag.Message}";
    }

    private static void WritePretty(Diagnostic diag, IReadOnlyList<SourceFile> sources, string fallbackFile)
    {
        var file = diag.File ?? fallbackFile;
        var color = diag.Severity == DiagnosticSeverity.Error ? "red" : "yellow";
        var severity = diag.Severity.ToString().ToLowerInvariant();

        // Header: `error[KOI0123]: message`
        Err.MarkupLine($"[bold {color}]{severity}[[{Markup.Escape(diag.Code)}]][/][bold]: {Markup.Escape(diag.Message)}[/]");

        // Location: ` --> file:line:col`
        Err.MarkupLine($"  [blue]-->[/] {Markup.Escape(file)}:{diag.Line}:{diag.Column}");

        // Source snippet with a caret under the offending span, when we have the line.
        var line = SourceLine(sources, file, diag.Line);
        if (line is not null)
        {
            var gutter = diag.Line.ToString();
            var pad = new string(' ', gutter.Length);
            var caretIndent = new string(' ', Math.Max(0, diag.Column - 1));
            var carets = new string('^', CaretLength(diag, line));

            Err.MarkupLine($"  [blue]{pad} |[/]");
            Err.MarkupLine($"  [blue]{gutter} |[/] {Markup.Escape(line)}");
            Err.MarkupLine($"  [blue]{pad} |[/] {caretIndent}[bold {color}]{carets}[/]");
        }

        Err.WriteLine();
    }

    /// <summary>The caret width: the span's column extent when known on one line, else a single caret.</summary>
    private static int CaretLength(Diagnostic diag, string line)
    {
        if (diag.HasEnd && diag.EndLine == diag.Line && diag.EndColumn > diag.Column)
        {
            return diag.EndColumn - diag.Column;
        }

        // Multi-line or point span: underline to the end of the line (at least one caret).
        if (diag.HasEnd && diag.EndLine > diag.Line)
        {
            return Math.Max(1, line.Length - (diag.Column - 1));
        }

        return 1;
    }

    /// <summary>Looks up the 1-based <paramref name="line"/> of <paramref name="file"/> among the loaded sources.</summary>
    private static string? SourceLine(IReadOnlyList<SourceFile> sources, string file, int line)
    {
        foreach (var source in sources)
        {
            if (source.Path == file || Path.GetFileName(source.Path) == Path.GetFileName(file))
            {
                var lines = source.Source.Replace("\r\n", "\n").Split('\n');
                return line >= 1 && line <= lines.Length ? lines[line - 1] : null;
            }
        }

        return null;
    }
}
