using Koine.Compiler.Emit;

namespace Koine.Mcp;

/// <summary>
/// Selects an <see cref="IEmitter"/> by target name, mirroring the CLI's <c>build</c> command. As of
/// issue #69 (Task 5) this is a thin adapter over the compiler's unified
/// <see cref="EmitterRegistry"/> — the same registry the CLI delegates to — so the MCP server and CLI
/// can never drift in which targets they support. (This is what closes the historical gap where the
/// MCP list was missing <c>php</c>.) The parameterless emitters of old map to
/// <see cref="EmitterOptions.Empty"/>, producing byte-identical output.
/// </summary>
internal static class EmitterFactory
{
    private static readonly EmitterRegistry BuiltIn = new();

    /// <summary>The output targets the server understands, in display order (== the CLI's list).</summary>
    public static IReadOnlyList<string> Targets => BuiltIn.SupportedTargets;

    /// <summary>
    /// Resolves an emitter for <paramref name="target"/> (case-insensitive; null/blank means
    /// <c>csharp</c>). Returns <c>false</c> with an actionable <paramref name="error"/> for an
    /// unknown target.
    /// </summary>
    public static bool TryCreate(string? target, out IEmitter emitter, out string? error) =>
        TryCreate(target, emitterAssemblies: null, out emitter, out error);

    /// <summary>
    /// Resolves an emitter for <paramref name="target"/>, additionally resolving external providers
    /// from the assemblies named in <paramref name="emitterAssemblies"/> (the <c>emitters</c> config
    /// key, issue #69). A null/empty list resolves built-ins only.
    /// </summary>
    public static bool TryCreate(
        string? target,
        IReadOnlyList<string>? emitterAssemblies,
        out IEmitter emitter,
        out string? error)
    {
        var resolved = string.IsNullOrWhiteSpace(target) ? "csharp" : target.Trim();
        var registry = emitterAssemblies is null || emitterAssemblies.Count == 0
            ? BuiltIn
            : new EmitterRegistry(EmitterLoader.Load(emitterAssemblies));

        if (registry.TryCreate(resolved, EmitterOptions.Empty, out emitter))
        {
            error = null;
            return true;
        }

        error = $"unsupported target '{target}' (supported: {string.Join(", ", registry.SupportedTargets)})";
        return false;
    }
}
