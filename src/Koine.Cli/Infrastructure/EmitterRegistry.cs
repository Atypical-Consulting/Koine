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
    public static string SupportedList => BuiltIn.SupportedList;

    public static bool IsSupported(string target) => BuiltIn.IsSupported(target);

    /// <summary>Creates the emitter for <paramref name="target"/>, or returns <c>false</c> if unknown.</summary>
    public static bool TryCreate(string target, TargetOptions options, out IEmitter emitter) =>
        TryCreate(target, options, emitterAssemblies: null, emitSourceMaps: false, out emitter);

    /// <summary>
    /// Creates the emitter for <paramref name="target"/>, additionally resolving external providers
    /// from the assemblies named in <paramref name="emitterAssemblies"/> (the <c>emitters</c> config
    /// key, issue #69), toggling source-map debug info via <paramref name="emitSourceMaps"/>
    /// (the <c>--source-maps</c> flag) and reference-only emit via <paramref name="referenceOnly"/>
    /// (the <c>--reference-only</c> flag). A null/empty assembly list with both flags off behaves
    /// exactly like <see cref="TryCreate(string,TargetOptions,out IEmitter)"/>.
    /// </summary>
    public static bool TryCreate(
        string target,
        TargetOptions options,
        IReadOnlyList<string>? emitterAssemblies,
        bool emitSourceMaps,
        bool referenceOnly,
        out IEmitter emitter) =>
        TryCreateCore(target, options, emitterAssemblies, emitSourceMaps, referenceOnly, out emitter);

    /// <summary>
    /// Back-compat overload without the <c>--reference-only</c> flag (defaults off). Equivalent to the
    /// six-argument overload with <c>referenceOnly: false</c>.
    /// </summary>
    public static bool TryCreate(
        string target,
        TargetOptions options,
        IReadOnlyList<string>? emitterAssemblies,
        bool emitSourceMaps,
        out IEmitter emitter) =>
        TryCreateCore(target, options, emitterAssemblies, emitSourceMaps, referenceOnly: false, out emitter);

    /// <summary>
    /// Back-compat overload without the <c>--source-maps</c>/<c>--reference-only</c> flags (both off).
    /// </summary>
    public static bool TryCreate(
        string target,
        TargetOptions options,
        IReadOnlyList<string>? emitterAssemblies,
        out IEmitter emitter) =>
        TryCreateCore(target, options, emitterAssemblies, emitSourceMaps: false, referenceOnly: false, out emitter);

    private static bool TryCreateCore(
        string target,
        TargetOptions options,
        IReadOnlyList<string>? emitterAssemblies,
        bool emitSourceMaps,
        bool referenceOnly,
        out IEmitter emitter)
    {
        var emitterOptions = ToEmitterOptions(options, emitSourceMaps, referenceOnly);
        if (emitterAssemblies is null || emitterAssemblies.Count == 0)
        {
            return BuiltIn.TryCreate(target, emitterOptions, out emitter);
        }

        var registry = new CompilerEmitterRegistry(Compiler.Emit.EmitterLoader.Load(emitterAssemblies));
        return registry.TryCreate(target, emitterOptions, out emitter);
    }

    /// <summary>
    /// Maps the CLI's parsed per-target <see cref="TargetOptions"/> to the host-neutral
    /// <see cref="EmitterOptions"/> the providers consume. <see cref="TargetOptions.OutDir"/> is a
    /// build concern and is intentionally dropped here; <paramref name="emitSourceMaps"/> is the
    /// <c>--source-maps</c> flag, threaded onto the neutral bag. An empty bag with the flag off maps
    /// to <see cref="EmitterOptions.Empty"/>, so an unconfigured target emits byte-identical output.
    /// </summary>
    private static EmitterOptions ToEmitterOptions(TargetOptions options, bool emitSourceMaps = false, bool referenceOnly = false)
    {
        var hasLayers = options.Layers is { Count: > 0 };
        if (options.NamespaceMap.Count == 0 && options.InstantMode is null && options.Layout is null
            && !emitSourceMaps && !referenceOnly
            && !hasLayers && !options.ApplicationMediatr && options.ApplicationMapping is null)
        {
            return EmitterOptions.Empty;
        }

        // The layer selector (issues #128/#129) is carried as a comma-separated string on the neutral
        // bag, mirroring instantMode/layout; the C# provider parses it back into a layer set. The
        // Application sub-options (MediatR shape, mapping mode) ride alongside.
        var layers = hasLayers ? string.Join(",", options.Layers!) : null;
        return new EmitterOptions(
            options.NamespaceMap, options.InstantMode, options.Layout, emitSourceMaps, referenceOnly,
            layers, options.ApplicationMediatr, options.ApplicationMapping);
    }
}
