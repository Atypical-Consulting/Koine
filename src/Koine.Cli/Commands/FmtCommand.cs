using System.ComponentModel;
using Koine.Cli.Infrastructure;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>Flags for <c>fmt</c>.</summary>
internal sealed class FmtSettings : CommandSettings
{
    [CommandArgument(0, "<path>")]
    [Description("The .koi file or directory to format.")]
    public string Path { get; init; } = "";

    [CommandOption("--check")]
    [Description("Do not write; exit non-zero if any file is unformatted or unparseable.")]
    public bool Check { get; init; }
}

/// <summary>Canonically formats .koi source (R17.3).</summary>
internal sealed class FmtCommand : Command<FmtSettings>
{
    protected override int Execute(CommandContext context, FmtSettings settings, CancellationToken cancellationToken)
    {
        if (!SourceLoader.TryReadSources(settings.Path, "file", out var sources, out var exitCode))
        {
            return exitCode;
        }

        var compiler = new KoineCompiler();
        var formatter = new KoineFormatter();
        var changed = 0;
        var unparseable = 0;

        foreach (var source in sources)
        {
            // fmt only adjusts whitespace; it cannot fix syntax. Report files that fail to
            // parse (with a file:line message) and leave them untouched.
            var (model, diagnostics) = compiler.Parse(source.Source, source.Path);
            if (model is null)
            {
                unparseable++;
                DiagnosticPrinter.PrintErrors(diagnostics, source.Path);
                Console.Error.WriteLine($"{source.Path}: cannot format (does not parse) — fix the syntax, then re-run");
                continue;
            }

            var result = formatter.Format(source.Source);
            if (!result.Changed)
            {
                continue;
            }

            changed++;

            if (settings.Check)
            {
                // --check never writes; it reports each unformatted file and exits non-zero.
                Console.Error.WriteLine($"{source.Path}: not formatted");
            }
            else
            {
                File.WriteAllText(source.Path, result.Text);
                Console.WriteLine($"formatted {source.Path}");
            }
        }

        // Unparseable files always fail (in both --check and write modes): fmt cannot
        // canonically format what it cannot parse.
        if (unparseable > 0)
        {
            Console.Error.WriteLine($"error: {unparseable} file(s) could not be parsed (fmt does not fix unparseable files)");
            return 1;
        }

        if (settings.Check)
        {
            if (changed > 0)
            {
                Console.Error.WriteLine($"error: {changed} file(s) need formatting (run `koine fmt`)");
                return 1;
            }

            Console.WriteLine($"OK: {sources.Count} file(s) already formatted");
            return 0;
        }

        Console.WriteLine(changed == 0
            ? $"OK: {sources.Count} file(s) already formatted"
            : $"formatted {changed} of {sources.Count} file(s)");
        return 0;
    }
}
