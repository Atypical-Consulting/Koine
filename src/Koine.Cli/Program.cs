using System.Collections.Concurrent;
using System.Reflection;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Services;

namespace Koine.Cli;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length == 0)
        {
            PrintUsage();
            return 1;
        }

        return args[0] switch
        {
            "--version" or "-v" => RunVersion(),
            "build" => RunBuild(args.Skip(1).ToArray()),
            "check" => RunCheck(args.Skip(1).ToArray()),
            "fmt" => RunFmt(args.Skip(1).ToArray()),
            "init" => RunInit(args.Skip(1).ToArray()),
            "watch" => RunWatch(args.Skip(1).ToArray()),
            "lsp" => LspServer.Run(),
            "--help" or "-h" or "help" => PrintUsageTo(Console.Out),
            _ => UnknownCommand(args[0]),
        };
    }

    private static int RunVersion()
    {
        var version = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";
        Console.WriteLine(version);
        return 0;
    }

    private static int UnknownCommand(string command)
    {
        Console.Error.WriteLine($"error: unknown command '{command}'");
        PrintUsage();
        return 1;
    }

    /// <summary>A parsed, config-resolved build invocation, shared by <c>build</c> and <c>watch</c>.</summary>
    private readonly record struct BuildRequest(string File, string Target, string? OutDir, string? GlossaryFile);

    /// <summary>
    /// Parses the flags common to <c>build</c> and <c>watch</c> (<c>--target</c>,
    /// <c>--out</c>, <c>--glossary</c>, <c>--config</c>) and the positional input path,
    /// then fills any omitted <c>--target</c>/<c>--out</c> from a <c>koine.config</c>.
    /// </summary>
    private static bool TryParseBuild(string[] args, out BuildRequest request, out string? error)
    {
        request = default;
        error = null;

        string? file = null;
        string? target = null;
        string? outDir = null;
        string? glossaryFile = null;
        string? configPath = null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            switch (arg)
            {
                case "--target":
                    if (i + 1 >= args.Length) { error = "--target requires a value"; return false; }
                    target = args[++i];
                    break;
                case "--out":
                    if (i + 1 >= args.Length) { error = "--out requires a value"; return false; }
                    outDir = args[++i];
                    break;
                case "--glossary":
                    if (i + 1 >= args.Length) { error = "--glossary requires a <file> value"; return false; }
                    glossaryFile = args[++i];
                    break;
                case "--config":
                    if (i + 1 >= args.Length) { error = "--config requires a <file> value"; return false; }
                    configPath = args[++i];
                    break;
                default:
                    if (arg.StartsWith('-')) { error = $"unknown option '{arg}'"; return false; }
                    if (file is not null) { error = $"unexpected argument '{arg}'"; return false; }
                    file = arg;
                    break;
            }
        }

        if (file is null) { error = "requires a <file.koi> or directory argument"; return false; }

        KoineConfig config;
        if (configPath is not null)
        {
            if (!File.Exists(configPath)) { error = $"config not found: {configPath}"; return false; }
            config = KoineConfig.Parse(File.ReadAllText(configPath));
        }
        else
        {
            config = KoineConfig.Discover(file);
        }

        request = new BuildRequest(file, target ?? config.Target ?? "csharp", outDir ?? config.OutDir, glossaryFile);
        return true;
    }

    private static int RunBuild(string[] args)
    {
        if (!TryParseBuild(args, out var request, out var error))
            return UsageError(error!);
        return BuildOnce(request) ? 0 : 1;
    }

    /// <summary>
    /// Runs one build for <paramref name="r"/>, printing diagnostics and progress, and
    /// returns whether it succeeded. Shared by <c>build</c> (once) and <c>watch</c> (per change).
    /// </summary>
    private static bool BuildOnce(BuildRequest r)
    {
        var file = r.File;
        var target = r.Target;
        var outDir = r.OutDir;
        var glossaryFile = r.GlossaryFile;

        IEmitter emitter = target.ToLowerInvariant() switch
        {
            "csharp" => new CSharpEmitter(),
            "glossary" => new GlossaryEmitter(),
            _ => null!
        };
        if (emitter is null)
        {
            Console.Error.WriteLine($"error: unsupported target '{target}' (supported: csharp, glossary)");
            return false;
        }

        // A path may be a single .koi file or a directory of them (compiled as one model).
        List<SourceFile> sources;
        try
        {
            sources = ReadSources(file);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            Console.Error.WriteLine($"error: file not found: {file}");
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"error: cannot read '{file}': {ex.Message}");
            return false;
        }

        if (sources.Count == 0)
        {
            Console.Error.WriteLine($"error: no .koi files found under '{file}'");
            return false;
        }

        var compiler = new KoineCompiler();
        var result = compiler.Compile(sources, emitter);

        var hasError = false;
        foreach (var diag in result.Diagnostics)
        {
            if (diag.Severity == DiagnosticSeverity.Error)
                hasError = true;
            // MSBuild/Roslyn-parseable: file:line:col: severity CODE: message
            var severity = diag.Severity.ToString().ToLowerInvariant();
            Console.Error.WriteLine($"{diag.File ?? file}:{diag.Line}:{diag.Column}: {severity} {diag.Code}: {diag.Message}");
        }

        if (hasError)
            return false;

        // --glossary writes a Markdown glossary to a specific file, independent of
        // the chosen --target/--out (so you can emit C# AND a glossary in one run).
        if (glossaryFile is not null && result.Model is not null)
        {
            var glossary = new GlossaryEmitter().Emit(result.Model)[0];
            var dir = Path.GetDirectoryName(glossaryFile);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllText(glossaryFile, glossary.Contents);
            Console.WriteLine($"wrote glossary to {glossaryFile}");
        }

        if (outDir is null)
        {
            if (glossaryFile is null)
                Console.WriteLine($"OK: {file} parsed and validated");
            return true;
        }

        // Remove previously generated output we own (top-level namespace folders),
        // so types renamed/removed since the last run don't leave stale orphans.
        var ownedRoots = result.Files
            .Select(f => f.RelativePath.Replace('\\', '/').Split('/')[0])
            .Distinct(StringComparer.Ordinal);
        foreach (var root in ownedRoots)
        {
            var dir = Path.Combine(outDir, root);
            if (Directory.Exists(dir))
                Directory.Delete(dir, recursive: true);
        }

        var count = 0;
        foreach (var emitted in result.Files)
        {
            var path = Path.Combine(outDir, emitted.RelativePath);
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllText(path, emitted.Contents);
            count++;
        }

        Console.WriteLine($"wrote {count} files to {outDir}");
        return true;
    }

    // ---- fmt (R17.3) -------------------------------------------------------

    private static int RunFmt(string[] args)
    {
        string? path = null;
        var check = false;

        foreach (var arg in args)
        {
            if (arg == "--check")
                check = true;
            else if (arg.StartsWith('-'))
                return UsageError($"unknown option '{arg}'");
            else if (path is not null)
                return UsageError($"unexpected argument '{arg}'");
            else
                path = arg;
        }

        if (path is null)
            return UsageError("fmt requires a <file.koi> or directory argument");

        List<SourceFile> sources;
        try
        {
            sources = ReadSources(path);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            Console.Error.WriteLine($"error: file not found: {path}");
            return 1;
        }

        if (sources.Count == 0)
        {
            Console.Error.WriteLine($"error: no .koi files found under '{path}'");
            return 1;
        }

        var formatter = new Koine.Compiler.Formatting.KoineFormatter();
        var changed = 0;

        foreach (var source in sources)
        {
            var result = formatter.Format(source.Source);
            if (!result.Changed)
                continue;
            changed++;

            if (check)
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

        if (check)
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

    // ---- init (R17.3) ------------------------------------------------------

    /// <summary>The starter domain model written by <c>koine init</c>. It must build end-to-end.</summary>
    internal const string ScaffoldModel =
        """
        /// The Catalog bounded context: the products available for sale.
        context Catalog {

          /// A monetary amount in a given currency. Amounts are never negative.
          value Money {
            amount:   Decimal
            currency: Currency
            invariant amount >= 0 "a monetary amount cannot be negative"
          }

          /// The currencies the catalog supports.
          enum Currency { EUR, USD, GBP }

          /// A product offered in the catalog, identified by a generated id.
          entity Product identified by ProductId {
            name:  String
            price: Money
          }
        }
        """ + "\n";

    /// <summary>A forward-compatible <c>koine.config</c>; only <c>target</c>/<c>out</c> are read today.</summary>
    internal const string ScaffoldConfig =
        """
        # koine.config — build defaults for this domain model (R17.3).
        # `koine build` / `koine watch` use these when the matching flag is omitted.

        target = csharp
        out = generated

        # Forward-compatible (R16, not yet implemented): structured per-target emitter
        # options such as namespace mapping, Instant handling, and output layout, e.g.
        #   targets.csharp = { namespaces = { Catalog = "Acme.Catalog" }, instantMode = dateTimeOffset, layout = filePerType }
        """ + "\n";

    private const string ScaffoldReadme =
        """
        # Koine domain model

        This project models a bounded context with [Koine](https://github.com/Atypical-Consulting/Koine).

        ## Build

        ```bash
        koine build domain.koi          # emits C# into ./generated (see koine.config)
        koine watch domain.koi          # re-emits on every save
        koine fmt domain.koi            # canonically formats the model
        ```

        Edit `domain.koi` to describe your own value objects, entities, aggregates,
        and the invariants that must always hold.
        """ + "\n";

    private static int RunInit(string[] args)
    {
        string? dir = null;
        var force = false;

        foreach (var arg in args)
        {
            if (arg == "--force")
                force = true;
            else if (arg.StartsWith('-'))
                return UsageError($"unknown option '{arg}'");
            else if (dir is not null)
                return UsageError($"unexpected argument '{arg}'");
            else
                dir = arg;
        }

        return InitProject(dir ?? ".", force, Console.Out, Console.Error) ? 0 : 1;
    }

    /// <summary>
    /// Scaffolds <c>domain.koi</c>, <c>koine.config</c>, and <c>README.md</c> in
    /// <paramref name="dir"/>. Refuses to overwrite any existing scaffold file unless
    /// <paramref name="force"/>. Returns whether the project was written.
    /// </summary>
    internal static bool InitProject(string dir, bool force, TextWriter stdout, TextWriter stderr)
    {
        var files = new (string Name, string Content)[]
        {
            ("domain.koi", ScaffoldModel),
            (KoineConfig.FileName, ScaffoldConfig),
            ("README.md", ScaffoldReadme),
        };

        Directory.CreateDirectory(dir);

        if (!force)
        {
            var existing = files
                .Where(f => File.Exists(Path.Combine(dir, f.Name)))
                .Select(f => f.Name)
                .ToList();
            if (existing.Count > 0)
            {
                stderr.WriteLine($"error: refusing to overwrite existing file(s): {string.Join(", ", existing)} (use --force)");
                return false;
            }
        }

        foreach (var (name, content) in files)
            File.WriteAllText(Path.Combine(dir, name), content);

        stdout.WriteLine($"initialized koine project in {dir}");
        stdout.WriteLine("  domain.koi     starter model");
        stdout.WriteLine("  koine.config   build defaults");
        stdout.WriteLine("  README.md      project notes");
        stdout.WriteLine($"next: koine build {Path.Combine(dir, "domain.koi")}");
        return true;
    }

    // ---- watch (R17.3) -----------------------------------------------------

    private static int RunWatch(string[] args)
    {
        if (!TryParseBuild(args, out var request, out var error))
            return UsageError(error!);

        // Watch the input's directory (or the directory itself), filtered to .koi files.
        var watchDir = Directory.Exists(request.File)
            ? request.File
            : Path.GetDirectoryName(Path.GetFullPath(request.File)) ?? ".";

        using var watcher = new FileSystemWatcher(watchDir, "*.koi")
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
        };

        var changes = new BlockingCollection<object>();
        void Bump() { try { changes.Add(new object()); } catch (InvalidOperationException) { } }
        watcher.Changed += (_, _) => Bump();
        watcher.Created += (_, _) => Bump();
        watcher.Deleted += (_, _) => Bump();
        watcher.Renamed += (_, _) => Bump();
        watcher.EnableRaisingEvents = true;

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;            // let the loop unwind cleanly instead of killing the process
            cts.Cancel();
            changes.CompleteAdding();
        };

        Console.WriteLine($"watching {watchDir} for *.koi changes — press Ctrl+C to stop");
        var session = new WatchSession(() => BuildOnce(request), Console.Out, TimeSpan.FromMilliseconds(250));
        session.Run(changes, cts.Token);
        return 0;
    }

    /// <summary>
    /// Backward-compatibility check (R15.2): compares the current model against a previously
    /// published baseline and flags breaking changes to published surfaces. Exits non-zero if
    /// any breaking change is found (or either model fails to parse), zero otherwise.
    /// </summary>
    private static int RunCheck(string[] args)
    {
        string? current = null;
        string? baseline = null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            switch (arg)
            {
                case "--baseline":
                    if (i + 1 >= args.Length)
                        return UsageError("--baseline requires a <dir> value");
                    baseline = args[++i];
                    break;
                default:
                    if (arg.StartsWith('-'))
                        return UsageError($"unknown option '{arg}'");
                    if (current is not null)
                        return UsageError($"unexpected argument '{arg}'");
                    current = arg;
                    break;
            }
        }

        if (current is null)
            return UsageError("check requires a <file.koi|dir> argument (the current model)");
        if (baseline is null)
            return UsageError("check requires --baseline <dir> (the previously published model)");

        var compiler = new KoineCompiler();
        if (!TryParseModel(compiler, current, "current", out var currentModel) ||
            !TryParseModel(compiler, baseline, "baseline", out var baselineModel))
            return 1;

        var report = new CompatibilityChecker().Check(baselineModel, currentModel);

        foreach (var change in report.Changes)
        {
            if (change.Impact == CompatibilityImpact.Breaking)
                Console.Error.WriteLine($"breaking {change.Code}: {change.Message}");
            else
                Console.WriteLine($"non-breaking: {change.Message}");
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

        List<SourceFile> sources;
        try
        {
            sources = ReadSources(path);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            Console.Error.WriteLine($"error: {label} not found: {path}");
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"error: cannot read {label} '{path}': {ex.Message}");
            return false;
        }

        if (sources.Count == 0)
        {
            Console.Error.WriteLine($"error: no .koi files found under {label} '{path}'");
            return false;
        }

        var (parsed, diagnostics) = compiler.Parse(sources);
        if (parsed is null)
        {
            foreach (var diag in diagnostics)
            {
                var severity = diag.Severity.ToString().ToLowerInvariant();
                Console.Error.WriteLine($"{diag.File ?? path}:{diag.Line}:{diag.Column}: {severity} {diag.Code}: {diag.Message}");
            }
            Console.Error.WriteLine($"error: {label} model failed to parse");
            return false;
        }

        model = parsed;
        return true;
    }

    /// <summary>
    /// Reads the source unit(s) for a build path: a single <c>.koi</c> file, or every
    /// <c>.koi</c> under a directory (recursively, in a deterministic order) — R13.1.
    /// </summary>
    private static List<SourceFile> ReadSources(string path)
    {
        if (Directory.Exists(path))
            return Directory.EnumerateFiles(path, "*.koi", SearchOption.AllDirectories)
                .OrderBy(p => p, StringComparer.Ordinal)
                .Select(p => new SourceFile(p, File.ReadAllText(p)))
                .ToList();

        return new List<SourceFile> { new(path, File.ReadAllText(path)) };
    }

    private static int UsageError(string message)
    {
        Console.Error.WriteLine($"error: {message}");
        PrintUsage();
        return 1;
    }

    private static void PrintUsage() => PrintUsageTo(Console.Error);

    private static int PrintUsageTo(TextWriter writer)
    {
        writer.WriteLine("Koine — a DSL for Domain-Driven Design.");
        writer.WriteLine();
        writer.WriteLine("Usage:");
        writer.WriteLine("  koine --version");
        writer.WriteLine("  koine build <file.koi|dir> [--target csharp|glossary] [--out <dir>] [--glossary <file.md>] [--config <file>]");
        writer.WriteLine("  koine watch <file.koi|dir> [--target …] [--out …] [--config <file>]   # rebuild on every change");
        writer.WriteLine("  koine fmt   <file.koi|dir> [--check]            # canonically format .koi (--check: verify only)");
        writer.WriteLine("  koine init  [dir] [--force]                    # scaffold a starter project");
        writer.WriteLine("  koine check <file.koi|dir> --baseline <dir>    # flag breaking changes vs a published baseline");
        writer.WriteLine("  koine lsp                                      # Language Server (stdio) for editor diagnostics");
        return 0;
    }
}
