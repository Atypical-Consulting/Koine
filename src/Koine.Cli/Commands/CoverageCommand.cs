using System.ComponentModel;
using Koine.Cli.Infrastructure;
using Koine.Compiler.Ast;
using Koine.Compiler.Services;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>Flags for <c>coverage</c>.</summary>
internal sealed class CoverageSettings : CommandSettings
{
    [CommandArgument(0, "<path>")]
    [Description("The .koi file or directory to compile (a directory is compiled as one model).")]
    public string Path { get; init; } = "";

    [CommandOption("--target <TARGET>")]
    [Description("Output target to measure coverage against: csharp (default), typescript, python, php, rust.")]
    public string? Target { get; init; }

    [CommandOption("--json")]
    [Description("Emit the report as stable JSON instead of the human-readable summary.")]
    public bool Json { get; init; }

    [CommandOption("--config <FILE>")]
    [Description("Read defaults (target) from this koine.config instead of discovering one.")]
    public string? Config { get; init; }
}

/// <summary>
/// Reports which of a model's declared types the chosen target actually emitted (R18). Compiles the
/// model exactly like <c>build</c> (config-resolved target, single file or directory), then walks the
/// emitted files with <see cref="ModelCoverage"/>. Exits 1 when any declared type is uncovered, so it
/// doubles as a CI gate; <c>--json</c> swaps the human summary for the stable machine report.
/// </summary>
internal sealed class CoverageCommand : Command<CoverageSettings>
{
    protected override int Execute(CommandContext context, CoverageSettings settings, CancellationToken cancellationToken)
    {
        // Resolve the target against a koine.config (explicit --config, or one discovered beside the
        // input) — an explicit --target wins, defaulting to csharp. The same resolution build/check use,
        // minus the --out concern.
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
            config = KoineConfig.Discover(settings.Path);
        }

        var resolvedTarget = settings.Target ?? config.Target ?? "csharp";
        var targetOptions = config.OptionsFor(resolvedTarget);

        if (!EmitterRegistry.TryCreate(resolvedTarget, targetOptions, config.Emitters, out var emitter))
        {
            return CliError.Runtime($"unsupported target '{resolvedTarget}' (supported: {EmitterRegistry.SupportedList})");
        }

        // A path may be a single .koi file or a directory of them (compiled as one model).
        if (!SourceLoader.TryReadSources(settings.Path, "file", out var sources, out var exitCode))
        {
            return exitCode;
        }

        var externalAnalyzers = Compiler.Semantics.AnalyzerLoader.Load(config.Analyzers);
        var compiler = new KoineCompiler(externalAnalyzers);
        var filterOptions = new Compiler.Diagnostics.DiagnosticFilterOptions(config.DiagnosticSeverity, WarningsAsErrors: false);
        var result = compiler.Compile(sources, emitter, filterOptions);

        if (DiagnosticPrinter.Print(result.Diagnostics, sources, settings.Path) || result.Model is null)
        {
            return 1;
        }

        var report = ModelCoverage.Compute(result.Model, result.Files, resolvedTarget);
        Console.WriteLine(settings.Json ? ModelCoverage.ToJson(report) : ModelCoverage.RenderText(report));

        return report.IsComplete ? 0 : 1;
    }
}
