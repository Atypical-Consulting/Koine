using System.ComponentModel;
using Koine.Cli.Infrastructure;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
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

        // A koine.config (explicit --config, or discovered beside the input) supplies the default
        // baseline (for symmetry with build/watch — an explicit --baseline wins) AND the per-rule
        // severity policy (issue #73): `check.severity.<CODE> = Breaking|NonBreaking|Ignored`.
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

        var baseline = settings.Baseline ?? config.Baseline;

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
        var changes = ApplySeverity(report.Changes, config.Severity);

        foreach (var change in changes)
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

        var breakingCount = changes.Count(c => c.Impact == CompatibilityImpact.Breaking);
        if (breakingCount > 0)
        {
            Console.Error.WriteLine($"error: {breakingCount} breaking change(s) to published surfaces");
            return 1;
        }

        Console.WriteLine("OK: no breaking changes to published surfaces");
        return 0;
    }

    /// <summary>
    /// Applies the per-rule severity policy (issue #73): a change whose <see cref="CompatibilityChange.Code"/>
    /// maps to <c>Ignored</c> is dropped from the report, <c>NonBreaking</c> is downgraded (so it no longer
    /// trips the gate), and <c>Breaking</c> is upgraded. Codes with no override keep their default impact.
    /// </summary>
    private static IReadOnlyList<CompatibilityChange> ApplySeverity(
        IReadOnlyList<CompatibilityChange> changes, IReadOnlyDictionary<string, string>? severity)
    {
        if (severity is null || severity.Count == 0)
        {
            return changes;
        }

        var result = new List<CompatibilityChange>(changes.Count);
        foreach (var change in changes)
        {
            if (!severity.TryGetValue(change.Code, out var level))
            {
                result.Add(change);
                continue;
            }

            switch (level.Trim().ToLowerInvariant())
            {
                case "ignored":
                    break; // dropped from the report
                case "nonbreaking":
                    result.Add(change with { Impact = CompatibilityImpact.NonBreaking });
                    break;
                case "breaking":
                    result.Add(change with { Impact = CompatibilityImpact.Breaking });
                    break;
                default:
                    result.Add(change); // unrecognized level: leave the change unchanged
                    break;
            }
        }

        return result;
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
        // Parsing is now error-tolerant and returns a partial model even for broken input, so a
        // null check alone no longer detects a failed parse: a syntax error must still fail the
        // compatibility check rather than feed a half-recovered model into the comparison.
        if (parsed is null || diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            DiagnosticPrinter.Print(diagnostics, sources, path);
            Console.Error.WriteLine($"error: {label} model failed to parse");
            return false;
        }

        model = parsed;
        return true;
    }
}
