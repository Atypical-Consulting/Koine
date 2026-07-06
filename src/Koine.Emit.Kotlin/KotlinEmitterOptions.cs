namespace Koine.Compiler;

/// <summary>
/// Per-emit configuration for the Kotlin backend, mapped from the CLI's <c>targets.kotlin.*</c> block.
/// <see cref="BasePackage"/> is the root package the per-context packages hang under
/// (<c>&lt;base&gt;.&lt;context&gt;</c>, e.g. <c>com.example.billing</c>), defaulting to
/// <see cref="DefaultBasePackage"/> when unconfigured. <see cref="PackageMap"/> remaps a bounded
/// context's emitted package segment (keyed by the lowercased context name the emitter computes, so a
/// lookup is a plain ordinal match). <see cref="Empty"/> applies no remapping and uses the default base
/// package, so emitted output is byte-identical to the unconfigured emitter — mirroring
/// <see cref="JavaEmitterOptions"/>, the JVM sibling.
/// </summary>
internal sealed record KotlinEmitterOptions(
    string BasePackage,
    IReadOnlyDictionary<string, string> PackageMap)
{
    /// <summary>The base package used when none is configured — the widest-reach neutral default.</summary>
    public const string DefaultBasePackage = "koine.generated";

    /// <summary>An options bag that applies no remapping and uses all defaults.</summary>
    public static readonly KotlinEmitterOptions Empty =
        new(DefaultBasePackage, new Dictionary<string, string>(StringComparer.Ordinal));
}
