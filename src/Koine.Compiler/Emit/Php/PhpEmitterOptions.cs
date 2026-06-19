namespace Koine.Compiler.Emit.Php;

/// <summary>
/// Per-emit configuration for the PHP backend, mapped from the CLI's
/// <c>targets.php.*</c> block. <see cref="NamespaceMap"/> remaps a bounded context's emitted
/// PHP namespace (e.g. <c>Catalog → Acme\Catalog</c>): the mapped value replaces the
/// context-name prefix of every logical namespace path the emitter computes, keeping class
/// declarations, folder layout, and cross-context references all consistent. Keys are the
/// PascalCase context name the emitter computes, so <see cref="RemapNamespace"/> can match
/// with a plain ordinal lookup.
/// <see cref="Empty"/> applies no remapping, so emitted output is byte-identical to the
/// unconfigured emitter.
/// </summary>
internal sealed record PhpEmitterOptions(
    IReadOnlyDictionary<string, string> NamespaceMap)
{
    /// <summary>An options bag that applies no remapping and uses all defaults.</summary>
    public static readonly PhpEmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));

    /// <summary>
    /// Remaps a logical namespace path (whose first segment is a bounded-context name) to its
    /// emitted form by replacing that context prefix per <see cref="NamespaceMap"/>. An unmapped
    /// context passes through unchanged.
    /// </summary>
    public string RemapNamespace(string logicalNamespace)
    {
        if (NamespaceMap.Count == 0)
        {
            return logicalNamespace;
        }

        var sep = logicalNamespace.IndexOf('\\');
        var head = sep < 0 ? logicalNamespace : logicalNamespace[..sep];
        if (!NamespaceMap.TryGetValue(head, out var mapped))
        {
            return logicalNamespace;
        }

        return sep < 0 ? mapped : mapped + logicalNamespace[sep..];
    }
}
