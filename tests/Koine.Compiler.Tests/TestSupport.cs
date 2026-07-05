using System.Collections;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.Loader;
using System.Text;
using Koine.Compiler.Emit;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;

namespace Koine.Compiler.Tests;

/// <summary>Shared fixtures and a Roslyn-based compiler for emitter meta-tests.</summary>
public static class TestSupport
{
    /// <summary>The §4.2 acceptance fixture, copied next to the test assembly.</summary>
    public static string BillingFixture =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "billing.koi"));

    /// <summary>
    /// Resolves a path relative to the repository root (the directory holding <c>Koine.slnx</c>),
    /// found by walking up from the test assembly's location — never a hardcoded absolute path or a
    /// CWD assumption, so it runs the same from any working directory or build layout.
    /// </summary>
    public static string RepoPath(string relative)
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return Path.Combine(dir.FullName, relative);
            }
        }

        throw new DirectoryNotFoundException(
            $"could not locate the repo root (a directory containing Koine.slnx) walking up from {AppContext.BaseDirectory}");
    }

    /// <summary>Reads a generated smart-enum member (a public static readonly field) by name.</summary>
    public static object EnumValue(Type enumType, string name) =>
        enumType.GetField(name, BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;

    /// <summary>
    /// Yields each framed JSON-RPC message body from a raw <c>Content-Length</c>-framed LSP session
    /// transcript. Shared by the LSP wire tests so the framing logic lives in one place (issue #304).
    /// </summary>
    public static IEnumerable<string> JsonRpcFrames(string transcript)
    {
        var i = 0;
        while (true)
        {
            var marker = transcript.IndexOf("Content-Length: ", i, StringComparison.Ordinal);
            if (marker < 0)
            {
                yield break;
            }

            var numStart = marker + "Content-Length: ".Length;
            var numEnd = transcript.IndexOf("\r\n", numStart, StringComparison.Ordinal);
            var len = int.Parse(transcript.Substring(numStart, numEnd - numStart));
            var bodyStart = transcript.IndexOf("\r\n\r\n", numEnd, StringComparison.Ordinal) + 4;
            yield return transcript.Substring(bodyStart, len);
            i = bodyStart + len;
        }
    }

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
    /// <para>When <paramref name="runRegexGenerator"/> is set, the in-box
    /// <c>System.Text.RegularExpressions.Generator</c> source generator is run over the compilation first,
    /// so a <c>[GeneratedRegex]</c> partial method gets its implementing body (issue #795) — without it the
    /// declaration-only partial method fails the compile, which is exactly what proves the generator ran.
    /// The generator is a no-op for code that contains no <c>[GeneratedRegex]</c>, so callers that don't
    /// need it leave it off and stay byte-identical to before.</para>
    /// </summary>
    public static (Assembly? Assembly, IReadOnlyList<string> Errors) Compile(
        IEnumerable<EmittedFile> files, bool runRegexGenerator = false)
    {
        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Contents, path: f.RelativePath))
            .ToList();

        var tpa = (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        Compilation compilation = CSharpCompilation.Create(
            assemblyName: "KoineGenerated_" + Guid.NewGuid().ToString("N"),
            syntaxTrees: trees,
            references: tpa,
            options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary,
                nullableContextOptions: NullableContextOptions.Enable));

        if (runRegexGenerator && _regexGenerator.Value is { } generator)
        {
            try
            {
                CSharpGeneratorDriver.Create(generator)
                    .RunGeneratorsAndUpdateCompilation(compilation, out Compilation updated, out _);
                compilation = updated;
            }
            catch
            {
                // A generator that loads but throws DURING the run (e.g. Roslyn API drift against the test's
                // pinned Microsoft.CodeAnalysis) must not crash the suite — leave `compilation` un-augmented so
                // the missing [GeneratedRegex] body surfaces as a clear CS8795 instead of an obscure exception.
            }
        }

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

    // Resolved once, thread-safely: xUnit runs test classes in parallel, so a plain
    // resolve-and-cache pair could let one thread observe "resolved" before the generator field was assigned.
    private static readonly Lazy<ISourceGenerator?> _regexGenerator = new(ResolveRegexGenerator);

    /// <summary>
    /// Loads the in-box <c>System.Text.RegularExpressions.Generator</c> source generator from the .NET
    /// ref-pack analyzers so the Roslyn meta-test can run it (issue #795). Returns <c>null</c> when no
    /// analyzer pack can be located or the generator fails to load (e.g. a Roslyn version mismatch) — the
    /// caller then falls back to a plain compile, and a source-generated test fails loudly on the missing
    /// <c>[GeneratedRegex]</c> body rather than passing silently. The .NET SDK ships this generator in-box, so
    /// it is present wherever the suite builds. Invoked once through <see cref="_regexGenerator"/>.
    /// </summary>
    private static ISourceGenerator? ResolveRegexGenerator()
    {
        try
        {
            if (FindRegexGeneratorAssembly() is not { } dll)
            {
                return null;
            }

            Assembly asm = Assembly.LoadFrom(dll);

            // The analyzer assembly bundles several generators; some sibling types reference
            // Microsoft.CodeAnalysis.Workspaces, which the test process does not load, so a blanket
            // GetTypes() throws ReflectionTypeLoadException. The RegexGenerator itself needs no Workspaces,
            // so fetch it by name first; fall back to the partial type list the exception still carries.
            Type? generatorType = asm.GetType("System.Text.RegularExpressions.Generator.RegexGenerator");
            if (generatorType is null)
            {
                Type?[] loadable;
                try
                {
                    loadable = asm.GetTypes();
                }
                catch (ReflectionTypeLoadException rtle)
                {
                    loadable = rtle.Types;
                }

                generatorType = loadable.FirstOrDefault(t =>
                    t is not null && !t.IsAbstract && typeof(IIncrementalGenerator).IsAssignableFrom(t));
            }

            if (generatorType is null || Activator.CreateInstance(generatorType) is not IIncrementalGenerator incremental)
            {
                return null;
            }

            return incremental.AsSourceGenerator();
        }
        catch
        {
            // A load/instantiation failure (e.g. analyzer built against a newer Roslyn) must not crash the
            // suite — fall back to a plain compile so the missing method body surfaces as a clear error.
            return null;
        }
    }

    /// <summary>
    /// Locates <c>System.Text.RegularExpressions.Generator.dll</c> in a
    /// <c>Microsoft.NETCore.App.Ref/&lt;ver&gt;/analyzers/dotnet/cs/</c> folder, preferring the ref pack
    /// whose major version matches the running runtime (falling back to the highest available). The dotnet
    /// roots are derived from the running shared framework and the <c>DOTNET_ROOT</c> env var, so this works
    /// from any working directory and on CI.
    /// </summary>
    private static string? FindRegexGeneratorAssembly()
    {
        const string dllName = "System.Text.RegularExpressions.Generator.dll";
        int runtimeMajor = Environment.Version.Major;

        foreach (string root in DotnetRoots())
        {
            string refPacks = Path.Combine(root, "packs", "Microsoft.NETCore.App.Ref");
            if (!Directory.Exists(refPacks))
            {
                continue;
            }

            var candidates = Directory.EnumerateDirectories(refPacks)
                .Select(d => (Dir: d, Ver: ParseRefPackVersion(Path.GetFileName(d))))
                .OrderByDescending(x => x.Ver?.Major == runtimeMajor) // major-matching packs first
                .ThenByDescending(x => x.Ver ?? new Version(0, 0))     // then highest version (unparseable last)
                .Select(x => Path.Combine(x.Dir, "analyzers", "dotnet", "cs", dllName));

            if (candidates.FirstOrDefault(File.Exists) is { } found)
            {
                return found;
            }
        }

        return null;
    }

    /// <summary>
    /// Parses a ref-pack folder name to its numeric version, tolerating a prerelease suffix
    /// (e.g. <c>10.0.0-rc.2.24473.5</c> → <c>10.0.0</c>) so preview SDKs are not silently skipped. Returns
    /// <c>null</c> when the numeric core does not parse.
    /// </summary>
    private static Version? ParseRefPackVersion(string folderName) =>
        Version.TryParse(folderName.Split('-', 2)[0], out Version? v) ? v : null;

    /// <summary>The candidate .NET install roots: the one hosting the running shared framework, then <c>DOTNET_ROOT</c>.</summary>
    private static IEnumerable<string> DotnetRoots()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);

        // typeof(object) lives in the shared framework dir: <root>/shared/Microsoft.NETCore.App/<ver>/.
        if (Path.GetDirectoryName(typeof(object).Assembly.Location) is { Length: > 0 } runtimeDir
            && new DirectoryInfo(runtimeDir).Parent?.Parent?.Parent?.FullName is { } root
            && seen.Add(root))
        {
            yield return root;
        }

        if (Environment.GetEnvironmentVariable("DOTNET_ROOT") is { Length: > 0 } envRoot && seen.Add(envRoot))
        {
            yield return envRoot;
        }
    }

    /// <summary>
    /// A compiled-and-loaded generated model wired to a fresh SQLite in-memory database, so an emitter
    /// meta-test can prove the EF Core Infrastructure layer (issue #128) actually MATERIALIZES — insert
    /// a row then query it back — not merely that it compiles (which the Roslyn <see cref="Compile"/>
    /// harness already proves). The in-memory database lives only as long as the single shared
    /// connection stays open, so every <see cref="NewContext"/> sees the same store; the harness owns
    /// that connection and closes it on <see cref="Dispose"/>.
    /// </summary>
    public sealed class EfRoundTripHarness : IDisposable
    {
        private readonly SqliteConnection _connection;
        private bool _schemaCreated;

        /// <summary>The loaded assembly the emitted infrastructure compiled into.</summary>
        public Assembly Assembly { get; }

        /// <summary>The generated <c>DbContext</c> type this harness builds contexts for.</summary>
        public Type ContextType { get; }

        private EfRoundTripHarness(Assembly assembly, Type contextType, SqliteConnection connection)
        {
            Assembly = assembly;
            ContextType = contextType;
            _connection = connection;
        }

        /// <summary>
        /// Compiles the emitted files, loads the assembly, and opens a SQLite in-memory connection bound
        /// to the generated <c>DbContext</c> named <paramref name="dbContextTypeName"/>. Throws with the
        /// compiler errors when emission does not compile, so a broken emit fails loudly here rather than
        /// surfacing as a confusing reflection error later.
        /// </summary>
        public static EfRoundTripHarness Create(IEnumerable<EmittedFile> files, string dbContextTypeName)
        {
            var (assembly, errors) = Compile(files);
            if (assembly is null)
            {
                throw new InvalidOperationException(
                    "the generated infrastructure did not compile:\n" + string.Join("\n", errors));
            }

            var contextType = assembly.GetTypes().Single(t => t.Name == dbContextTypeName);
            var connection = new SqliteConnection("DataSource=:memory:");
            connection.Open();
            return new EfRoundTripHarness(assembly, contextType, connection);
        }

        /// <summary>The single generated type with the given simple name (namespace-agnostic).</summary>
        public Type Type(string simpleName) => Assembly.GetTypes().Single(t => t.Name == simpleName);

        /// <summary>
        /// A fresh <see cref="DbContext"/> over the shared in-memory connection. The first call creates
        /// the schema (<c>EnsureCreated</c>); later calls reuse it, so a write context and a read context
        /// see the same database — exactly the insert-then-query shape a round-trip test needs.
        /// </summary>
        public DbContext NewContext()
        {
            var builderType = typeof(DbContextOptionsBuilder<>).MakeGenericType(ContextType);
            var builder = (DbContextOptionsBuilder)Activator.CreateInstance(builderType)!;
            builder.UseSqlite(_connection);
            // DbContextOptionsBuilder<TContext> shadows the base Options with `new` (it returns the
            // strongly-typed DbContextOptions<TContext> the generated ctor needs), so resolve the
            // DECLARED property to avoid an ambiguous match against the base's Options.
            var options = builderType
                .GetProperty("Options", BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)!
                .GetValue(builder)!;
            var context = (DbContext)Activator.CreateInstance(ContextType, options)!;
            if (!_schemaCreated)
            {
                context.Database.EnsureCreated();
                _schemaCreated = true;
            }

            return context;
        }

        /// <summary>Every persisted entity of <paramref name="entityType"/>, materialized from the store.</summary>
        public static IReadOnlyList<object> Query(DbContext context, Type entityType)
        {
            var set = typeof(DbContext)
                .GetMethods()
                .Single(m => m.Name == nameof(DbContext.Set) && m.IsGenericMethodDefinition && m.GetParameters().Length == 0)
                .MakeGenericMethod(entityType)
                .Invoke(context, null)!;
            return ((IEnumerable)set).Cast<object>().ToList();
        }

        public void Dispose() => _connection.Dispose();
    }

    /// <summary>The env var that opts conformance suites into REQUIRING every target toolchain.</summary>
    internal const string RequireConformanceEnvVar = "KOINE_REQUIRE_CONFORMANCE";

    /// <summary>
    /// Parses a <see cref="RequireConformanceEnvVar"/> value: truthy = <c>1</c> or <c>true</c>
    /// (case-insensitive); anything else, including <c>null</c>/empty, is <c>false</c>. Pure (takes the
    /// value rather than reading the environment) so the branch logic can be unit-tested without mutating
    /// the process-wide environment — which would otherwise risk leaking into a parallel conformance suite.
    /// </summary>
    internal static bool ParseRequireConformance(string? value) =>
        value is { Length: > 0 } v && (v == "1" || v.Equals("true", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Whether the conformance suites must REQUIRE every target toolchain to be present, reading
    /// <see cref="RequireConformanceEnvVar"/> live (see <see cref="ParseRequireConformance"/>). CI sets
    /// this so a missing toolchain is a hard failure rather than a silent skip; locally it is unset so the
    /// suite stays green without foreign toolchains.
    /// </summary>
    public static bool RequireConformance =>
        ParseRequireConformance(Environment.GetEnvironmentVariable(RequireConformanceEnvVar));

    /// <summary>
    /// The single decision point every conformance suite funnels its "is the target toolchain present?"
    /// check through, so no target can silently no-op. Delegates to
    /// <see cref="RequireOrSkip(bool, string, bool)"/> with the live <see cref="RequireConformance"/> flag.
    /// </summary>
    public static void RequireOrSkip(bool toolchainAvailable, string notice) =>
        RequireOrSkip(toolchainAvailable, notice, RequireConformance);

    /// <summary>
    /// Three-way decision, with <paramref name="requireConformance"/> supplied explicitly so the branch
    /// logic is unit-testable without touching the process environment:
    /// <list type="bullet">
    /// <item><description><paramref name="toolchainAvailable"/> is <c>true</c> → returns, letting the
    /// caller run its real type-check assertion.</description></item>
    /// <item><description>absent and <paramref name="requireConformance"/> is set → <see cref="Assert.Fail"/>
    /// with <paramref name="notice"/>, turning a missing toolchain into a red test (CI's contract).</description></item>
    /// <item><description>absent and the flag is off → <see cref="Assert.Skip"/> with
    /// <paramref name="notice"/>, surfacing the gap as xUnit <c>Skipped</c> rather than a false Passed.</description></item>
    /// </list>
    /// </summary>
    internal static void RequireOrSkip(bool toolchainAvailable, string notice, bool requireConformance)
    {
        if (toolchainAvailable)
        {
            return;
        }

        if (requireConformance)
        {
            Assert.Fail(notice);
        }
        else
        {
            Assert.Skip(notice);
        }
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

        // Materialize once: the source is enumerated several times below (write loop, tsconfig
        // probe, file-list build), so guard against re-enumerating a lazy IEnumerable.
        var fileList = files.ToList();

        string root = Path.Combine(Path.GetTempPath(), "koine-tsc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (EmittedFile f in fileList)
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
            var hasTsconfig = fileList.Any(f => string.Equals(f.RelativePath, "tsconfig.json", StringComparison.OrdinalIgnoreCase));
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
                foreach (EmittedFile f in fileList.Where(f => f.RelativePath.EndsWith(".ts", StringComparison.OrdinalIgnoreCase)))
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
    /// Result of transpiling emitted TypeScript with <c>tsc</c> and executing it with <c>node</c>
    /// against a caller-supplied driver script. <see cref="ToolchainAvailable"/> is false when no
    /// Node/<c>tsc</c> toolchain could be located; <see cref="Ok"/> reflects whether the transpile and
    /// the node run both exited zero. <see cref="Stdout"/> carries the driver's captured output for the
    /// caller to assert against.
    /// </summary>
    public readonly record struct NodeRun(bool ToolchainAvailable, bool Ok, string Stdout, IReadOnlyList<string> Errors)
    {
        /// <summary>A skipped result: no toolchain present, so nothing was executed.</summary>
        public static NodeRun Skipped { get; } =
            new(ToolchainAvailable: false, Ok: false, Stdout: string.Empty, Errors: Array.Empty<string>());
    }

    /// <summary>
    /// Writes the emitted TypeScript to a fresh temp directory alongside a caller-supplied
    /// <paramref name="driver"/> script (saved as <c>__driver.ts</c>), transpiles everything with
    /// <c>tsc</c>, and executes the result with <c>node</c> — the TypeScript analogue of
    /// <see cref="RunPython"/>, for runtime hazards a type-check alone can't see (e.g. whether a
    /// rounding rule actually evaluates to the expected number, not just that it type-checks). The
    /// emitted code uses ESM with extensionless relative imports, so the temp directory is marked as an
    /// ESM package with a resolve hook that appends <c>.js</c> for Node to load the transpiled output
    /// as-is. When no Node/<c>tsc</c> toolchain is found the result is <see cref="NodeRun.Skipped"/> so
    /// the suite stays green without one; CI installs the toolchain and runs this for real.
    /// </summary>
    public static NodeRun RunTypeScript(IEnumerable<EmittedFile> files, string driver)
    {
        if (ResolveTsc() is not { } tsc || ResolveNode() is not { } node)
        {
            return NodeRun.Skipped;
        }

        var fileList = files.ToList();
        string root = Path.Combine(Path.GetTempPath(), "koine-tsrun-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (EmittedFile f in fileList)
            {
                // Transpile by passing .ts files explicitly rather than via the emitter's shipped
                // tsconfig.json (a present-but-unused tsconfig makes tsc error with TS5112).
                if (string.Equals(f.RelativePath, "tsconfig.json", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
            }

            File.WriteAllText(Path.Combine(root, "package.json"), "{ \"type\": \"module\" }\n");
            File.WriteAllText(Path.Combine(root, "__loader.mjs"), EsmExtensionLoader);
            File.WriteAllText(Path.Combine(root, "__register.mjs"),
                "import { register } from 'node:module';\nregister('./__loader.mjs', import.meta.url);\n");
            File.WriteAllText(Path.Combine(root, "__driver.ts"), driver);

            var tscArgs = new List<string>(tsc.Arguments)
            {
                "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "bundler",
                "--strict", "--skipLibCheck",
            };
            tscArgs.AddRange(Directory.GetFiles(root, "*.ts", SearchOption.AllDirectories)
                .Select(ts => Path.GetRelativePath(root, ts)));

            if (RunProcess(tsc.FileName, tscArgs, root) is not { } tscRun)
            {
                return NodeRun.Skipped;
            }
            if (tscRun.ExitCode != 0)
            {
                var tscErrors = (tscRun.StdOut + tscRun.StdErr)
                    .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
                return new NodeRun(ToolchainAvailable: true, Ok: false, Stdout: string.Empty, Errors: tscErrors);
            }

            var nodeArgs = new List<string>(node.Arguments) { "--import", "./__register.mjs", "__driver.js" };
            if (RunProcess(node.FileName, nodeArgs, root) is not { } nodeRun)
            {
                return NodeRun.Skipped;
            }
            if (nodeRun.ExitCode != 0)
            {
                var nodeErrors = (nodeRun.StdOut + nodeRun.StdErr)
                    .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
                return new NodeRun(ToolchainAvailable: true, Ok: false, Stdout: nodeRun.StdOut, Errors: nodeErrors);
            }

            return new NodeRun(ToolchainAvailable: true, Ok: true, Stdout: nodeRun.StdOut, Errors: Array.Empty<string>());
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>
    /// An ESM resolve hook that appends <c>.js</c> to extensionless relative specifiers, so Node can
    /// load the transpiled emitter output (whose imports are extensionless, e.g.
    /// <c>'./value-objects/Money'</c>) without rewriting the generated code.
    /// </summary>
    private const string EsmExtensionLoader = """
        export async function resolve(specifier, context, nextResolve) {
          if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[mc]?js$/.test(specifier)) {
            try { return await nextResolve(specifier + '.js', context); } catch { /* fall through */ }
          }
          return nextResolve(specifier, context);
        }
        """;

    /// <summary>
    /// Locates a usable <c>node</c>: an explicit <c>KOINE_NODE</c> override (always wins), otherwise a
    /// direct <c>node</c> on PATH. Returns <c>null</c> when neither works so the caller can skip.
    /// </summary>
    private static ToolInvocation? ResolveNode()
    {
        if (Environment.GetEnvironmentVariable("KOINE_NODE") is { Length: > 0 } overrideNode)
        {
            return new ToolInvocation(overrideNode, Array.Empty<string>());
        }

        return OnPath("node") is { } node ? new ToolInvocation(node, Array.Empty<string>()) : null;
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

    /// <summary>
    /// Writes the emitted Python files to a fresh temp directory and EXECUTES <paramref name="driver"/>
    /// against them — the Python analogue of the Roslyn run-the-emitted-code meta-test, for runtime
    /// hazards that <c>mypy</c>/<c>ast.parse</c> can't see (e.g. a frozen dataclass that type-checks
    /// fine but throws <c>TypeError: unhashable type: 'dict'</c> when hashed). The driver runs as a
    /// script in the package root, so it imports the emitted modules directly. When no interpreter is
    /// found the result is <see cref="PythonCheck.Skipped"/> so the suite stays green without a Python
    /// toolchain; when one IS present a non-zero exit (an uncaught exception) yields <c>Ok == false</c>
    /// with stdout/stderr captured.
    /// </summary>
    public static PythonCheck RunPython(IEnumerable<EmittedFile> files, string driver)
    {
        var fileList = files.ToList();
        if (ResolvePython() is not { } python)
        {
            return PythonCheck.Skipped;
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-pyrun-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            foreach (EmittedFile f in fileList)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
            }

            string driverPath = Path.Combine(root, "_koine_driver.py");
            File.WriteAllText(driverPath, driver);

            var args = new List<string>(python.Arguments) { driverPath };
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
    /// <remarks><c>internal</c> (not <c>private</c>) purely so the same-assembly deadlock regression
    /// test can read the captured streams; it is not part of any public contract.</remarks>
    internal readonly record struct ProcessRun(int ExitCode, string StdOut, string StdErr);

    /// <summary>
    /// Runs a process to completion in <paramref name="workingDirectory"/>, capturing its exit code,
    /// stdout, and stderr. Returns <c>null</c> when the process fails to even start (e.g. a broken
    /// shebang) so callers can fall through to the next candidate instead of crashing.
    /// </summary>
    /// <remarks>
    /// stdout and stderr are drained <em>concurrently</em> — both <see cref="StreamReader.ReadToEndAsync()"/>
    /// tasks are started before either is awaited — rather than one-stream-to-EOF-then-the-other. Reading
    /// them sequentially is the classic <see cref="Process"/> redirection deadlock: if the child fills the
    /// OS pipe buffer of the stream being read <em>second</em> while the parent is still blocked draining
    /// the first, neither side can make progress and <see cref="Process.WaitForExit()"/> is never reached.
    /// <c>internal</c> (not <c>private</c>) only so the same-assembly regression test can exercise it.
    /// </remarks>
    internal static ProcessRun? RunProcess(
        string fileName,
        IReadOnlyList<string> args,
        string? workingDirectory = null,
        IReadOnlyDictionary<string, string>? environment = null)
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

            if (environment is not null)
            {
                foreach (var (key, value) in environment)
                {
                    psi.Environment[key] = value;
                }
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

            // Drain both pipes concurrently — see the remarks above: reading one stream to EOF before
            // touching the other deadlocks the moment the child fills the second stream's pipe buffer.
            Task<string> stdoutTask = proc.StandardOutput.ReadToEndAsync();
            Task<string> stderrTask = proc.StandardError.ReadToEndAsync();
            Task.WaitAll(stdoutTask, stderrTask);
            proc.WaitForExit();
            return new ProcessRun(proc.ExitCode, stdoutTask.Result, stderrTask.Result);
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
    // Rust conformance harness (the cargo analogue of the Roslyn Compile harness)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Result of a Rust compile run. <see cref="ToolchainAvailable"/> is false when no usable
    /// <c>cargo</c> could be located OR when <c>cargo</c> is present but cannot reach the crate
    /// registry to fetch dependencies (an offline runner) — in both cases callers SKIP (not fail) so
    /// <c>dotnet test</c> stays green without a working Rust toolchain. When the toolchain IS usable,
    /// <see cref="Ok"/> reflects whether <c>cargo check</c> reported errors.
    /// </summary>
    public readonly record struct RustCheck(bool ToolchainAvailable, bool Ok, IReadOnlyList<string> Errors)
    {
        /// <summary>A skipped result: no usable toolchain present, so nothing was verified.</summary>
        public static RustCheck Skipped { get; } =
            new(ToolchainAvailable: false, Ok: false, Errors: Array.Empty<string>());
    }

    /// <summary>
    /// Writes the emitted Rust files to a fresh temp crate and compiles them with
    /// <c>cargo check</c> — the same role the Roslyn <see cref="Compile"/> harness plays for C#. When
    /// the emitted files include a <c>Cargo.toml</c> it is used as-is (validating EXACTLY the manifest
    /// users get); otherwise a minimal dependency-free manifest is synthesized and the emitted modules
    /// are placed under <c>src/</c> with a generated <c>lib.rs</c> that declares them (the analogue of
    /// the mypy <c>--config-file</c> vs <c>--strict</c> split).
    /// <para>
    /// When no <c>cargo</c> is found — or <c>cargo</c> is present but the run fails because crate
    /// dependencies cannot be fetched on an offline runner — the result is
    /// <see cref="RustCheck.Skipped"/> so the suite stays green. It NEVER silently passes a real
    /// compile error and NEVER fails merely because the toolchain is missing/offline. CI is expected
    /// to provide a networked Rust toolchain and therefore actually run the check.
    /// </para>
    /// </summary>
    public static RustCheck CompileRust(IEnumerable<EmittedFile> files)
    {
        var fileList = files.ToList();
        if (ResolveCargo() is not { } cargo)
        {
            return RustCheck.Skipped;
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-cargo-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            bool hasManifest = fileList.Any(f => string.Equals(f.RelativePath, "Cargo.toml", StringComparison.Ordinal));
            foreach (EmittedFile f in fileList)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
            }

            if (!hasManifest)
            {
                // Hand-authored fixture with no manifest: synthesize a minimal, dependency-free crate.
                File.WriteAllText(Path.Combine(root, "Cargo.toml"), MinimalCargoToml);
            }

            // Reuse one shared target dir across runs so the (potentially many) dependency builds
            // compile once, not per test — a big speed-up that keeps the harness deterministic.
            string targetDir = Path.Combine(Path.GetTempPath(), "koine-cargo-target");
            var env = new Dictionary<string, string> { ["CARGO_TARGET_DIR"] = targetDir };

            var args = new List<string>(cargo.Arguments) { "check", "--quiet" };
            if (RunProcess(cargo.FileName, args, root, env) is not { } run)
            {
                return RustCheck.Skipped;
            }

            if (run.ExitCode == 0)
            {
                return new RustCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            // An offline runner cannot fetch crates.io dependencies; that is an environment limitation,
            // not a defect in the emitted code, so report it as a skip (toolchain unusable) rather than
            // a failure — exactly how an absent toolchain is treated.
            string output = run.StdOut + run.StdErr;
            if (IsCargoFetchFailure(output))
            {
                return RustCheck.Skipped;
            }

            var errors = output
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
            return new RustCheck(ToolchainAvailable: true, Ok: false, errors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>A minimal dependency-free <c>Cargo.toml</c> for a hand-authored Rust fixture.</summary>
    private const string MinimalCargoToml =
        "[package]\n" +
        "name = \"koine-fixture\"\n" +
        "version = \"0.0.0\"\n" +
        "edition = \"2021\"\n" +
        "\n" +
        "[lib]\n" +
        "path = \"src/lib.rs\"\n";

    /// <summary>
    /// True when a failed <c>cargo</c> run reflects an inability to reach the crate registry / fetch
    /// dependencies (an offline runner), as opposed to a genuine compile error in the emitted code.
    /// </summary>
    private static bool IsCargoFetchFailure(string output)
    {
        string[] markers =
        {
            "failed to download",
            "failed to get ",
            "failed to fetch",
            "failed to load source",
            "no matching package",
            "Couldn't resolve host",
            "could not connect",
            "Network failure",
            "error sending request",
            "failed to query replaced source",
            "spurious network error",
            "Blocking waiting for file lock on package cache",
            "the registry index",
            "offline",
        };
        foreach (string marker in markers)
        {
            if (output.Contains(marker, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Locates a usable <c>cargo</c>: an explicit <c>KOINE_CARGO</c> override (always wins) or a
    /// direct <c>cargo</c> on PATH. Returns <c>null</c> when none launches so the caller can skip.
    /// </summary>
    private static ToolInvocation? ResolveCargo()
    {
        if (Environment.GetEnvironmentVariable("KOINE_CARGO") is { Length: > 0 } overrideCargo)
        {
            return new ToolInvocation(overrideCargo, Array.Empty<string>());
        }

        if (OnPath("cargo") is { } found && CanRun(found, ["--version"]))
        {
            return new ToolInvocation(found, Array.Empty<string>());
        }

        return null;
    }

    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // OpenAPI conformance harness (issue #126; mirrors the external-toolchain harnesses above)
    // -------------------------------------------------------------------------

    /// <summary>
    /// Result of an OpenAPI document-validation run. <see cref="ToolchainAvailable"/> is false when
    /// validation is not opted into (the <c>KOINE_OPENAPI_VALIDATE</c> env var is unset) OR no validator
    /// could be located — callers SKIP (not fail) in that case so <c>dotnet test</c> stays green without
    /// a validator. When the toolchain IS usable, <see cref="Ok"/> reflects whether the validator
    /// accepted every emitted <c>openapi.yaml</c>.
    /// </summary>
    public readonly record struct OpenApiCheck(bool ToolchainAvailable, bool Ok, IReadOnlyList<string> Errors)
    {
        /// <summary>A skipped result: validation not enabled / no validator present, so nothing was verified.</summary>
        public static OpenApiCheck Skipped { get; } =
            new(ToolchainAvailable: false, Ok: false, Errors: Array.Empty<string>());
    }

    /// <summary>
    /// Validates every emitted <c>openapi.yaml</c> with a real OpenAPI validator — the document-spec
    /// analogue of the Roslyn <see cref="Compile"/> harness. Validation is OPT-IN: it only runs when
    /// <c>KOINE_OPENAPI_VALIDATE</c> is set, because most dev/CI machines carry no OpenAPI validator and
    /// the emitted YAML is otherwise snapshot-tested. When enabled, the validator is resolved from
    /// <c>KOINE_OPENAPI_VALIDATOR</c> (an explicit command, optionally with leading args) or a known tool
    /// on PATH (<c>openapi-spec-validator</c>, <c>swagger-cli validate</c>, <c>redocly lint</c>). Absent
    /// any of that, the result is <see cref="OpenApiCheck.Skipped"/> so the suite stays green — it NEVER
    /// silently passes a real validation error and NEVER fails merely because no validator is present.
    /// </summary>
    public static OpenApiCheck ValidateOpenApi(IEnumerable<EmittedFile> files)
    {
        if (Environment.GetEnvironmentVariable("KOINE_OPENAPI_VALIDATE") is not { Length: > 0 })
        {
            return OpenApiCheck.Skipped;
        }

        if (ResolveOpenApiValidator() is not { } validator)
        {
            return OpenApiCheck.Skipped;
        }

        var fileList = files.ToList();
        string root = Path.Combine(Path.GetTempPath(), "koine-openapi-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var specs = new List<string>();
            foreach (EmittedFile f in fileList)
            {
                string path = Path.Combine(root, f.RelativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                File.WriteAllText(path, f.Contents);
                if (f.RelativePath.EndsWith("openapi.yaml", StringComparison.OrdinalIgnoreCase))
                {
                    specs.Add(path);
                }
            }

            if (specs.Count == 0)
            {
                // Nothing to validate — vacuously OK (a validator was found).
                return new OpenApiCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            var errors = new List<string>();
            foreach (string spec in specs)
            {
                var args = new List<string>(validator.Arguments) { spec };
                if (RunProcess(validator.FileName, args, root) is not { } run)
                {
                    // The validator refused to launch; treat as no toolchain.
                    return OpenApiCheck.Skipped;
                }

                if (run.ExitCode != 0)
                {
                    errors.AddRange((run.StdOut + run.StdErr)
                        .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
                }
            }

            return errors.Count == 0
                ? new OpenApiCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>())
                : new OpenApiCheck(ToolchainAvailable: true, Ok: false, errors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>
    /// Locates a usable OpenAPI validator. Order: <c>KOINE_OPENAPI_VALIDATOR</c> override (a command,
    /// optionally with leading args) → <c>openapi-spec-validator</c> → <c>swagger-cli validate</c> →
    /// <c>redocly lint</c>. Returns <c>null</c> when none works so the caller can skip.
    /// </summary>
    private static ToolInvocation? ResolveOpenApiValidator()
    {
        if (Environment.GetEnvironmentVariable("KOINE_OPENAPI_VALIDATOR") is { Length: > 0 } overrideValidator)
        {
            string[] parts = overrideValidator.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            // A whitespace-only override splits to nothing; fall through to PATH discovery rather than
            // indexing into an empty array (the harness must skip, never crash).
            if (parts.Length > 0)
            {
                return new ToolInvocation(parts[0], parts.Skip(1).ToArray());
            }
        }

        if (OnPath("openapi-spec-validator") is { } ospec && CanRun(ospec, ["--help"]))
        {
            return new ToolInvocation(ospec, Array.Empty<string>());
        }

        if (OnPath("swagger-cli") is { } swagger && CanRun(swagger, ["--version"]))
        {
            return new ToolInvocation(swagger, ["validate"]);
        }

        if (OnPath("redocly") is { } redocly && CanRun(redocly, ["--version"]))
        {
            return new ToolInvocation(redocly, ["lint"]);
        }

        return null;
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

    /// <summary>Result of validating an AsyncAPI document with the external CLI.</summary>
    public readonly record struct AsyncApiCheck(bool ToolchainAvailable, bool Ok, IReadOnlyList<string> Errors);

    /// <summary>
    /// Validates <paramref name="yaml"/> with the AsyncAPI CLI (<c>asyncapi validate</c>), resolved
    /// from a <c>KOINE_ASYNCAPI_CLI</c> override or an <c>asyncapi</c> on PATH. The document is written
    /// to a temp file the CLI reads. Returns <c>ToolchainAvailable: false</c> when no CLI is found, so
    /// the caller can mark the conformance INCONCLUSIVE rather than fail.
    /// </summary>
    public static AsyncApiCheck ValidateAsyncApi(string yaml)
    {
        string? cli = Environment.GetEnvironmentVariable("KOINE_ASYNCAPI_CLI") is { Length: > 0 } overrideCli
            ? overrideCli
            : OnPath("asyncapi");
        if (cli is null || !CanRun(cli, ["--version"]))
        {
            return new AsyncApiCheck(ToolchainAvailable: false, Ok: false, Array.Empty<string>());
        }

        string root = Path.Combine(Path.GetTempPath(), "koine-asyncapi-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            string file = Path.Combine(root, "asyncapi.yaml");
            File.WriteAllText(file, yaml);

            ProcessRun? run = RunProcess(cli, ["validate", file], workingDirectory: root);
            if (run is not { } result)
            {
                return new AsyncApiCheck(ToolchainAvailable: false, Ok: false, Array.Empty<string>());
            }

            if (result.ExitCode == 0)
            {
                return new AsyncApiCheck(ToolchainAvailable: true, Ok: true, Array.Empty<string>());
            }

            var errors = (result.StdErr + "\n" + result.StdOut)
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .ToList();
            return new AsyncApiCheck(ToolchainAvailable: true, Ok: false, errors);
        }
        finally
        {
            try { Directory.Delete(root, recursive: true); } catch { /* best-effort cleanup */ }
        }
    }
}
