namespace Koine.Compiler;

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
/// <para>
/// <see cref="RegexMatchTimeoutMs"/> carries the neutral
/// <see cref="Koine.Compiler.Emit.EmitterOptions.RegexMatchTimeoutMs"/> author intent (#794/#812). PHP
/// has no per-call wall-clock match timeout, so the value cannot be honored literally; when set, the
/// <c>matches</c> lowering instead annotates the emitted <c>preg_match</c> with a note that PHP bounds
/// matching via PCRE's <c>pcre.backtrack_limit</c>/<c>pcre.recursion_limit</c> (the documented
/// substitute), surfacing the author's budget rather than silently discarding it. <c>null</c> (the
/// default) keeps output byte-identical to the historical emitter.
/// </para>
/// </summary>
internal sealed record PhpEmitterOptions(
    IReadOnlyDictionary<string, string> NamespaceMap,
    int? RegexMatchTimeoutMs = null)
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
