namespace Koine.Cli;

/// <summary>
/// Per-target emitter options (R16.1) parsed from a <c>targets.&lt;name&gt;.*</c> block in
/// <c>koine.config</c>. <see cref="OutDir"/> overrides the flat <c>out</c> for that target;
/// <see cref="NamespaceMap"/> remaps a context name to an emitted namespace (e.g.
/// <c>Catalog → Acme.Catalog</c>); <see cref="InstantMode"/>/<see cref="Layout"/> are forward
/// keys the emitters consume as they gain support. Absent keys are <c>null</c>/empty so a
/// target with no block behaves exactly as before.
/// </summary>
internal sealed record TargetOptions(
    string? OutDir,
    IReadOnlyDictionary<string, string> NamespaceMap,
    string? InstantMode,
    string? Layout)
{
    public static readonly TargetOptions Empty =
        new(null, new Dictionary<string, string>(StringComparer.Ordinal), null, null);
}

/// <summary>
/// <c>koine.config</c> reader (R17.3 + R16.1): supplies defaults for the
/// <c>build</c>/<c>watch</c> CLI flags when a flag is omitted. The flat keys <c>target</c>,
/// <c>out</c>, and <c>baseline</c> are recognized, plus the structured per-target block
/// <c>targets.&lt;name&gt;.{out,instantMode,layout}</c> and <c>targets.&lt;name&gt;.namespaces.&lt;Context&gt;</c>
/// (R16.1). Any other key is ignored, keeping the file forward-compatible.
/// Lines are <c>key = value</c>; <c>#</c> starts a comment.
/// </summary>
internal sealed record KoineConfig(
    string? Target,
    string? OutDir,
    string? Baseline = null,
    IReadOnlyDictionary<string, TargetOptions>? Targets = null,
    IReadOnlyDictionary<string, string>? Severity = null,
    IReadOnlyDictionary<string, string>? DiagnosticSeverity = null,
    IReadOnlyList<string>? Analyzers = null)
{
    public static readonly KoineConfig Empty = new(null, null);

    /// <summary>The conventional config file name, looked up beside the build input.</summary>
    public const string FileName = "koine.config";

    /// <summary>The parsed options for <paramref name="target"/>, or <see cref="TargetOptions.Empty"/>.</summary>
    public TargetOptions OptionsFor(string target) =>
        Targets is not null && Targets.TryGetValue(target, out TargetOptions? opts) ? opts : TargetOptions.Empty;

    public static KoineConfig Parse(string text)
    {
        string? target = null;
        string? outDir = null;
        string? baseline = null;
        var targets = new Dictionary<string, TargetBuilder>(StringComparer.Ordinal);
        var severity = new Dictionary<string, string>(StringComparer.Ordinal);
        var diagnosticSeverity = new Dictionary<string, string>(StringComparer.Ordinal);
        List<string>? analyzers = null;

        foreach (var raw in text.Split('\n'))
        {
            var line = StripComment(raw).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var eq = line.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            var key = line[..eq].Trim();
            var value = line[(eq + 1)..].Trim();
            if (value.Length == 0)
            {
                continue;
            }

            switch (key)
            {
                case "target":
                    target = value;
                    break;
                case "out":
                    outDir = value;
                    break;
                case "baseline":
                    baseline = value;
                    break;
                case "analyzers":
                    // External semantic-analyzer plugin assemblies (issue #69): a comma-separated list
                    // of assembly paths, each loaded by AnalyzerLoader. Empty entries are dropped.
                    analyzers = value
                        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .ToList();
                    if (analyzers.Count == 0)
                    {
                        analyzers = null;
                    }

                    break;
                default:
                    // `targets.<name>.<rest>` (R16.1) and `check.severity.<CODE>` (issue #73);
                    // any other unknown key is ignored, keeping the file forward-compatible.
                    if (key.StartsWith("targets.", StringComparison.Ordinal))
                    {
                        ApplyTargetKey(targets, key, value);
                    }
                    else if (key.StartsWith("check.severity.", StringComparison.Ordinal))
                    {
                        var code = key["check.severity.".Length..];
                        if (code.Length > 0)
                        {
                            severity[code] = value;
                        }
                    }
                    else if (key.StartsWith("diagnostics.", StringComparison.Ordinal))
                    {
                        // `diagnostics.<CODE> = none|hidden|info|warning|error` — the build-time
                        // severity remap/suppression (issue #69), parallel to `check.severity.`
                        // which governs only the model-versioning `check` command.
                        var code = key["diagnostics.".Length..];
                        if (code.Length > 0)
                        {
                            diagnosticSeverity[code] = value;
                        }
                    }

                    break;
            }
        }

        IReadOnlyDictionary<string, TargetOptions>? built = targets.Count == 0
            ? null
            : targets.ToDictionary(kv => kv.Key, kv => kv.Value.Build(), StringComparer.Ordinal);
        IReadOnlyDictionary<string, string>? severityMap = severity.Count == 0 ? null : severity;
        IReadOnlyDictionary<string, string>? diagnosticSeverityMap = diagnosticSeverity.Count == 0 ? null : diagnosticSeverity;
        return new KoineConfig(target, outDir, baseline, built, severityMap, diagnosticSeverityMap, analyzers);
    }

    /// <summary>
    /// Applies one <c>targets.&lt;name&gt;.&lt;rest&gt;</c> key. Recognized <c>rest</c>: <c>out</c>,
    /// <c>instantMode</c>, <c>layout</c>, and <c>namespaces.&lt;Context&gt;</c>. Malformed/partial
    /// keys are ignored (forward-compatible).
    /// </summary>
    private static void ApplyTargetKey(Dictionary<string, TargetBuilder> targets, string key, string value)
    {
        var parts = key.Split('.');
        if (parts.Length < 3)
        {
            return; // need at least targets.<name>.<rest>
        }

        var name = parts[1];
        if (name.Length == 0)
        {
            return;
        }

        if (!targets.TryGetValue(name, out TargetBuilder? builder))
        {
            builder = new TargetBuilder();
            targets[name] = builder;
        }

        switch (parts[2])
        {
            case "out" when parts.Length == 3:
                builder.OutDir = value;
                break;
            case "instantMode" when parts.Length == 3:
                builder.InstantMode = value;
                break;
            case "layout" when parts.Length == 3:
                builder.Layout = value;
                break;
            case "namespaces" when parts.Length == 4 && parts[3].Length > 0:
                builder.NamespaceMap[parts[3]] = value;
                break;
        }
    }

    /// <summary>
    /// Loads the config beside <paramref name="inputPath"/> (its directory, or the
    /// directory itself when it is one), falling back to the current directory, or
    /// <see cref="Empty"/> if none is found.
    /// </summary>
    public static KoineConfig Discover(string inputPath)
    {
        foreach (var dir in CandidateDirs(inputPath))
        {
            var path = Path.Combine(dir, FileName);
            if (File.Exists(path))
            {
                return Parse(File.ReadAllText(path));
            }
        }
        return Empty;
    }

    private static IEnumerable<string> CandidateDirs(string inputPath)
    {
        var inputDir = Directory.Exists(inputPath) ? inputPath : Path.GetDirectoryName(inputPath);
        if (!string.IsNullOrEmpty(inputDir))
        {
            yield return inputDir;
        }

        yield return Directory.GetCurrentDirectory();
    }

    private static string StripComment(string line)
    {
        var hash = line.IndexOf('#');
        return hash < 0 ? line : line[..hash];
    }

    /// <summary>Mutable accumulator for one target's keys during parsing.</summary>
    private sealed class TargetBuilder
    {
        public string? OutDir;
        public string? InstantMode;
        public string? Layout;
        public readonly Dictionary<string, string> NamespaceMap = new(StringComparer.Ordinal);

        public TargetOptions Build() => new(OutDir, NamespaceMap, InstantMode, Layout);
    }
}
