using System.Reflection;
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
            return UsageError("build requires a <file.koi> argument");

        IEmitter emitter = target.ToLowerInvariant() switch
        {
            "csharp" => new CSharpEmitter(),
            "glossary" => new GlossaryEmitter(),
            _ => null!
        };
        if (emitter is null)
            return UsageError($"unsupported target '{target}' (supported: csharp, glossary)");

        string source;
        try
        {
            source = File.ReadAllText(file);
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

        var compiler = new KoineCompiler();
        var result = compiler.Compile(source, emitter);

        var hasError = false;
        foreach (var diag in result.Diagnostics)
        {
            if (diag.Severity == DiagnosticSeverity.Error)
                hasError = true;
            // MSBuild/Roslyn-parseable: file:line:col: severity CODE: message
            var severity = diag.Severity.ToString().ToLowerInvariant();
            Console.Error.WriteLine($"{file}:{diag.Line}:{diag.Column}: {severity} {diag.Code}: {diag.Message}");
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
        writer.WriteLine("  koine build <file.koi> [--target csharp|glossary] [--out <dir>] [--glossary <file.md>]");
        writer.WriteLine("  koine lsp                       # Language Server (stdio) for editor diagnostics");
        return 0;
    }
}
