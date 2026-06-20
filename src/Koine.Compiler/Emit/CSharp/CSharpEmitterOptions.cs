namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// How a Koine <c>Instant</c> field is rendered in emitted C# (R16.1). The default
/// (<see cref="DateTimeOffset"/>) matches the historical output exactly; <see cref="NodaTime"/>
/// is reserved for a later phase and currently behaves as the default (no-op).
/// </summary>
internal enum CSharpInstantMode
{
    /// <summary>Map <c>Instant</c> to <c>System.DateTimeOffset</c> (the historical default).</summary>
    DateTimeOffset,

    /// <summary>Reserved: map <c>Instant</c> to NodaTime's <c>Instant</c> (not yet implemented).</summary>
    NodaTime,
}

/// <summary>
/// Per-emit configuration for the C# backend (R16.1), mapped from the CLI's
/// <c>targets.csharp.*</c> block. <see cref="NamespaceMap"/> remaps a bounded context's
/// emitted namespace (e.g. <c>Catalog → Acme.Catalog</c>): the mapped value replaces the
/// context-name prefix of every logical namespace the emitter computes, so the namespace
/// declaration, the file's folder, cross-context <c>using</c>s, and fully-qualified type
/// references all stay consistent. <see cref="Empty"/> applies no remapping, so emitted
/// output is byte-identical to the unconfigured emitter.
/// </summary>
internal sealed record CSharpEmitterOptions(
    IReadOnlyDictionary<string, string> NamespaceMap,
    CSharpInstantMode InstantMode = CSharpInstantMode.DateTimeOffset,
    bool EmitSourceMaps = false)
{
    public static readonly CSharpEmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));

    /// <summary>
    /// Remaps a logical namespace (whose first segment is a bounded-context name) to its
    /// emitted form by replacing that context prefix per <see cref="NamespaceMap"/>. A module
    /// sub-namespace (e.g. <c>Catalog.Pricing</c>) keeps its tail (→ <c>Acme.Catalog.Pricing</c>);
    /// an unmapped context, the runtime namespace, and shared-kernel namespaces pass through unchanged.
    /// </summary>
    public string RemapNamespace(string logicalNamespace)
    {
        if (NamespaceMap.Count == 0)
        {
            return logicalNamespace;
        }

        var dot = logicalNamespace.IndexOf('.');
        var head = dot < 0 ? logicalNamespace : logicalNamespace[..dot];
        if (!NamespaceMap.TryGetValue(head, out var mapped))
        {
            return logicalNamespace;
        }

        return dot < 0 ? mapped : mapped + logicalNamespace[dot..];
    }
}
