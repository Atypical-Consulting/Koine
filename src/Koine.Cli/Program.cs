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

    private static int RunBuild(string[] args)
    {
        string? file = null;
        string target = "csharp";
        string? outDir = null;
        string? glossaryFile = null;

        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            switch (arg)
            {
                case "--target":
                    if (i + 1 >= args.Length)
                        return UsageError("--target requires a value");
                    target = args[++i];
                    break;
                case "--out":
                    if (i + 1 >= args.Length)
                        return UsageError("--out requires a value");
                    outDir = args[++i];
                    break;
                case "--glossary":
                    if (i + 1 >= args.Length)
                        return UsageError("--glossary requires a <file> value");
                    glossaryFile = args[++i];
                    break;
                default:
                    if (arg.StartsWith('-'))
                        return UsageError($"unknown option '{arg}'");
                    if (file is not null)
                        return UsageError($"unexpected argument '{arg}'");
                    file = arg;
                    break;
            }
        }

        if (file is null)
            return UsageError("build requires a <file.koi> or directory argument");

        IEmitter emitter = target.ToLowerInvariant() switch
        {
            "csharp" => new CSharpEmitter(),
            "glossary" => new GlossaryEmitter(),
            _ => null!
        };
        if (emitter is null)
            return UsageError($"unsupported target '{target}' (supported: csharp, glossary)");

        // A path may be a single .koi file or a directory of them (compiled as one model).
        List<SourceFile> sources;
        try
        {
            sources = ReadSources(file);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            Console.Error.WriteLine($"error: file not found: {file}");
            return 1;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"error: cannot read '{file}': {ex.Message}");
            return 1;
        }

        if (sources.Count == 0)
        {
            Console.Error.WriteLine($"error: no .koi files found under '{file}'");
            return 1;
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
            return 1;

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
            return 0;
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
        writer.WriteLine("  koine build <file.koi|dir> [--target csharp|glossary] [--out <dir>] [--glossary <file.md>]");
        writer.WriteLine("  koine check <file.koi|dir> --baseline <dir>   # flag breaking changes vs a published baseline");
        writer.WriteLine("  koine lsp                       # Language Server (stdio) for editor diagnostics");
        return 0;
    }
}
