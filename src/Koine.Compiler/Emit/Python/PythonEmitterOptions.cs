namespace Koine.Compiler.Emit.Python;

/// <summary>
/// Per-emit configuration for the Python backend, mapped from the CLI's
/// <c>targets.python.*</c> block. <see cref="PackageMap"/> remaps a bounded context's emitted
/// Python package name (e.g. <c>Catalog → acme.catalog</c>): the mapped value replaces the
/// context-name prefix of every logical package path the emitter computes, keeping module
/// declarations, folder layout, and cross-context imports all consistent.
/// <see cref="Empty"/> applies no remapping, so emitted output is byte-identical to the
/// unconfigured emitter.
/// <para>
/// <see cref="EmitDictHelpers"/> is a forward-compatibility flag reserved for a later phase
/// (generating <c>to_dict</c>/<c>from_dict</c> serialisation helpers on dataclasses). It has
/// no effect in Phase 1 and defaults to <c>false</c>.
/// </para>
/// </summary>
internal sealed record PythonEmitterOptions(
    IReadOnlyDictionary<string, string> PackageMap,
    bool EmitDictHelpers = false)
{
    /// <summary>An options bag that applies no remapping and uses all defaults.</summary>
    public static readonly PythonEmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));

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
