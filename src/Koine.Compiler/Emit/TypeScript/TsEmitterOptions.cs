namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// Per-emit configuration for the TypeScript backend (production-grade emit). Mirrors the C#
/// <see cref="Koine.Compiler.Emit.CSharp.CSharpEmitterOptions"/> surface for cross-emitter parity.
/// Every member defaults so the unconfigured emitter (and every existing call site) produces
/// byte-for-byte identical TypeScript:
/// <list type="bullet">
/// <item><see cref="EmitSourceMaps"/> off — no <c>*.ts.map</c> sidecar, no <c>sourceMappingURL</c>.</item>
/// <item><see cref="ModuleMap"/> empty — cross-file imports keep their historical relative paths.</item>
/// <item><see cref="ReferenceOnly"/> off — full emit (declared now; consumed by a later task).</item>
/// </list>
/// </summary>
internal sealed record TsEmitterOptions
{
    /// <summary>
    /// When <c>true</c>, each emitted module is paired with a Source Map v3 sidecar
    /// (<c>&lt;module&gt;.ts.map</c>) and gets a trailing <c>//# sourceMappingURL</c> comment. The
    /// default (<c>false</c>) leaves output identical to the historical emitter.
    /// </summary>
    public bool EmitSourceMaps { get; init; }

    /// <summary>
    /// Remaps a bounded context's emitted module path (the TypeScript analogue of the C#
    /// <see cref="Koine.Compiler.Emit.CSharp.CSharpEmitterOptions.NamespaceMap"/>). A key is a
    /// context name (the head segment of a module path, e.g. <c>Billing</c>); the value replaces that
    /// head, so a cross-file import of <c>Billing/value-objects/Money</c> with <c>Billing →
    /// @acme/billing</c> imports from <c>@acme/billing/value-objects/Money</c> instead of the
    /// historical relative path. An empty map (the default) leaves every import byte-identical.
    /// </summary>
    public IReadOnlyDictionary<string, string> ModuleMap { get; init; } =
        new Dictionary<string, string>(StringComparer.Ordinal);

    /// <summary>
    /// When <c>true</c>, the emitter produces reference-only output (declarations without bodies).
    /// Declared now for the option surface; consumed by a later task. The default (<c>false</c>) is
    /// the historical full emit.
    /// </summary>
    public bool ReferenceOnly { get; init; }

    /// <summary>The canonical no-op options: no source maps, no remapping, full emit — byte-identical output.</summary>
    public static readonly TsEmitterOptions Empty = new();

    /// <summary>Alias for <see cref="Empty"/>, kept for call sites that predate the full record.</summary>
    public static readonly TsEmitterOptions Default = Empty;

    /// <summary>
    /// Remaps a module path whose head segment is a mapped context name by replacing that head per
    /// <see cref="ModuleMap"/> (e.g. <c>Billing/value-objects/Money → @acme/billing/value-objects/Money</c>).
    /// A single-segment path maps wholesale; an unmapped head, and any path whose head is not a key,
    /// passes through unchanged. With an empty map this is the identity, keeping output byte-identical.
    /// </summary>
    public string RemapModulePath(string modulePath)
    {
        if (ModuleMap.Count == 0)
        {
            return modulePath;
        }

        var slash = modulePath.IndexOf('/');
        var head = slash < 0 ? modulePath : modulePath[..slash];
        if (!ModuleMap.TryGetValue(head, out var mapped))
        {
            return modulePath;
        }

        return slash < 0 ? mapped : mapped + modulePath[slash..];
    }
}
