using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using Koine.Compiler.Emit;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Koine.Compiler.Tests;

/// <summary>Shared fixtures and a Roslyn-based compiler for emitter meta-tests.</summary>
public static class TestSupport
{
    /// <summary>The §4.2 acceptance fixture, copied next to the test assembly.</summary>
    public static string BillingFixture =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "billing.koi"));

    /// <summary>Reads a generated smart-enum member (a public static readonly field) by name.</summary>
    public static object EnumValue(Type enumType, string name) =>
        enumType.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;

    /// <summary>Concatenates emitted files (path + contents), ordered by path, for snapshots.</summary>
    public static string Render(IEnumerable<EmittedFile> files)
    {
        var sb = new StringBuilder();
        foreach (var f in files.OrderBy(f => f.RelativePath, StringComparer.Ordinal))
        {
            sb.Append("// ==== ").Append(f.RelativePath).Append(" ====\n");
            sb.Append(f.Contents);
            if (!f.Contents.EndsWith('\n'))
            {
                sb.Append('\n');
            }

            sb.Append('\n');
        }
        return sb.ToString();
    }

    /// <summary>
    /// Compiles emitted C# in-memory with Roslyn against the running framework's
    /// reference set. Returns the loaded assembly on success, or the error list.
    /// </summary>
    public static (Assembly? Assembly, IReadOnlyList<string> Errors) Compile(IEnumerable<EmittedFile> files)
    {
        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Contents, path: f.RelativePath))
            .ToList();

        var tpa = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            assemblyName: "KoineGenerated_" + Guid.NewGuid().ToString("N"),
            syntaxTrees: trees,
            references: tpa,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));

        using var ms = new MemoryStream();
        var result = compilation.Emit(ms);
        if (!result.Success)
        {
            var errors = result.Diagnostics
                .Where(d => d.Severity == DiagnosticSeverity.Error)
                .Select(d => d.ToString())
                .ToList();
            return (null, errors);
        }

        ms.Seek(0, SeekOrigin.Begin);
        var asm = AssemblyLoadContext.Default.LoadFromStream(ms);
        return (asm, Array.Empty<string>());
    }

    /// <summary>
    /// Result of a TypeScript type-check run. <see cref="ToolchainAvailable"/> is false when
    /// no <c>tsc</c> could be located locally — callers should SKIP (not fail) in that case so
    /// <c>dotnet test</c> stays green without a Node/TypeScript toolchain. When the toolchain IS
    /// available, <see cref="Ok"/> reflects whether <c>tsc --noEmit --strict</c> reported errors.
    /// </summary>
    public readonly record struct TypeScriptCheck(bool ToolchainAvailable, bool Ok, IReadOnlyList<string> Errors)
    {
        /// <summary>A skipped result: no toolchain present, so nothing was verified.</summary>
        public static TypeScriptCheck Skipped { get; } =
            new(ToolchainAvailable: false, Ok: false, Errors: Array.Empty<string>());
    }

    /// <summary>
    /// Writes the emitted <c>.ts</c> files to a fresh temp directory and type-checks them with
    /// <c>tsc --noEmit --strict</c> (the same role the Roslyn <see cref="Compile"/> harness plays
    /// for C#). When no <c>tsc</c> is found the result is <see cref="TypeScriptCheck.Skipped"/>
    /// (<see cref="TypeScriptCheck.ToolchainAvailable"/> == false) so the suite stays green without
    /// a TypeScript toolchain — it NEVER silently passes a real error and NEVER fails merely because
    /// <c>tsc</c> is missing. CI is expected to have the toolchain and therefore actually run the check.
    /// </summary>
    public static TypeScriptCheck TypeCheckTypeScript(IEnumerable<EmittedFile> files)
    {
        if (ResolveTsc() is not { } tsc)
        {
            return TypeScriptCheck.Skipped;
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-tsc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (EmittedFile f in files)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
            }

            var psi = new ProcessStartInfo
            {
                FileName = tsc.FileName,
                WorkingDirectory = root,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (string arg in tsc.Arguments)
            {
                psi.ArgumentList.Add(arg);
            }

            // When the emitter shipped a tsconfig.json, type-check via `tsc -p .` so the test
            // validates EXACTLY the configuration users get (target/lib/strict all live there).
            // Otherwise (hand-authored fixtures with no tsconfig) pass the flags + file list.
            var hasTsconfig = files.Any(f => string.Equals(f.RelativePath, "tsconfig.json", StringComparison.OrdinalIgnoreCase));
            if (hasTsconfig)
            {
                psi.ArgumentList.Add("-p");
                psi.ArgumentList.Add(".");
            }
            else
            {
                psi.ArgumentList.Add("--noEmit");
                psi.ArgumentList.Add("--strict");
                psi.ArgumentList.Add("--target");
                psi.ArgumentList.Add("ES2022");
                psi.ArgumentList.Add("--module");
                psi.ArgumentList.Add("ESNext");
                psi.ArgumentList.Add("--moduleResolution");
                psi.ArgumentList.Add("bundler");
                foreach (EmittedFile f in files.Where(f => f.RelativePath.EndsWith(".ts", StringComparison.OrdinalIgnoreCase)))
                {
                    psi.ArgumentList.Add(f.RelativePath);
                }
            }

            using var proc = Process.Start(psi)!;
            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();

            if (proc.ExitCode == 0)
            {
                return new TypeScriptCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            var errors = (stdout + stderr)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
            return new TypeScriptCheck(ToolchainAvailable: true, Ok: false, errors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>
    /// Result of a Python type-check run. <see cref="ToolchainAvailable"/> is false when no
    /// <c>mypy</c> could be located locally — callers should SKIP (not fail) in that case so
    /// <c>dotnet test</c> stays green without a mypy toolchain. When the toolchain IS available,
    /// <see cref="Ok"/> reflects whether <c>mypy</c> reported errors.
    /// </summary>
    public readonly record struct PythonCheck(bool ToolchainAvailable, bool Ok, IReadOnlyList<string> Errors)
    {
        /// <summary>A skipped result: no toolchain present, so nothing was verified.</summary>
        public static PythonCheck Skipped { get; } =
            new(ToolchainAvailable: false, Ok: false, Errors: Array.Empty<string>());
    }

    /// <summary>
    /// Writes the emitted Python files to a fresh temp directory and type-checks them with
    /// <c>mypy</c> (the same role the Roslyn <see cref="Compile"/> harness plays for C#). When an
    /// emitted <c>mypy.ini</c> is present the check runs <c>mypy --config-file mypy.ini .</c> so it
    /// validates EXACTLY the configuration users get; otherwise it runs <c>mypy --strict .</c>
    /// (the analogue of the TypeScript <c>tsc -p .</c> vs explicit-flags split). When no <c>mypy</c>
    /// is found the result is <see cref="PythonCheck.Skipped"/> (<see cref="PythonCheck.ToolchainAvailable"/>
    /// == false) so the suite stays green without a Python toolchain — it NEVER silently passes a real
    /// error and NEVER fails merely because <c>mypy</c> is missing. CI is expected to have the toolchain
    /// and therefore actually run the check.
    /// </summary>
    public static PythonCheck TypeCheckPython(IEnumerable<EmittedFile> files)
    {
        var fileList = files.ToList();
        if (ResolveMypy() is not { } mypy)
        {
            return PythonCheck.Skipped;
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-mypy-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (EmittedFile f in fileList)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
            }

            var args = new List<string>(mypy.Arguments);

            // When the emitter shipped a mypy.ini, type-check via `--config-file mypy.ini .` so the
            // test validates EXACTLY the configuration users get (strict flags / python_version live
            // there). Otherwise (hand-authored fixtures with no config) pass `--strict .`.
            bool hasConfig = fileList.Any(f => string.Equals(f.RelativePath, "mypy.ini", StringComparison.OrdinalIgnoreCase));
            if (hasConfig)
            {
                args.Add("--config-file");
                args.Add("mypy.ini");
                args.Add(".");
            }
            else
            {
                args.Add("--strict");
                args.Add(".");
            }

            if (RunProcess(mypy.FileName, args, root) is not { } run)
            {
                // The resolved mypy refused to launch (e.g. a broken shebang). Treat as no toolchain.
                return PythonCheck.Skipped;
            }

            if (run.ExitCode == 0)
            {
                return new PythonCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            var errors = (run.StdOut + run.StdErr)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
            return new PythonCheck(ToolchainAvailable: true, Ok: false, errors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>
    /// Parses every emitted <c>.py</c> file with <c>ast.parse</c> via a resolved Python interpreter —
    /// an always-on syntax gate that catches malformed emission even without a type-checker. When no
    /// interpreter is found the result is <see cref="PythonCheck.Skipped"/> so the suite stays green.
    /// The resolver prefers a versioned <c>python3.11+</c> over bare <c>python3</c> because the system
    /// <c>python3</c> may be 3.9, which cannot parse <c>match</c> statements (3.11+ syntax).
    /// </summary>
    public static PythonCheck SyntaxCheckPython(IEnumerable<EmittedFile> files)
    {
        var fileList = files.ToList();
        if (ResolvePython() is not { } python)
        {
            return PythonCheck.Skipped;
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-pyast-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var pyFiles = new List<string>();
            foreach (EmittedFile f in fileList)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
                if (f.RelativePath.EndsWith(".py", StringComparison.OrdinalIgnoreCase))
                {
                    pyFiles.Add(path);
                }
            }

            if (pyFiles.Count == 0)
            {
                // Nothing to parse — vacuously OK (a toolchain was found).
                return new PythonCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            // One invocation that reads + ast.parse()s every path, reporting the first failure.
            const string script =
                "import ast, sys\n" +
                "for p in sys.argv[1:]:\n" +
                "    with open(p, 'r', encoding='utf-8') as fh:\n" +
                "        src = fh.read()\n" +
                "    try:\n" +
                "        ast.parse(src, filename=p)\n" +
                "    except SyntaxError as e:\n" +
                "        print(f'{p}: {e}', file=sys.stderr)\n" +
                "        sys.exit(1)\n";

            var args = new List<string>(python.Arguments) { "-c", script };
            args.AddRange(pyFiles);

            if (RunProcess(python.FileName, args, root) is not { } run)
            {
                return PythonCheck.Skipped;
            }

            if (run.ExitCode == 0)
            {
                return new PythonCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            var errors = (run.StdOut + run.StdErr)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
            return new PythonCheck(ToolchainAvailable: true, Ok: false, errors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>How to invoke a tool: a program plus leading arguments (e.g. <c>python -m mypy</c>).</summary>
    private readonly record struct ToolInvocation(string FileName, IReadOnlyList<string> Arguments);

    /// <summary>
    /// Locates a usable <c>mypy</c>: an explicit <c>KOINE_MYPY</c> override (always wins), a direct
    /// <c>mypy</c> on PATH, or <c>&lt;python&gt; -m mypy</c> via a resolved interpreter. Returns
    /// <c>null</c> when none works so the caller can skip. Each candidate launch is probed in a
    /// try/catch: a candidate whose process refuses to start (e.g. a <c>mypy</c> on PATH with a
    /// shebang pointing at a removed interpreter) is skipped and the next candidate is tried.
    /// </summary>
    private static ToolInvocation? ResolveMypy()
    {
        if (Environment.GetEnvironmentVariable("KOINE_MYPY") is { Length: > 0 } overrideMypy)
        {
            return new ToolInvocation(overrideMypy, Array.Empty<string>());
        }

        if (OnPath("mypy") is { } direct && CanRun(direct, ["--version"]))
        {
            return new ToolInvocation(direct, Array.Empty<string>());
        }

        if (ResolvePython() is { } python && CanRun(python.FileName, [.. python.Arguments, "-m", "mypy", "--version"]))
        {
            return new ToolInvocation(python.FileName, [.. python.Arguments, "-m", "mypy"]);
        }

        return null;
    }

    /// <summary>
    /// Locates a usable Python interpreter, preferring versioned 3.11+ binaries over bare
    /// <c>python3</c> (which may be 3.9 and cannot parse <c>match</c> / PEP&#160;604 unions). Order:
    /// <c>KOINE_PYTHON</c> override → <c>python3.13</c> → <c>python3.12</c> → <c>python3.11</c> →
    /// <c>python3</c> → <c>python</c>. Returns <c>null</c> when none launches. Each candidate is
    /// probed via <see cref="CanRun"/> so a broken binary is skipped rather than crashing.
    /// </summary>
    private static ToolInvocation? ResolvePython()
    {
        if (Environment.GetEnvironmentVariable("KOINE_PYTHON") is { Length: > 0 } overridePython)
        {
            return new ToolInvocation(overridePython, Array.Empty<string>());
        }

        foreach (string name in new[] { "python3.13", "python3.12", "python3.11", "python3", "python" })
        {
            if (OnPath(name) is { } found && CanRun(found, ["--version"]))
            {
                return new ToolInvocation(found, Array.Empty<string>());
            }
        }

        return null;
    }

    /// <summary>Captured result of a child process: exit code plus full stdout/stderr.</summary>
    private readonly record struct ProcessRun(int ExitCode, string StdOut, string StdErr);

    /// <summary>
    /// Runs a process to completion in <paramref name="workingDirectory"/>, capturing its exit code,
    /// stdout, and stderr. Returns <c>null</c> when the process fails to even start (e.g. a broken
    /// shebang) so callers can fall through to the next candidate instead of crashing.
    /// </summary>
    private static ProcessRun? RunProcess(string fileName, IReadOnlyList<string> args, string? workingDirectory = null)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            if (workingDirectory is not null)
            {
                psi.WorkingDirectory = workingDirectory;
            }

            foreach (string a in args)
            {
                psi.ArgumentList.Add(a);
            }

            using var proc = Process.Start(psi);
            if (proc is null)
            {
                return null;
            }

            string stdout = proc.StandardOutput.ReadToEnd();
            string stderr = proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            return new ProcessRun(proc.ExitCode, stdout, stderr);
        }
        catch
        {
            return null;
        }
    }

    // -------------------------------------------------------------------------
    // PHP conformance harness (mirrors the Python harness above exactly)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Result of a PHP toolchain run. <see cref="ToolchainAvailable"/> is false when no
    /// <c>phpstan</c> (or <c>php</c>) could be located locally — callers should SKIP (not fail)
    /// in that case so <c>dotnet test</c> stays green without a PHP toolchain. When the toolchain
    /// IS available, <see cref="Ok"/> reflects whether the tool reported errors.
    /// </summary>
    public readonly record struct PhpCheck(bool ToolchainAvailable, bool Ok, IReadOnlyList<string> Errors)
    {
        /// <summary>A skipped result: no toolchain present, so nothing was verified.</summary>
        public static PhpCheck Skipped { get; } =
            new(ToolchainAvailable: false, Ok: false, Errors: Array.Empty<string>());
    }

    /// <summary>
    /// Writes the emitted PHP files to a fresh temp directory and analyses them with
    /// <c>phpstan analyse --level max --no-progress --error-format=raw</c>. When no
    /// <c>phpstan</c> is found the result is <see cref="PhpCheck.Skipped"/> so the suite stays
    /// green without a PHP toolchain — it NEVER silently passes a real error and NEVER fails
    /// merely because <c>phpstan</c> is missing.
    /// </summary>
    public static PhpCheck TypeCheckPhp(IEnumerable<EmittedFile> files)
    {
        var fileList = files.ToList();
        if (ResolvePhpStan() is not { } phpstan)
        {
            return PhpCheck.Skipped;
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-phpstan-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (EmittedFile f in fileList)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
            }

            var args = new List<string>(phpstan.Arguments)
            {
                "analyse",
                "--level", "max",
                "--no-progress",
                "--error-format=raw",
                root,
            };

            if (RunProcess(phpstan.FileName, args, root) is not { } run)
            {
                // phpstan refused to launch; treat as no toolchain.
                return PhpCheck.Skipped;
            }

            if (run.ExitCode == 0)
            {
                return new PhpCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            var errors = (run.StdOut + run.StdErr)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
            return new PhpCheck(ToolchainAvailable: true, Ok: false, errors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>
    /// Runs <c>php -l</c> on every emitted <c>.php</c> file — an always-on syntax gate that
    /// catches malformed emission even without PHPStan. When no interpreter is found the result
    /// is <see cref="PhpCheck.Skipped"/> so the suite stays green.
    /// </summary>
    public static PhpCheck SyntaxCheckPhp(IEnumerable<EmittedFile> files)
    {
        var fileList = files.ToList();
        if (ResolvePhp() is not { } php)
        {
            return PhpCheck.Skipped;
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-php-lint-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var phpFiles = new List<string>();
            foreach (EmittedFile f in fileList)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
                if (f.RelativePath.EndsWith(".php", StringComparison.OrdinalIgnoreCase))
                {
                    phpFiles.Add(path);
                }
            }

            if (phpFiles.Count == 0)
            {
                // Nothing to lint — vacuously OK (a toolchain was found).
                return new PhpCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            var allErrors = new List<string>();
            foreach (string phpFile in phpFiles)
            {
                var args = new List<string>(php.Arguments) { "-l", phpFile };
                if (RunProcess(php.FileName, args, root) is not { } run)
                {
                    return PhpCheck.Skipped;
                }

                if (run.ExitCode != 0)
                {
                    var fileErrors = (run.StdOut + run.StdErr)
                        .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                        .ToList();
                    allErrors.AddRange(fileErrors);
                }
            }

            return allErrors.Count == 0
                ? new PhpCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>())
                : new PhpCheck(ToolchainAvailable: true, Ok: false, allErrors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>
    /// Locates a usable <c>phpstan</c>: an explicit <c>KOINE_PHPSTAN</c> override (always wins),
    /// a direct <c>phpstan</c> on PATH, or <c>vendor/bin/phpstan</c> resolved from the repo root.
    /// Returns <c>null</c> when none works so the caller can skip.
    /// </summary>
    private static ToolInvocation? ResolvePhpStan()
    {
        if (Environment.GetEnvironmentVariable("KOINE_PHPSTAN") is { Length: > 0 } overridePhpStan)
        {
            return new ToolInvocation(overridePhpStan, Array.Empty<string>());
        }

        if (OnPath("phpstan") is { } direct && CanRun(direct, ["--version"]))
        {
            return new ToolInvocation(direct, Array.Empty<string>());
        }

        // vendor/bin/phpstan — walk up to the repo root (contains .git) and try there.
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (!Directory.Exists(Path.Combine(dir.FullName, ".git")) &&
                !File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                continue;
            }

            string candidate = Path.Combine(dir.FullName, "vendor", "bin", "phpstan");
            if (File.Exists(candidate) && CanRun(candidate, ["--version"]))
            {
                return new ToolInvocation(candidate, Array.Empty<string>());
            }

            break; // found repo root but no vendor phpstan
        }

        return null;
    }

    /// <summary>
    /// Locates a usable <c>php</c> interpreter. Order: <c>KOINE_PHP</c> override → <c>php</c> on
    /// PATH. Returns <c>null</c> when none launches.
    /// </summary>
    private static ToolInvocation? ResolvePhp()
    {
        if (Environment.GetEnvironmentVariable("KOINE_PHP") is { Length: > 0 } overridePhp)
        {
            return new ToolInvocation(overridePhp, Array.Empty<string>());
        }

        if (OnPath("php") is { } found && CanRun(found, ["--version"]))
        {
            return new ToolInvocation(found, Array.Empty<string>());
        }

        return null;
    }

    // -------------------------------------------------------------------------

    /// <summary>How to invoke <c>tsc</c>: a program plus leading arguments (e.g. <c>npx tsc</c>).</summary>
    private readonly record struct TscInvocation(string FileName, IReadOnlyList<string> Arguments);

    /// <summary>
    /// Locates a usable <c>tsc</c>: an explicit <c>KOINE_TSC</c> override, a direct <c>tsc</c> on
    /// PATH, or <c>npx --no-install tsc</c> when a local TypeScript install is present. Returns
    /// <c>null</c> when none is available so the caller can skip.
    /// </summary>
    private static TscInvocation? ResolveTsc()
    {
        if (Environment.GetEnvironmentVariable("KOINE_TSC") is { Length: > 0 } overrideTsc)
        {
            return new TscInvocation(overrideTsc, Array.Empty<string>());
        }

        if (OnPath("tsc") is { } direct)
        {
            return new TscInvocation(direct, Array.Empty<string>());
        }

        // Probe the repo-local TypeScript install (tooling/koine-textmate/node_modules)
        // so the TS type-check tests run for real on a developer machine that has run
        // `npm install` there, even when nothing is on PATH and KOINE_TSC is unset.
        if (RepoLocalTsc() is { } repoTsc)
        {
            return new TscInvocation(repoTsc, Array.Empty<string>());
        }

        // npx --no-install only succeeds if TypeScript is already installed locally; probe it.
        if (OnPath("npx") is { } npx && CanRun(npx, ["--no-install", "tsc", "--version"]))
        {
            return new TscInvocation(npx, ["--no-install", "tsc"]);
        }

        return null;
    }

    /// <summary>
    /// Resolves the repo-local <c>tsc</c> at
    /// <c>tooling/koine-textmate/node_modules/.bin/tsc</c> by walking up from the test
    /// assembly's directory to the repo root (the directory containing <c>.git</c>).
    /// Returns <c>null</c> when the repo root or the install cannot be found.
    /// </summary>
    private static string? RepoLocalTsc()
    {
        string relative = Path.Combine("tooling", "koine-textmate", "node_modules", ".bin", "tsc");
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (!Directory.Exists(Path.Combine(dir.FullName, ".git")) &&
                !File.Exists(Path.Combine(dir.FullName, ".git")))
            {
                continue;
            }

            string candidate = Path.Combine(dir.FullName, relative);
            return File.Exists(candidate) ? candidate : null;
        }

        return null;
    }

    private static string? OnPath(string command)
    {
        string[] names = OperatingSystem.IsWindows() ? [command + ".cmd", command + ".exe", command] : [command];
        string[] dirs = (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries);
        foreach (string dir in dirs)
        {
            foreach (string name in names)
            {
                string candidate = Path.Combine(dir, name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    private static bool CanRun(string fileName, string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            foreach (string a in args)
            {
                psi.ArgumentList.Add(a);
            }

            using var proc = Process.Start(psi);
            if (proc is null)
            {
                return false;
            }

            proc.StandardOutput.ReadToEnd();
            proc.StandardError.ReadToEnd();
            proc.WaitForExit();
            return proc.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }
}
