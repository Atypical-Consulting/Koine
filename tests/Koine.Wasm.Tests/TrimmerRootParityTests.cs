using System.Text.RegularExpressions;
using Koine.Compiler.Emit;

namespace Koine.Wasm.Tests;

/// <summary>
/// The browser host runs <c>PublishTrimmed</c> with <c>TrimMode=full</c>, so every emitter assembly
/// resolved by name at runtime must be listed as a <c>&lt;TrimmerRootAssembly&gt;</c> in
/// <c>Koine.Wasm.csproj</c> — otherwise the linker drops it and the target breaks <b>only</b> in the
/// trimmed production build (the dev-JIT build keeps it), the exact prod-only failure the extraction
/// (issue #861) could reintroduce if a future emitter is added to <see cref="BuiltInEmitterProviders"/>
/// but forgotten here. This test ties the two together: add a target → this fails until it is rooted.
/// </summary>
public class TrimmerRootParityTests
{
    private static readonly IReadOnlySet<string> RootedAssemblies = ReadTrimmerRoots();

    [Fact]
    public void Every_built_in_provider_assembly_is_a_wasm_trimmer_root()
    {
        foreach (var provider in BuiltInEmitterProviders.All)
        {
            var assembly = provider.GetType().Assembly.GetName().Name!;
            RootedAssemblies.ShouldContain(
                assembly,
                $"provider '{provider.Target}' lives in {assembly}, which must be a <TrimmerRootAssembly> " +
                "in Koine.Wasm.csproj or full-trim will drop it from the browser build.");
        }
    }

    [Theory]
    [InlineData("Koine.Compiler")]   // parser + Ast + emit contracts + model utilities
    [InlineData("Koine.Emit.Common")] // shared emitter helpers
    [InlineData("Koine.Emit.All")]    // BuiltInEmitterProviders aggregator
    public void Core_and_aggregator_assemblies_are_wasm_trimmer_roots(string assembly)
    {
        RootedAssemblies.ShouldContain(assembly);
    }

    private static IReadOnlySet<string> ReadTrimmerRoots()
    {
        var csproj = Path.Combine(RepoRoot(), "src", "Koine.Wasm", "Koine.Wasm.csproj");
        var text = File.ReadAllText(csproj);
        return Regex.Matches(text, @"<TrimmerRootAssembly\s+Include=""([^""]+)""")
            .Select(m => m.Groups[1].Value)
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary>The directory holding <c>Koine.slnx</c>, walking up from the test assembly.</summary>
    private static string RepoRoot()
    {
        for (DirectoryInfo? dir = new(AppContext.BaseDirectory); dir is not null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "Koine.slnx")))
            {
                return dir.FullName;
            }
        }

        throw new InvalidOperationException(
            $"could not locate the repo root (a directory containing Koine.slnx) from {AppContext.BaseDirectory}");
    }
}
