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
                psi.ArgumentList.Add("--moduleResolution");
                psi.ArgumentList.Add("node");
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
