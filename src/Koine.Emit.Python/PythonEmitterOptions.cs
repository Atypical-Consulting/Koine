namespace Koine.Compiler;

/// <summary>
/// A composable layer of the Python target, selected via <c>--layers</c> /
/// <c>targets.python.layers</c> — the Python analogue of
/// <see cref="Koine.Compiler.Emit.CSharp.CSharpLayer"/>. <see cref="Domain"/> (the domain model +
/// application contracts) is always emitted and is the default; <see cref="Infrastructure"/>
/// additionally emits a runnable, dependency-free realization of those contracts (issue #241: concrete
/// repositories over an in-memory store, a unit of work, a transactional outbox + dispatcher,
/// validation/transaction pipeline behaviors, and a provider/composition helper). The opt-in layer
/// implies <see cref="Domain"/>.
/// </summary>
internal enum PythonLayer
{
    /// <summary>The domain model + application contracts — the historical, always-on output.</summary>
    Domain,

    /// <summary>The opt-in, dependency-free infrastructure realization of the domain contracts (issue #241).</summary>
    Infrastructure,
}

/// <summary>
/// Per-emit configuration for the Python backend, mapped from the CLI's
/// <c>targets.python.*</c> block. <see cref="PackageMap"/> remaps a bounded context's emitted
/// Python package name (e.g. <c>catalog → acme.catalog</c>): the mapped value replaces the
/// context-name prefix of every logical package path the emitter computes, keeping module
/// declarations, folder layout, and cross-context imports all consistent. Keys are the
/// <c>snake_case</c> package head the emitter computes (the CLI lowers the config's context names
/// when building this map), so <see cref="RemapPackage"/> can match with a plain ordinal lookup.
/// <see cref="Empty"/> applies no remapping, so emitted output is byte-identical to the
/// unconfigured emitter.
/// <para>
/// <see cref="EmitDictHelpers"/> is a forward-compatibility flag reserved for a later phase
/// (generating <c>to_dict</c>/<c>from_dict</c> serialisation helpers on dataclasses). It has
/// no effect in Phase 1 and defaults to <c>false</c>.
/// </para>
/// <para>
/// <see cref="RegexMatchTimeoutMs"/> carries the neutral
/// <see cref="Koine.Compiler.Emit.EmitterOptions.RegexMatchTimeoutMs"/> author intent (#794/#812). When
/// set, a <c>matches</c> guard lowers to the third-party <c>regex</c> module's
/// <c>regex.search(..., timeout=&lt;ms/1000&gt;)</c> (the one Python path with a real per-call timeout)
/// instead of the stdlib <c>re.search(...)</c>; <c>null</c> (the default) keeps stdlib <c>re</c> so users
/// who never set the key take on no new dependency and emit byte-identical output.
/// </para>
/// </summary>
internal sealed record PythonEmitterOptions(
    IReadOnlyDictionary<string, string> PackageMap,
    bool EmitDictHelpers = false,
    IReadOnlySet<PythonLayer>? Layers = null,
    int? RegexMatchTimeoutMs = null)
{
    /// <summary>An options bag that applies no remapping and uses all defaults.</summary>
    public static readonly PythonEmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));

    /// <summary>
    /// True when the opt-in Infrastructure layer (issue #241) is requested. The Domain layer is always
    /// emitted, so a null/empty <see cref="Layers"/> set means Domain-only — output byte-identical to the
    /// historical emitter.
    /// </summary>
    public bool EmitsInfrastructure => Layers is not null && Layers.Contains(PythonLayer.Infrastructure);

    /// <summary>
    /// Remaps a logical package path (whose first segment is a bounded-context name) to its
    /// emitted form by replacing that context prefix per <see cref="PackageMap"/>. A sub-package
    /// (e.g. <c>catalog.pricing</c>) keeps its tail (→ <c>acme.catalog.pricing</c>); an unmapped
    /// context and the runtime package pass through unchanged.
    /// </summary>
    public string RemapPackage(string logicalPackage)
    {
        if (PackageMap.Count == 0)
        {
            return logicalPackage;
        }

        var dot = logicalPackage.IndexOf('.');
        var head = dot < 0 ? logicalPackage : logicalPackage[..dot];
        if (!PackageMap.TryGetValue(head, out var mapped))
        {
            return logicalPackage;
        }

        return dot < 0 ? mapped : mapped + logicalPackage[dot..];
    }
}
