using System.ComponentModel;
using Koine.Cli.Infrastructure;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Services;
using Spectre.Console.Cli;

namespace Koine.Cli.Commands;

/// <summary>Flags for <c>build</c> (and, via <see cref="WatchSettings"/>, <c>watch</c>).</summary>
internal class BuildSettings : CommandSettings
{
    [CommandArgument(0, "<path>")]
    [Description("The .koi file or directory to compile (a directory is compiled as one model).")]
    public string Path { get; init; } = "";

    [CommandOption("--target <TARGET>")]
    [Description("Output target: csharp (default), typescript, python, php, rust, glossary, or docs.")]
    public string? Target { get; init; }

    [CommandOption("--out <DIR>")]
    [Description("Directory to write generated files into; omit to only parse/validate.")]
    public string? Out { get; init; }

    [CommandOption("--glossary <FILE>")]
    [Description("Also write a Markdown glossary to this file (independent of --target).")]
    public string? Glossary { get; init; }

    [CommandOption("--docs <DIR>")]
    [Description("Also write living documentation (Mermaid-in-Markdown) to this directory (independent of --target).")]
    public string? Docs { get; init; }

    [CommandOption("--config <FILE>")]
    [Description("Read defaults (target/out) from this koine.config instead of discovering one.")]
    public string? Config { get; init; }

    [CommandOption("--warnings-as-errors")]
    [Description("Promote every warning to an error (after any diagnostics.<CODE> config override).")]
    public bool WarningsAsErrors { get; init; }

    [CommandOption("--source-maps")]
    [Description("Emit source-map debug info linking generated code back to the .koi source (C# #line directives; TypeScript *.ts.map sidecars).")]
    public bool SourceMaps { get; init; }

    [CommandOption("--reference-only")]
    [Description("Emit a reference-assembly-style contract surface: all type/member signatures, interfaces and contracts, with implementation bodies stripped to stubs.")]
    public bool ReferenceOnly { get; init; }

    [CommandOption("--layers <LAYERS>")]
    [Description("Comma-separated C# layers to emit (issue #128): domain (default), infrastructure. infrastructure implies domain.")]
    public string? Layers { get; init; }

    /// <summary>
    /// Resolves the flags against a <c>koine.config</c> (explicit <c>--config</c>, or one
    /// discovered beside the input): an explicit flag wins, then <c>targets.&lt;t&gt;.out</c>,
    /// then the flat <c>out</c>; <c>--target</c> defaults to <c>csharp</c> (R16.1). Returns
    /// <c>false</c> with an <paramref name="error"/> when an explicit <c>--config</c> is missing.
    /// </summary>
    public bool TryResolve(out BuildPlan plan, out string? error)
    {
        plan = default;
        error = null;

        KoineConfig config;
        if (Config is not null)
        {
            if (!File.Exists(Config))
            {
                error = $"config not found: {Config}";
                return false;
            }

            config = KoineConfig.Parse(File.ReadAllText(Config));
        }
        else
        {
            config = KoineConfig.Discover(Path);
        }

        var resolvedTarget = Target ?? config.Target ?? "csharp";
        var targetOptions = config.OptionsFor(resolvedTarget);
        var resolvedOut = Out ?? targetOptions.OutDir ?? config.OutDir;

        // The C# layer selector (issue #128): an explicit --layers wins over targets.<t>.layers
        // (same precedence as --target/--out). Unknown names are a hard error; infrastructure
        // always implies domain. Absent ⇒ null ⇒ Domain-only (byte-identical to today).
        if (!TryResolveLayers(Layers, targetOptions.Layers, out var resolvedLayers, out error))
        {
            return false;
        }

        targetOptions = targetOptions with { Layers = resolvedLayers };
        plan = new BuildPlan(
            Path, resolvedTarget, resolvedOut, Glossary, Docs, targetOptions,
            config.DiagnosticSeverity, WarningsAsErrors, config.Analyzers, config.Emitters, SourceMaps, ReferenceOnly);
        return true;
    }

    /// <summary>The C# layers a user may request (issue #128).</summary>
    private static readonly IReadOnlySet<string> ValidLayers =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "domain", "infrastructure" };

    /// <summary>
    /// Resolves the layer selector: the explicit <c>--layers</c> flag wins over the config's
    /// <c>targets.&lt;t&gt;.layers</c>. Each name must be a <see cref="ValidLayers"/> member
    /// (case-insensitive) or it is a hard error; <c>infrastructure</c> always implies <c>domain</c>.
    /// The result is normalized to the canonical lower-case names in stable order
    /// (<c>domain</c> first), or <c>null</c> when no layers were requested anywhere (⇒ Domain-only).
    /// </summary>
    private static bool TryResolveLayers(string? flag, IReadOnlyList<string>? fromConfig, out IReadOnlyList<string>? resolved, out string? error)
    {
        resolved = null;
        error = null;

        IEnumerable<string>? requested = flag is not null
            ? flag.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            : fromConfig;
        if (requested is null)
        {
            return true; // nothing requested anywhere ⇒ Domain-only default
        }

        var wantsInfrastructure = false;
        foreach (var name in requested)
        {
            if (!ValidLayers.Contains(name))
            {
                error = $"unknown layer '{name}' (valid layers: domain, infrastructure)";
                return false;
            }

            if (string.Equals(name, "infrastructure", StringComparison.OrdinalIgnoreCase))
            {
                wantsInfrastructure = true;
            }
        }

        // domain is always present (infrastructure implies it); list it first for stable output.
        var layers = new List<string> { "domain" };
        if (wantsInfrastructure)
        {
            layers.Add("infrastructure");
        }

        resolved = layers;
        return true;
    }
}

/// <summary>Compiles a .koi model and (optionally) emits code.</summary>
internal sealed class BuildCommand : Command<BuildSettings>
{
    protected override int Execute(CommandContext context, BuildSettings settings, CancellationToken cancellationToken)
    {
        if (!settings.TryResolve(out var plan, out var error))
        {
            return CliError.Runtime(error!);
        }

        return BuildOnce(plan);
    }

    /// <summary>
    /// Runs one build for <paramref name="r"/>, printing diagnostics and progress, and returns
    /// the exit code (0 success, 1 failure). Shared by <c>build</c> (once) and <c>watch</c> (per change).
    /// </summary>
    public static int BuildOnce(BuildPlan r)
    {
        // External emitter providers from the `emitters` config key (issue #69) resolve alongside the
        // built-ins; no key → built-ins only → behavior identical to before.
        if (!EmitterRegistry.TryCreate(r.Target, r.Options, r.Emitters, r.SourceMaps, r.ReferenceOnly, out var emitter))
        {
            return CliError.Runtime($"unsupported target '{r.Target}' (supported: {EmitterRegistry.SupportedList})");
        }

        // A path may be a single .koi file or a directory of them (compiled as one model).
        if (!SourceLoader.TryReadSources(r.File, "file", out var sources, out var exitCode))
        {
            return exitCode;
        }

        // External semantic analyzers from the `analyzers` config key (issue #69), loaded once and
        // appended after the built-ins. No key → zero externals → behavior identical to before.
        var externalAnalyzers = Koine.Compiler.Semantics.AnalyzerLoader.Load(r.Analyzers);
        var compiler = new KoineCompiler(externalAnalyzers);
        var filterOptions = new Koine.Compiler.Diagnostics.DiagnosticFilterOptions(r.DiagnosticSeverity, r.WarningsAsErrors);
        var result = compiler.Compile(sources, emitter, filterOptions);

        // Diagnostics print plain (MSBuild/Roslyn-parseable) when redirected, pretty in a terminal.
        if (DiagnosticPrinter.Print(result.Diagnostics, sources, r.File))
        {
            return 1;
        }

        // --glossary writes a Markdown glossary to a specific file, independent of
        // the chosen --target/--out (so you can emit C# AND a glossary in one run).
        if (r.GlossaryFile is not null && result.Model is not null)
        {
            var glossary = new GlossaryEmitter().Emit(result.Model)[0];
            var dir = System.IO.Path.GetDirectoryName(r.GlossaryFile);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            OutputWriter.WriteFileAtomic(r.GlossaryFile, glossary.Contents);
            Console.WriteLine($"wrote glossary to {r.GlossaryFile}");
        }

        // --docs writes living documentation (Mermaid-in-Markdown) to a directory, independent of
        // the chosen --target/--out (so you can emit C# AND living docs in one run).
        if (r.DocsDir is not null && result.Model is not null)
        {
            var docs = new DocsEmitter().Emit(result.Model);
            var docsCount = OutputWriter.WriteOutputAtomic(r.DocsDir, docs);
            Console.WriteLine($"wrote {docsCount} doc files to {r.DocsDir}");
        }

        if (r.OutDir is null)
        {
            if (r.GlossaryFile is null && r.DocsDir is null)
            {
                Console.WriteLine($"OK: {r.File} parsed and validated");
            }

            return 0;
        }

        var count = OutputWriter.WriteOutputAtomic(r.OutDir, result.Files);
        Console.WriteLine($"wrote {count} files to {r.OutDir}");
        return 0;
    }
}
