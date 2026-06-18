using System.ComponentModel;
using Koine.Cli.Infrastructure;
using Koine.Compiler.Ast;
using Koine.Compiler.Services;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>Flags for <c>check</c>.</summary>
internal sealed class CheckSettings : CommandSettings
{
    [CommandArgument(0, "<path>")]
    [Description("The current model (.koi file or directory) to compare against the baseline.")]
    public string Path { get; init; } = "";

    [CommandOption("--baseline <DIR>")]
    [Description("The previously published model to compare against (or a `baseline` key in koine.config).")]
    public string? Baseline { get; init; }

    [CommandOption("--config <FILE>")]
    [Description("Read defaults from this koine.config instead of discovering one.")]
    public string? Config { get; init; }
}

/// <summary>
/// Backward-compatibility check (R15.2): compares the current model against a previously
/// published baseline and flags breaking changes to published surfaces. Exits non-zero if
/// any breaking change is found (or either model fails to parse), zero otherwise.
/// </summary>
internal sealed class CheckCommand : Command<CheckSettings>
{
    protected override int Execute(CommandContext context, CheckSettings settings, CancellationToken cancellationToken)
    {
        var current = settings.Path;

        // A koine.config (explicit --config, or discovered beside the input) may supply the
        // default baseline, for symmetry with build/watch — an explicit --baseline wins.
        var baseline = settings.Baseline;
        if (baseline is null)
        {
            KoineConfig config;
            if (settings.Config is not null)
            {
                if (!File.Exists(settings.Config))
                {
                    return CliError.Runtime($"config not found: {settings.Config}");
                }

                config = KoineConfig.Parse(File.ReadAllText(settings.Config));
            }
            else
            {
                config = KoineConfig.Discover(current);
            }

            baseline = config.Baseline;
        }

        if (baseline is null)
        {
            return CliError.Runtime(
                "check requires --baseline <dir> (or a `baseline` key in koine.config)");
        }

        var compiler = new KoineCompiler();
        if (!TryParseModel(compiler, current, "current", out var currentModel) ||
            !TryParseModel(compiler, baseline, "baseline", out var baselineModel))
        {
            return 1;
        }

        var report = new CompatibilityChecker().Check(baselineModel, currentModel);

        foreach (var change in report.Changes)
        {
            if (change.Impact == CompatibilityImpact.Breaking)
            {
                Console.Error.WriteLine($"breaking {change.Code}: {change.Message}");
            }
            else
            {
                Console.WriteLine($"non-breaking: {change.Message}");
            }
        }

        if (report.HasBreakingChanges)
        {
            var count = report.Changes.Count(c => c.Impact == CompatibilityImpact.Breaking);
            Console.Error.WriteLine($"error: {count} breaking change(s) to published surfaces");
            return 1;
        }

        Console.WriteLine("OK: no breaking changes to published surfaces");
        return 0;
    }

    /// <summary>Reads and parses a model from a path, reporting any syntax errors against <paramref name="label"/>.</summary>
    private static bool TryParseModel(KoineCompiler compiler, string path, string label, out KoineModel model)
    {
        model = null!;

        if (!SourceLoader.TryReadSources(path, label, out var sources, out _))
        {
            return false;
        }

        var (parsed, diagnostics) = compiler.Parse(sources);
        if (parsed is null)
        {
            DiagnosticPrinter.Print(diagnostics, sources, path);
            Console.Error.WriteLine($"error: {label} model failed to parse");
            return false;
        }

        model = parsed;
        return true;
    }
}
