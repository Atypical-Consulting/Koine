using Koine.Compiler;
using Koine.Compiler.Emit;

namespace Koine.Mcp;

/// <summary>
/// Selects an <see cref="IEmitter"/> by target name, mirroring the CLI's <c>build</c> command. As of
/// issue #69 (Task 5) this is a thin adapter over the compiler's unified
/// <see cref="EmitterRegistry"/> — the same registry the CLI delegates to for its built-ins — so the
/// MCP server resolves exactly the built-in targets the CLI does, in the same order. (This is what
/// closes the historical gap where the MCP list was missing <c>php</c>.) The parameterless emitters
/// of old map to <see cref="EmitterOptions.Empty"/>, producing byte-identical output.
///
/// <para>The MCP server deliberately resolves the built-in targets only. It does <b>not</b> load
/// external/plugin emitter assemblies (the <c>emitters</c> config key): the MCP server takes no such
/// configuration, and must never load assemblies named by tool input.</para>
/// </summary>
internal static class EmitterFactory
{
    private static readonly EmitterRegistry BuiltIn = new(BuiltInEmitterProviders.All);

    /// <summary>The output targets the server understands, in display order (== the CLI's built-ins).</summary>
    public static IReadOnlyList<string> Targets => BuiltIn.SupportedTargets;

    /// <summary>
    /// Resolves a built-in emitter for <paramref name="target"/> (case-insensitive; null/blank means
    /// <c>csharp</c>). Returns <c>false</c> with an actionable <paramref name="error"/> for an
    /// unknown target.
    /// </summary>
    public static bool TryCreate(string? target, out IEmitter emitter, out string? error)
    {
        var resolved = string.IsNullOrWhiteSpace(target) ? "csharp" : target.Trim();
        if (BuiltIn.TryCreate(resolved, EmitterOptions.Empty, out emitter))
        {
            error = null;
            return true;
        }

        error = $"unsupported target '{target}' (supported: {BuiltIn.SupportedList})";
        return false;
    }
}
