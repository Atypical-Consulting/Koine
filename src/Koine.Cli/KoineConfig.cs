namespace Koine.Cli;

/// <summary>
/// Per-target emitter options (R16.1) parsed from a <c>targets.&lt;name&gt;.*</c> block in
/// <c>koine.config</c>. <see cref="OutDir"/> overrides the flat <c>out</c> for that target;
/// <see cref="NamespaceMap"/> remaps a context name to an emitted namespace (e.g.
/// <c>Catalog → Acme.Catalog</c>); <see cref="InstantMode"/>/<see cref="Layout"/> are forward
/// keys the emitters consume as they gain support. <see cref="RegexMatchTimeoutMsText"/> is the raw
/// <c>regexMatchTimeoutMs</c> value (issue #794/#641); <see cref="RegexMatchTimeoutMs"/> parses it to
/// the C# <c>matches</c>-invariant ReDoS-guard match timeout in milliseconds (<c>null</c> ⇒ unset or
/// non-integer ⇒ the emitter's <c>1000</c> ms default). <see cref="RegexModeText"/> is the raw
/// <c>regexMode</c> value (issue #831): one of <c>inline</c> | <c>sourceGenerated</c>
/// (case-insensitive); <c>null</c> ⇒ the emitter's <c>inline</c> default. Absent keys are
/// <c>null</c>/empty so a target with no block behaves exactly as before.
/// </summary>
internal sealed record TargetOptions(
    string? OutDir,
    IReadOnlyDictionary<string, string> NamespaceMap,
    string? InstantMode,
    string? Layout,
    IReadOnlyList<string>? Layers = null,
    bool ApplicationMediatr = false,
    string? ApplicationMapping = null,
    string? RegexMatchTimeoutMsText = null,
    string? RegexModeText = null,
    string? ApplicationHandlerResult = null,
    string? ApplicationNotFound = null)
{
    public static readonly TargetOptions Empty =
        new(null, new Dictionary<string, string>(StringComparer.Ordinal), null, null);

    /// <summary>
    /// The parsed C# match-timeout budget in milliseconds (issue #794/#641), or <c>null</c> when the
    /// <c>regexMatchTimeoutMs</c> key is unset <em>or</em> not a valid integer. The raw text is kept on
    /// <see cref="RegexMatchTimeoutMsText"/> so <see cref="TryValidate"/> can tell a present-but-invalid
    /// value (a hard error) apart from an absent one (which keeps the emitter's default).
    /// </summary>
    public int? RegexMatchTimeoutMs => KoineConfig.ParseTimeout(RegexMatchTimeoutMsText);

    /// <summary>
    /// Validates the user-supplied per-target options the emitter cannot recover from (issues #794, #831):
    /// a present <c>regexMatchTimeoutMs</c> must parse to a <em>positive</em> integer — a non-integer
    /// would silently disarm the ReDoS guard (falling back to 1000 ms), and a non-positive value would
    /// flow into the generated <c>TimeSpan.FromMilliseconds(N)</c> and throw at the generated code's own
    /// runtime; a present <c>regexMode</c> must be <c>inline</c> or <c>sourceGenerated</c>
    /// (case-insensitive) — any other value (e.g. a typo like <c>sourcegen</c>) is a hard error so it
    /// cannot silently disarm an explicit opt-in. Returns <c>false</c> with a friendly
    /// <paramref name="error"/>. Every config-driven emitter entry point (<c>build</c>, <c>coverage</c>,
    /// the LSP <c>emitPreview</c>) runs this before constructing the C# emitter, so they all reject the
    /// same bad config identically rather than letting the emitter's last-resort guard throw.
    /// </summary>
    public bool TryValidate(out string? error)
    {
        error = null;
        if (RegexMatchTimeoutMsText is { } raw && (RegexMatchTimeoutMs is not { } ms || ms <= 0))
        {
            error = $"regexMatchTimeoutMs must be a positive integer (milliseconds); got '{raw}'";
            return false;
        }

        if (RegexModeText is { } mode &&
            !string.Equals(mode, "inline", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(mode, "sourceGenerated", StringComparison.OrdinalIgnoreCase))
        {
            error = $"regexMode must be 'inline' or 'sourceGenerated'; got '{mode}'";
            return false;
        }

        return true;
    }
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
    IReadOnlyList<string>? Analyzers = null,
    IReadOnlyList<string>? Emitters = null)
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
        // Case-insensitive: diagnostic codes are conventionally upper-case (KOI0311), but a user who
        // writes `diagnostics.koi0311 = error` should not be silently ignored — and the in-source
        // `// koine:disable` directive already matches codes case-insensitively, so match here too.
        var diagnosticSeverity = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        List<string>? analyzers = null;
        List<string>? emitters = null;

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
                case "emitters":
                    // External emitter-provider plugin assemblies (issue #69): a comma-separated list
                    // of assembly paths, each loaded by EmitterLoader. Empty entries are dropped.
                    emitters = value
                        .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .ToList();
                    if (emitters.Count == 0)
                    {
                        emitters = null;
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
        return new KoineConfig(target, outDir, baseline, built, severityMap, diagnosticSeverityMap, analyzers, emitters);
    }

    /// <summary>
    /// Applies one <c>targets.&lt;name&gt;.&lt;rest&gt;</c> key. Recognized <c>rest</c>: <c>out</c>,
    /// <c>instantMode</c>, <c>layout</c>, <c>layers</c>, <c>application.{mediatr,mapping}</c>,
    /// <c>regexMatchTimeoutMs</c>, <c>regexMode</c>, and <c>namespaces.&lt;Context&gt;</c>.
    /// Malformed/partial keys are ignored (forward-compatible).
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
            case "layers" when parts.Length == 3:
                // Composable output layers: comma-separated, case-insensitive (e.g.
                // `domain,application,infrastructure`; issues #128/#129). Parsed into a list at Build().
                builder.Layers = value;
                break;
            case "application" when parts.Length == 4 && parts[3] == "mediatr":
                builder.ApplicationMediatr = value;
                break;
            case "application" when parts.Length == 4 && parts[3] == "mapping":
                builder.ApplicationMapping = value;
                break;
            case "application" when parts.Length == 4 && parts[3] == "handlerResult":
                // W1 (make the Application layer adoptable): what a command handler returns —
                // void (default) or aggregate. Validated in BuildSettings.TryResolve.
                builder.ApplicationHandlerResult = value;
                break;
            case "application" when parts.Length == 4 && parts[3] == "notFound":
                // W1: how a handler treats a missing aggregate — throw (default) or nullable.
                // Validated in BuildSettings.TryResolve.
                builder.ApplicationNotFound = value;
                break;
            case "regexMatchTimeoutMs" when parts.Length == 3:
                // The C# matches-invariant ReDoS-guard match timeout (issue #794/#641): stored raw and
                // parsed lazily by TargetOptions.RegexMatchTimeoutMs. Unlike other malformed keys this is
                // NOT silently ignored — a present-but-invalid value (non-integer or non-positive) is a
                // hard error via TargetOptions.TryValidate, since silently keeping 1000 ms would disarm a
                // hardening knob the user explicitly set.
                builder.RegexMatchTimeoutMs = value;
                break;
            case "regexMode" when parts.Length == 3:
                // The C# matches-invariant regex-evaluation mode (issue #831): stored raw and validated
                // by TargetOptions.TryValidate (inline | sourceGenerated, case-insensitive). A
                // present-but-unknown value is a hard error — a typo must not silently disarm the
                // explicit opt-in to the [GeneratedRegex] form.
                builder.RegexMode = value;
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
        public string? Layers;
        public string? ApplicationMediatr;
        public string? ApplicationMapping;
        public string? ApplicationHandlerResult;
        public string? ApplicationNotFound;
        public string? RegexMatchTimeoutMs;
        public string? RegexMode;
        public readonly Dictionary<string, string> NamespaceMap = new(StringComparer.Ordinal);

        public TargetOptions Build() => new(
            OutDir, NamespaceMap, InstantMode, Layout,
            ParseLayers(Layers),
            string.Equals(ApplicationMediatr, "true", StringComparison.OrdinalIgnoreCase),
            ApplicationMapping,
            RegexMatchTimeoutMs,
            RegexMode,
            ApplicationHandlerResult,
            ApplicationNotFound);
    }

    /// <summary>
    /// Parses the raw <c>regexMatchTimeoutMs</c> value to an <c>int?</c> (issue #794). A non-integer
    /// parses to <c>null</c>; the caller (<see cref="TargetOptions.TryValidate"/>) distinguishes a
    /// present-but-unparseable value from an absent one by also inspecting the raw text.
    /// </summary>
    internal static int? ParseTimeout(string? value) =>
        int.TryParse(value, out var ms) ? ms : null;

    /// <summary>
    /// Splits a comma-separated <c>layers</c> value into a normalized list (trimmed, lower-cased,
    /// empty entries dropped). <c>null</c>/blank → <c>null</c> (the default domain-only output).
    /// </summary>
    internal static IReadOnlyList<string>? ParseLayers(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var layers = value
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(l => l.ToLowerInvariant())
            .ToList();
        return layers.Count == 0 ? null : layers;
    }
}
