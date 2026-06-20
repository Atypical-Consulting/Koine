using CompilerEmitterRegistry = Koine.Compiler.Emit.EmitterRegistry;
using EmitterOptions = Koine.Compiler.Emit.EmitterOptions;
using IEmitter = Koine.Compiler.Emit.IEmitter;

namespace Koine.Cli.Infrastructure;

/// <summary>
/// Maps a <c>--target</c> name to the emitter that produces it. As of issue #69 (Task 5) this is a
/// thin adapter over the compiler's unified <see cref="CompilerEmitterRegistry"/>: it maps the CLI's
/// per-target <see cref="TargetOptions"/> to the host-neutral <see cref="EmitterOptions"/> and
/// delegates the actual lookup. The MCP server delegates to the very same registry, so the two
/// surfaces can never drift in which targets they support. The validation/help that reads
/// <see cref="SupportedTargets"/> follows automatically.
/// </summary>
internal static class EmitterRegistry
{
    /// <summary>The built-in-only registry, shared by the parameterless lookups.</summary>
    private static readonly CompilerEmitterRegistry BuiltIn = new();

    /// <summary>The supported target names, in display order for help and error messages.</summary>
    public static IReadOnlyList<string> SupportedTargets => BuiltIn.SupportedTargets;

    /// <summary>A comma-separated list of <see cref="SupportedTargets"/>, for messages.</summary>
    public static string SupportedList => string.Join(", ", SupportedTargets);

    public static bool IsSupported(string target) => BuiltIn.IsSupported(target);

    /// <summary>Creates the emitter for <paramref name="target"/>, or returns <c>false</c> if unknown.</summary>
    public static bool TryCreate(string target, TargetOptions options, out IEmitter emitter) =>
        BuiltIn.TryCreate(target, ToEmitterOptions(options), out emitter);

    /// <summary>
    /// Creates the emitter for <paramref name="target"/>, additionally resolving external providers
    /// from the assemblies named in <paramref name="emitterAssemblies"/> (the <c>emitters</c> config
    /// key, issue #69). A null/empty list behaves exactly like <see cref="TryCreate(string,TargetOptions,out IEmitter)"/>.
    /// </summary>
    public static bool TryCreate(
        string target,
        TargetOptions options,
        IReadOnlyList<string>? emitterAssemblies,
        out IEmitter emitter)
    {
        if (emitterAssemblies is null || emitterAssemblies.Count == 0)
        {
            return BuiltIn.TryCreate(target, ToEmitterOptions(options), out emitter);
        }

        var registry = new CompilerEmitterRegistry(Koine.Compiler.Emit.EmitterLoader.Load(emitterAssemblies));
        return registry.TryCreate(target, ToEmitterOptions(options), out emitter);
    }

    /// <summary>
    /// Maps the CLI's parsed per-target <see cref="TargetOptions"/> to the host-neutral
    /// <see cref="EmitterOptions"/> the providers consume. <see cref="TargetOptions.OutDir"/> is a
    /// build concern and is intentionally dropped here. An empty bag maps to
    /// <see cref="EmitterOptions.Empty"/>, so an unconfigured target emits byte-identical output.
    /// </summary>
    private static EmitterOptions ToEmitterOptions(TargetOptions options)
    {
        if (options.NamespaceMap.Count == 0 && options.InstantMode is null && options.Layout is null)
        {
            return EmitterOptions.Empty;
        }

        return new EmitterOptions(options.NamespaceMap, options.InstantMode, options.Layout);
    }
}
