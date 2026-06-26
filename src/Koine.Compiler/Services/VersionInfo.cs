using System.Reflection;

namespace Koine.Compiler.Services;

/// <summary>
/// The single shared source of the compiler's <em>display</em> version — the value behind both
/// <c>koine --version</c> (<c>Koine.Cli</c>) and the wasm <c>Capabilities().version</c>
/// (<c>Koine.Wasm</c>). Centralizing it here keeps those two surfaces in lock-step: the
/// version-display rule lives in exactly one place.
/// </summary>
public static class VersionInfo
{
    /// <summary>
    /// The display version of <paramref name="assembly"/>: its
    /// <see cref="AssemblyInformationalVersionAttribute"/> with any SDK-appended
    /// <c>+&lt;commit&gt;</c> build-metadata suffix trimmed, falling back to the four-part
    /// <see cref="AssemblyName.Version"/> (then <c>"0.0.0"</c>) when the attribute is absent.
    /// </summary>
    public static string Display(Assembly assembly)
    {
        var info = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (string.IsNullOrEmpty(info))
        {
            return assembly.GetName().Version?.ToString() ?? "0.0.0";
        }

        var plus = info.IndexOf('+');
        return plus < 0 ? info : info[..plus];
    }
}
