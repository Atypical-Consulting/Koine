using System.Reflection;
using System.Runtime.Loader;
using Koine.Compiler.Emit;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Koine.Execution;

/// <summary>
/// Compiles emitted C# in memory with Roslyn and loads the result, so a caller can actually RUN a
/// generated model — the engine behind both the emitter meta-tests and the scenario runner (issue #236).
/// </summary>
public static class GeneratedAssemblyCompiler
{
    /// <summary>
    /// Compiles emitted C# in-memory with Roslyn against the running framework's
    /// reference set. Returns the loaded assembly on success, or the error list.
    /// <para>When <paramref name="runRegexGenerator"/> is set, the in-box
    /// <c>System.Text.RegularExpressions.Generator</c> source generator is run over the compilation first,
    /// so a <c>[GeneratedRegex]</c> partial method gets its implementing body (issue #795) — without it the
    /// declaration-only partial method fails the compile, which is exactly what proves the generator ran.
    /// The generator is a no-op for code that contains no <c>[GeneratedRegex]</c>, so callers that don't
    /// need it leave it off and stay byte-identical to before.</para>
    /// <para><paramref name="loadContext"/> selects where the emitted assembly is loaded. It defaults to
    /// <see cref="AssemblyLoadContext.Default"/> — the historical behaviour, which never unloads — so a
    /// caller that compiles repeatedly (a scenario runner) can pass its own COLLECTIBLE context and
    /// reclaim each generated assembly by unloading it.</para>
    /// </summary>
    public static (Assembly? Assembly, IReadOnlyList<string> Errors) Compile(
        IReadOnlyList<EmittedFile> files, bool runRegexGenerator = false, AssemblyLoadContext? loadContext = null)
    {
        var trees = files
            .Select(f => CSharpSyntaxTree.ParseText(f.Contents, path: f.RelativePath))
            .ToList();

        Compilation compilation = CSharpCompilation.Create(
            assemblyName: "KoineGenerated_" + Guid.NewGuid().ToString("N"),
            syntaxTrees: trees,
            references: _frameworkReferences.Value,
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
                // A generator that loads but throws DURING the run (e.g. Roslyn API drift against this
                // assembly's pinned Microsoft.CodeAnalysis) must not crash the caller — leave `compilation`
                // un-augmented so the missing [GeneratedRegex] body surfaces as a clear CS8795 instead of an
                // obscure exception.
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
        var asm = (loadContext ?? AssemblyLoadContext.Default).LoadFromStream(ms);
        return (asm, Array.Empty<string>());
    }

    // Resolved once, thread-safely: callers (xUnit, which runs test classes in parallel, and a scenario
    // runner) hit this concurrently, so a plain resolve-and-cache pair could let one thread observe
    // "resolved" before the generator field was assigned.
    private static readonly Lazy<ISourceGenerator?> _regexGenerator = new(ResolveRegexGenerator);

    /// <summary>
    /// The running framework's reference set, read from disk ONCE. It is the same 150–250 DLLs on every
    /// call, and a <see cref="MetadataReference"/> is immutable and explicitly safe to share across
    /// compilations and load contexts — re-materializing it per <see cref="Compile"/> is pure I/O the
    /// interactive "run scenario" path pays on top of a full emit and a full Roslyn compile. Same
    /// thread-safety reasoning as <see cref="_regexGenerator"/>.
    /// </summary>
    private static readonly Lazy<IReadOnlyList<MetadataReference>> _frameworkReferences =
        new(LoadFrameworkReferences);

    private static IReadOnlyList<MetadataReference> LoadFrameworkReferences() =>
        (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries)
            .Where(p => p.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

    /// <summary>
    /// Loads the in-box <c>System.Text.RegularExpressions.Generator</c> source generator from the .NET
    /// ref-pack analyzers so a compilation can run it (issue #795). Returns <c>null</c> when no
    /// analyzer pack can be located or the generator fails to load (e.g. a Roslyn version mismatch) — the
    /// caller then falls back to a plain compile, and a source-generated compilation fails loudly on the
    /// missing <c>[GeneratedRegex]</c> body rather than passing silently. The .NET SDK ships this generator
    /// in-box, so it is present wherever the repo builds. Invoked once through <see cref="_regexGenerator"/>.
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
            // Microsoft.CodeAnalysis.Workspaces, which the host process does not load, so a blanket
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
            // caller — fall back to a plain compile so the missing method body surfaces as a clear error.
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
}
