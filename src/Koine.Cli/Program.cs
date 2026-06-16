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
    private static int Main(string[] args) => Run(args);

    /// <summary>
    /// The CLI entry point, factored out of <see cref="Main"/> so tests can drive argument
    /// handling directly (internals are visible to Koine.Compiler.Tests) and assert exit codes.
    /// </summary>
    internal static int Run(string[] args)
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
        Console.WriteLine(GetVersion());
        return 0;
    }

    /// <summary>
    /// The display version, read from <see cref="AssemblyInformationalVersionAttribute"/>
    /// (set from <c>Version</c> in Directory.Build.props) rather than the four-part
    /// <c>AssemblyVersion</c>, which defaults to <c>1.0.0.0</c>. The SDK may append a
    /// <c>+&lt;commit&gt;</c> build-metadata suffix, which we trim off.
    /// </summary>
    internal static string GetVersion()
    {
        var info = Assembly.GetExecutingAssembly()
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(info))
        {
            return Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "0.0.0";
        }

        var plus = info.IndexOf('+');
        return plus < 0 ? info : info[..plus];
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
                    if (i + 1 >= args.Length)
                    { error = "--target requires a value"; return false; }
                    target = args[++i];
                    break;
                case "--out":
                    if (i + 1 >= args.Length)
                    { error = "--out requires a value"; return false; }
                    outDir = args[++i];
                    break;
                case "--glossary":
                    if (i + 1 >= args.Length)
                    { error = "--glossary requires a <file> value"; return false; }
                    glossaryFile = args[++i];
                    break;
                case "--config":
                    if (i + 1 >= args.Length)
                    { error = "--config requires a <file> value"; return false; }
                    configPath = args[++i];
                    break;
                default:
                    if (arg.StartsWith('-'))
                    { error = $"unknown option '{arg}'"; return false; }
                    if (file is not null)
                    { error = $"unexpected argument '{arg}'"; return false; }
                    file = arg;
                    break;
            }
        }

        if (file is null)
        { error = "requires a <file.koi> or directory argument"; return false; }

        KoineConfig config;
        if (configPath is not null)
        {
            if (!File.Exists(configPath))
            { error = $"config not found: {configPath}"; return false; }
            config = KoineConfig.Parse(File.ReadAllText(configPath));
        }
        else
        {
            config = KoineConfig.Discover(file);
        }

        // Per-target out-dir (R16.1): an explicit --out wins, then targets.<t>.out, then the flat out.
        var resolvedTarget = target ?? config.Target ?? "csharp";
        var resolvedOut = outDir ?? config.OptionsFor(resolvedTarget).OutDir ?? config.OutDir;
        request = new BuildRequest(file, resolvedTarget, resolvedOut, glossaryFile);
        return true;
    }

    private static int RunBuild(string[] args)
    {
        if (WantsHelp(args))
        {
            return PrintHelp(BuildHelp);
        }

        if (!TryParseBuild(args, out var request, out var error))
        {
            return UsageError(error!, BuildHelp);
        }

        return BuildOnce(request, out var exitCode) ? 0 : exitCode;
    }

    /// <summary>
    /// Runs one build for <paramref name="r"/>, printing diagnostics and progress, and
    /// returns whether it succeeded. Shared by <c>build</c> (once) and <c>watch</c> (per change).
    /// </summary>
    private static bool BuildOnce(BuildRequest r) => BuildOnce(r, out _);

    private static bool BuildOnce(BuildRequest r, out int exitCode)
    {
        exitCode = 1;
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
            exitCode = RuntimeError($"unsupported target '{target}' (supported: csharp, glossary)");
            return false;
        }

        // A path may be a single .koi file or a directory of them (compiled as one model).
        if (!TryReadSources(file, "file", out var sources, out exitCode))
        {
            return false;
        }

        var compiler = new KoineCompiler();
        var result = compiler.Compile(sources, emitter);

        var hasError = false;
        foreach (var diag in result.Diagnostics)
        {
            if (diag.Severity == DiagnosticSeverity.Error)
            {
                hasError = true;
            }
            // MSBuild/Roslyn-parseable: file:line:col: severity CODE: message
            var severity = diag.Severity.ToString().ToLowerInvariant();
            Console.Error.WriteLine($"{diag.File ?? file}:{diag.Line}:{diag.Column}: {severity} {diag.Code}: {diag.Message}");
        }

        if (hasError)
        {
            return false;
        }

        // --glossary writes a Markdown glossary to a specific file, independent of
        // the chosen --target/--out (so you can emit C# AND a glossary in one run).
        if (glossaryFile is not null && result.Model is not null)
        {
            var glossary = new GlossaryEmitter().Emit(result.Model)[0];
            var dir = Path.GetDirectoryName(glossaryFile);
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
            }

            WriteFileAtomic(glossaryFile, glossary.Contents);
            Console.WriteLine($"wrote glossary to {glossaryFile}");
        }

        if (outDir is null)
        {
            if (glossaryFile is null)
            {
                Console.WriteLine($"OK: {file} parsed and validated");
            }

            exitCode = 0;
            return true;
        }

        var count = WriteOutputAtomic(outDir, result.Files);
        Console.WriteLine($"wrote {count} files to {outDir}");
        exitCode = 0;
        return true;
    }

    /// <summary>
    /// Writes the emitted files into <paramref name="outDir"/> one owned top-level folder
    /// (namespace root) at a time, swapping each via a sibling temp directory. This avoids
    /// the delete-then-recreate window in which a watching consumer could observe an empty
    /// or partially-written folder, and still drops stale orphans from a previous run.
    /// </summary>
    private static int WriteOutputAtomic(string outDir, IReadOnlyList<EmittedFile> files)
    {
        Directory.CreateDirectory(outDir);

        // Group emitted files by their owned top-level folder (the namespace root).
        var byRoot = files
            .GroupBy(f => f.RelativePath.Replace('\\', '/').Split('/')[0], StringComparer.Ordinal);

        var count = 0;
        foreach (var group in byRoot)
        {
            var root = group.Key;
            var finalDir = Path.Combine(outDir, root);
            var stageDir = Path.Combine(outDir, $".{root}.koine-tmp-{Guid.NewGuid():N}");

            try
            {
                foreach (var emitted in group)
                {
                    // RelativePath starts with `root/…`; re-root it under the staging dir.
                    var relUnderRoot = emitted.RelativePath.Replace('\\', '/')[(root.Length)..].TrimStart('/');
                    var path = Path.Combine(stageDir, relUnderRoot);
                    var dir = Path.GetDirectoryName(path);
                    if (!string.IsNullOrEmpty(dir))
                    {
                        Directory.CreateDirectory(dir);
                    }

                    File.WriteAllText(path, emitted.Contents);
                    count++;
                }

                // Swap: replace the live folder with the fully-written staging folder.
                if (Directory.Exists(finalDir))
                {
                    Directory.Delete(finalDir, recursive: true);
                }

                Directory.Move(stageDir, finalDir);
            }
            finally
            {
                if (Directory.Exists(stageDir))
                {
                    Directory.Delete(stageDir, recursive: true);
                }
            }
        }

        return count;
    }

    /// <summary>Writes a single file atomically via a temp file + replace, so readers never see a half-written file.</summary>
    private static void WriteFileAtomic(string path, string contents)
    {
        var tmp = path + $".koine-tmp-{Guid.NewGuid():N}";
        File.WriteAllText(tmp, contents);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        File.Move(tmp, path);
    }

    // ---- fmt (R17.3) -------------------------------------------------------

    private static int RunFmt(string[] args)
    {
        if (WantsHelp(args))
        {
            return PrintHelp(FmtHelp);
        }

        string? path = null;
        var check = false;

        foreach (var arg in args)
        {
            if (arg == "--check")
            {
                check = true;
            }
            else if (arg.StartsWith('-'))
            {
                return UsageError($"unknown option '{arg}'", FmtHelp);
            }
            else if (path is not null)
            {
                return UsageError($"unexpected argument '{arg}'", FmtHelp);
            }
            else
            {
                path = arg;
            }
        }

        if (path is null)
        {
            return UsageError("fmt requires a <file.koi> or directory argument", FmtHelp);
        }

        if (!TryReadSources(path, "file", out var sources, out var exitCode))
        {
            return exitCode;
        }

        var compiler = new KoineCompiler();
        var formatter = new Koine.Compiler.Formatting.KoineFormatter();
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
                foreach (var diag in diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error))
                {
                    Console.Error.WriteLine($"{diag.File ?? source.Path}:{diag.Line}:{diag.Column}: error {diag.Code}: {diag.Message}");
                }

                Console.Error.WriteLine($"{source.Path}: cannot format (does not parse) — fix the syntax, then re-run");
                continue;
            }

            var result = formatter.Format(source.Source);
            if (!result.Changed)
            {
                continue;
            }

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

        // Unparseable files always fail (in both --check and write modes): fmt cannot
        // canonically format what it cannot parse.
        if (unparseable > 0)
        {
            Console.Error.WriteLine($"error: {unparseable} file(s) could not be parsed (fmt does not fix unparseable files)");
            return 1;
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
        if (WantsHelp(args))
        {
            return PrintHelp(InitHelp);
        }

        string? dir = null;
        var force = false;

        foreach (var arg in args)
        {
            if (arg == "--force")
            {
                force = true;
            }
            else if (arg.StartsWith('-'))
            {
                return UsageError($"unknown option '{arg}'", InitHelp);
            }
            else if (dir is not null)
            {
                return UsageError($"unexpected argument '{arg}'", InitHelp);
            }
            else
            {
                dir = arg;
            }
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
        {
            File.WriteAllText(Path.Combine(dir, name), content);
        }

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
        if (WantsHelp(args))
        {
            return PrintHelp(WatchHelp);
        }

        // `--clear` is watch-only (not a build flag), so peel it off before TryParseBuild.
        var clear = args.Contains("--clear");
        if (clear)
        {
            args = args.Where(a => a != "--clear").ToArray();
        }

        if (!TryParseBuild(args, out var request, out var error))
        {
            return UsageError(error!, WatchHelp);
        }

        // Watch the input's directory (or the directory itself), filtered to .koi files.
        var watchDir = Directory.Exists(request.File)
            ? request.File
            : Path.GetDirectoryName(Path.GetFullPath(request.File)) ?? ".";

        using var watcher = new FileSystemWatcher(watchDir, "*.koi")
        {
            IncludeSubdirectories = true,
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size,
        };

        // Give the OS a roomy buffer so bursts of saves are less likely to overflow.
        watcher.InternalBufferSize = 64 * 1024;

        var changes = new BlockingCollection<object>();
        void Bump()
        { try { changes.Add(new object()); } catch (InvalidOperationException) { } }
        watcher.Changed += (_, _) => Bump();
        watcher.Created += (_, _) => Bump();
        watcher.Deleted += (_, _) => Bump();
        watcher.Renamed += (_, _) => Bump();
        // If the buffer overflows, individual events are lost; force a rebuild so the
        // output never silently lags behind the source.
        watcher.Error += (_, _) => Bump();
        watcher.EnableRaisingEvents = true;

        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;            // let the loop unwind cleanly instead of killing the process
            cts.Cancel();
            changes.CompleteAdding();
        };

        Console.WriteLine($"watching {watchDir} for *.koi changes — press Ctrl+C to stop");
        var session = new WatchSession(
            () => BuildOnce(request),
            Console.Out,
            TimeSpan.FromMilliseconds(250),
            // A safety-net full rebuild every minute, in case any change event was dropped.
            fullRebuildInterval: TimeSpan.FromMinutes(1),
            beforeBuild: clear ? () => Console.Clear() : null);
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
        if (WantsHelp(args))
        {
            return PrintHelp(CheckHelp);
        }

        string? current = null;
        string? baseline = null;
        string? configPath = null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            switch (arg)
            {
                case "--baseline":
                    if (i + 1 >= args.Length)
                    {
                        return UsageError("--baseline requires a <dir> value", CheckHelp);
                    }

                    baseline = args[++i];
                    break;
                case "--config":
                    if (i + 1 >= args.Length)
                    {
                        return UsageError("--config requires a <file> value", CheckHelp);
                    }

                    configPath = args[++i];
                    break;
                default:
                    if (arg.StartsWith('-'))
                    {
                        return UsageError($"unknown option '{arg}'", CheckHelp);
                    }

                    if (current is not null)
                    {
                        return UsageError($"unexpected argument '{arg}'", CheckHelp);
                    }

                    current = arg;
                    break;
            }
        }

        if (current is null)
        {
            return UsageError("check requires a <file.koi|dir> argument (the current model)", CheckHelp);
        }

        // A koine.config (explicit --config, or discovered beside the input) may supply the
        // default baseline, for symmetry with build/watch — an explicit --baseline wins.
        if (baseline is null)
        {
            KoineConfig config;
            if (configPath is not null)
            {
                if (!File.Exists(configPath))
                {
                    return RuntimeError($"config not found: {configPath}");
                }

                config = KoineConfig.Parse(File.ReadAllText(configPath));
            }
            else
            {
                config = KoineConfig.Discover(current);
            }
            baseline = config.Baseline;
        }

        if (baseline is null)
        {
            return UsageError("check requires --baseline <dir> (or a `baseline` key in koine.config)", CheckHelp);
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

        if (!TryReadSources(path, label, out var sources, out _))
        {
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
        {
            return Directory.EnumerateFiles(path, "*.koi", SearchOption.AllDirectories)
                .OrderBy(p => p, StringComparer.Ordinal)
                .Select(p => new SourceFile(p, File.ReadAllText(p)))
                .ToList();
        }

        return new List<SourceFile> { new(path, File.ReadAllText(path)) };
    }

    /// <summary>
    /// A usage error: the user typed a bad flag/argument. Prints the message followed by
    /// the (optionally command-specific) usage block, and exits non-zero.
    /// </summary>
    private static int UsageError(string message, string? commandHelp = null)
    {
        Console.Error.WriteLine($"error: {message}");
        if (commandHelp is not null)
        {
            Console.Error.WriteLine(commandHelp);
        }
        else
        {
            PrintUsage();
        }

        return 1;
    }

    /// <summary>
    /// A runtime error: the flags were fine but the input was not (missing file, no .koi
    /// files, unsupported target, parse failure). Prints the message plus an actionable
    /// hint instead of dumping the full global usage, and exits non-zero.
    /// </summary>
    private static int RuntimeError(string message, string? hint = null)
    {
        Console.Error.WriteLine($"error: {message}");
        if (hint is not null)
        {
            Console.Error.WriteLine($"hint: {hint}");
        }

        return 1;
    }

    /// <summary>
    /// Shared <c>.koi</c> source loading for <c>build</c>/<c>fmt</c>/<c>check</c>: reads a
    /// file or directory, turning the I/O and "nothing found" cases into a single
    /// actionable <see cref="RuntimeError"/>. Returns <c>false</c> (with <paramref name="exitCode"/>
    /// set) on failure; otherwise yields the sources.
    /// </summary>
    private static bool TryReadSources(string path, string label, out List<SourceFile> sources, out int exitCode)
    {
        sources = new List<SourceFile>();
        exitCode = 0;
        try
        {
            sources = ReadSources(path);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            exitCode = RuntimeError($"{label} not found: {path}", "run `koine init` to scaffold a starter model");
            return false;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            exitCode = RuntimeError($"cannot read {label} '{path}': {ex.Message}");
            return false;
        }

        if (sources.Count == 0)
        {
            exitCode = RuntimeError($"no .koi files found under '{path}'", "run `koine init` to scaffold a starter model");
            return false;
        }

        return true;
    }

    /// <summary>True when the args request command help (<c>--help</c>/<c>-h</c>).</summary>
    private static bool WantsHelp(string[] args) => args.Any(a => a is "--help" or "-h");

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

    // ---- per-subcommand help (R17) -----------------------------------------

    internal const string BuildHelp =
        """
        koine build — compile a .koi model and (optionally) emit code.

        Usage:
          koine build <file.koi|dir> [--target csharp|glossary] [--out <dir>] [--glossary <file.md>] [--config <file>]

        Options:
          --target <t>      output target: csharp (default) or glossary
          --out <dir>       directory to write generated files into; omit to only parse/validate
          --glossary <md>   also write a Markdown glossary to this file (independent of --target)
          --config <file>   read defaults (target/out) from this koine.config instead of discovering one

        Without --out, build parses and validates only. A koine.config beside the input
        supplies target/out when the matching flag is omitted.

        Examples:
          koine build domain.koi
          koine build domain.koi --out generated
          koine build ./model --target glossary --out docs
        """;

    internal const string CheckHelp =
        """
        koine check — flag breaking changes against a published baseline (R15.2).

        Usage:
          koine check <file.koi|dir> --baseline <dir> [--config <file>]

        Options:
          --baseline <dir>  the previously published model to compare against (required
                            unless a koine.config / --config supplies a `baseline` key)
          --config <file>   read defaults from this koine.config instead of discovering one

        Exits non-zero if any breaking change to a published surface is found, or if
        either model fails to parse.

        Examples:
          koine check domain.koi --baseline ./published
          koine check ./model --baseline ./v1
        """;

    internal const string FmtHelp =
        """
        koine fmt — canonically format .koi source.

        Usage:
          koine fmt <file.koi|dir> [--check]

        Options:
          --check   do not write; exit non-zero if any file is unformatted or unparseable

        Formatting only adjusts whitespace; it never rewrites code or fixes syntax.
        Files that fail to parse are reported (with a file:line message) and are left
        untouched — fix the syntax, then re-run fmt.

        Examples:
          koine fmt domain.koi
          koine fmt ./model --check
        """;

    internal const string InitHelp =
        """
        koine init — scaffold a starter Koine project.

        Usage:
          koine init [dir] [--force]

        Options:
          --force   overwrite existing domain.koi / koine.config / README.md

        Writes domain.koi (a model that builds end-to-end), koine.config, and README.md
        into [dir] (default: the current directory).

        Examples:
          koine init
          koine init ./catalog
          koine init . --force
        """;

    internal const string WatchHelp =
        """
        koine watch — rebuild on every .koi change until Ctrl+C.

        Usage:
          koine watch <file.koi|dir> [--target …] [--out …] [--glossary <file.md>] [--config <file>] [--clear]

        Options:
          --target/--out/--glossary/--config   as for `koine build`
          --clear   clear the console before each rebuild

        Examples:
          koine watch domain.koi --out generated
          koine watch ./model --clear
        """;

    private static int PrintHelp(string help)
    {
        Console.Out.WriteLine(help);
        return 0;
    }
}
