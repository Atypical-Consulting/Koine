namespace Koine.Compiler;

/// <summary>
/// Per-emit configuration for the Rust backend, mapped from the CLI's <c>targets.rust.*</c> block.
/// <see cref="ModuleMap"/> remaps a bounded context's emitted Rust module name (e.g.
/// <c>billing → acme_billing</c>): the mapped value replaces the snake_case context-name head of the
/// module path the emitter computes. Keys are the <c>snake_case</c> module head the emitter computes
/// (the provider lowers the config's context names when building this map), so <see cref="RemapModule"/>
/// can match with a plain ordinal lookup. <see cref="Empty"/> applies no remapping, so emitted output
/// is byte-identical to the unconfigured emitter.
/// </summary>
internal sealed record RustEmitterOptions(
    IReadOnlyDictionary<string, string> ModuleMap)
{
    /// <summary>An options bag that applies no remapping and uses all defaults.</summary>
    public static readonly RustEmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));

    /// <summary>
    /// Remaps a logical module path (whose first segment is a snake_case bounded-context name) to its
    /// emitted form by replacing that context head per <see cref="ModuleMap"/>. A sub-module
    /// (e.g. <c>catalog::pricing</c>) keeps its tail; an unmapped context passes through unchanged.
    /// </summary>
    public string RemapModule(string logicalModule)
    {
        if (ModuleMap.Count == 0)
        {
            return logicalModule;
        }

        var sep = logicalModule.IndexOf("::", StringComparison.Ordinal);
        var head = sep < 0 ? logicalModule : logicalModule[..sep];
        if (!ModuleMap.TryGetValue(head, out var mapped))
        {
            return logicalModule;
        }

        return sep < 0 ? mapped : mapped + logicalModule[sep..];
    }
}
