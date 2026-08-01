namespace Koine.Compiler;

/// <summary>
/// The layers the Java backend can emit. <see cref="Domain"/> is always on; <see cref="Infrastructure"/>
/// (issue #241's <c>--layers infrastructure</c>, brought to Java in #1090) is opt-in, mirroring the
/// C#/Python/TypeScript selectors. The layer NAMES are target-agnostic and parsed in the provider; this
/// enum is the Java emitter's own view of them.
/// </summary>
internal enum JavaLayer
{
    /// <summary>The domain model — value objects, entities, aggregates, events, CQRS, policies, ACL.</summary>
    Domain,

    /// <summary>The opt-in wiring layer: in-memory repository implementations and the transactional outbox.</summary>
    Infrastructure,
}

/// <summary>
/// Per-emit configuration for the Java backend, mapped from the CLI's <c>targets.java.*</c> block.
/// <see cref="BasePackage"/> is the root package the per-context packages hang under
/// (<c>&lt;base&gt;.&lt;context&gt;</c>, e.g. <c>com.example.billing</c>), defaulting to
/// <see cref="DefaultBasePackage"/> when unconfigured. <see cref="PackageMap"/> remaps a bounded
/// context's emitted package segment (keyed by the lowercased context name the emitter computes, so a
/// lookup is a plain ordinal match). <see cref="Layers"/> selects which layers are emitted; <c>null</c>
/// (the default) means Domain-only. <see cref="Empty"/> applies no remapping and uses the default base
/// package, so emitted output is byte-identical to the unconfigured emitter.
/// </summary>
internal sealed record JavaEmitterOptions(
    string BasePackage,
    IReadOnlyDictionary<string, string> PackageMap,
    IReadOnlySet<JavaLayer>? Layers = null)
{
    /// <summary>The base package used when none is configured — the widest-reach neutral default.</summary>
    public const string DefaultBasePackage = "koine.generated";

    /// <summary>An options bag that applies no remapping and uses all defaults.</summary>
    public static readonly JavaEmitterOptions Empty =
        new(DefaultBasePackage, new Dictionary<string, string>(StringComparer.Ordinal));

    /// <summary>
    /// True when the opt-in Infrastructure layer was selected. The Domain layer is always emitted, so a
    /// null/empty <see cref="Layers"/> set means Domain-only — output byte-identical to Phase 1's.
    /// </summary>
    public bool EmitsInfrastructure => Layers is not null && Layers.Contains(JavaLayer.Infrastructure);
}
