using System.Diagnostics.CodeAnalysis;
using System.Reflection;

namespace Koine.Compiler.Emit;

/// <summary>
/// Loads external <see cref="IEmitterProvider"/> plugins from assemblies named in
/// <c>koine.config</c>'s <c>emitters</c> key (issue #69, Task 5 — opening the emitter pipeline as a
/// platform). For each assembly it reflects for public, concrete types implementing
/// <see cref="IEmitterProvider"/> with a public parameterless constructor and instantiates one of each.
/// This deliberately mirrors <see cref="Koine.Compiler.Semantics.AnalyzerLoader"/>.
///
/// <para>Loading is <b>robust</b>: an assembly that cannot be loaded, a type that cannot be inspected
/// or instantiated, is skipped — never crashing the compile. The default (no <c>emitters</c> key →
/// no paths) loads zero externals, so behavior is identical to having no plugin system.</para>
/// </summary>
public static class EmitterLoader
{
    // Discovering emitter providers means reflecting over external, user-supplied plugin assemblies named
    // in koine.config — inherently incompatible with static trim analysis. This is a CLI/MCP filesystem
    // feature: the only trimmed build (the browser-wasm publish) does no plugin loading and roots
    // Koine.Compiler whole via <TrimmerRootAssembly> (src/Koine.Wasm/Koine.Wasm.csproj), and external
    // plugin assemblies are never part of a trimmed bundle, so their types are not subject to the trimmer.
    private const string EmitterPluginsAreTrimUnsafe =
        "Reflects over external, user-supplied plugin assemblies named in koine.config. This is a " +
        "CLI/MCP filesystem feature; the only trimmed build (the browser-wasm publish) does no plugin " +
        "loading and roots Koine.Compiler whole via <TrimmerRootAssembly> (src/Koine.Wasm/Koine.Wasm.csproj), " +
        "and external plugin assemblies are never part of a trimmed bundle.";

    /// <summary>
    /// Loads every external emitter provider from the given assembly paths, in path order then
    /// discovery order within each assembly. Unresolvable paths/types are skipped silently. Returns an
    /// empty list when <paramref name="assemblyPaths"/> is null or empty.
    /// </summary>
    public static IReadOnlyList<IEmitterProvider> Load(IReadOnlyList<string>? assemblyPaths)
    {
        if (assemblyPaths is null || assemblyPaths.Count == 0)
        {
            return Array.Empty<IEmitterProvider>();
        }

        var providers = new List<IEmitterProvider>();
        foreach (var path in assemblyPaths)
        {
            LoadFromAssembly(path, providers);
        }

        return providers;
    }

    [UnconditionalSuppressMessage("Trimming", "IL2026",
        Justification = EmitterPluginsAreTrimUnsafe)]
    [UnconditionalSuppressMessage("Trimming", "IL2062",
        Justification = EmitterPluginsAreTrimUnsafe)]
    private static void LoadFromAssembly(string path, List<IEmitterProvider> sink)
    {
        Assembly assembly;
        try
        {
            // An absolute path loads directly; a bare/relative name is resolved against the loaded
            // assemblies (so a test can point the loader at its own already-loaded assembly).
            assembly = LoadAssembly(path);
        }
        catch
        {
            return; // unloadable assembly: skip, don't crash the compile
        }

        Type[] types;
        try
        {
            types = assembly.GetTypes();
        }
        catch (ReflectionTypeLoadException ex)
        {
            // Partially loadable assembly: keep the types that did resolve.
            types = ex.Types.Where(t => t is not null).Cast<Type>().ToArray();
        }
        catch
        {
            return;
        }

        foreach (Type type in types)
        {
            if (!IsLoadableProvider(type))
            {
                continue;
            }

            try
            {
                if (Activator.CreateInstance(type) is IEmitterProvider provider)
                {
                    sink.Add(provider);
                }
            }
            catch
            {
                // Constructor threw / type couldn't be instantiated: skip this one.
            }
        }
    }

    [UnconditionalSuppressMessage("Trimming", "IL2026",
        Justification = EmitterPluginsAreTrimUnsafe)]
    private static Assembly LoadAssembly(string path)
    {
        var name = SimpleName(path);

        // Prefer an already-loaded assembly matching by simple name. This lets a host reference a
        // provider baked into an assembly that is already in the load context, avoids re-loading a
        // second copy of it, and takes precedence over a same-named file in the current directory.
        Assembly? match = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => string.Equals(a.GetName().Name, name, StringComparison.OrdinalIgnoreCase));
        if (match is not null)
        {
            return match;
        }

        // A real assembly file on disk loads from its path.
        if (File.Exists(path))
        {
            return Assembly.LoadFrom(Path.GetFullPath(path));
        }

        // Fall back to a by-name load (resolves against the probing path).
        return Assembly.Load(new AssemblyName(name));
    }

    /// <summary>
    /// The assembly simple name a path/name refers to: the file name, with only a real assembly
    /// extension (<c>.dll</c>/<c>.exe</c>) stripped. A bare name like <c>Acme.Emitters</c> is returned
    /// unchanged — <see cref="Path.GetFileNameWithoutExtension"/> would wrongly drop a dotted suffix.
    /// </summary>
    private static string SimpleName(string path)
    {
        var file = Path.GetFileName(path);
        if (file.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
            || file.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
        {
            return file[..^4];
        }

        return file;
    }

    [UnconditionalSuppressMessage("Trimming", "IL2070",
        Justification = EmitterPluginsAreTrimUnsafe)]
    private static bool IsLoadableProvider(Type type)
    {
        try
        {
            // Publicly visible (a top-level public type or a public type nested only inside public
            // types), concrete, and constructible with no arguments.
            return IsPubliclyVisible(type)
                && type is { IsAbstract: false, IsInterface: false }
                && typeof(IEmitterProvider).IsAssignableFrom(type)
                && type.GetConstructor(Type.EmptyTypes) is not null;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>True when a type and every enclosing type in its nesting chain are publicly visible.</summary>
    private static bool IsPubliclyVisible(Type type)
    {
        for (Type? t = type; t is not null; t = t.DeclaringType)
        {
            if (t.IsNested)
            {
                if (!t.IsNestedPublic)
                {
                    return false;
                }
            }
            else if (!t.IsPublic)
            {
                return false;
            }
        }

        return true;
    }
}
