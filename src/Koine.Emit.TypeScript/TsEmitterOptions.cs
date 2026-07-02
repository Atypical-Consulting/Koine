namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// A composable layer of the TypeScript target, selected via <c>--layers</c> /
/// <c>targets.typescript.layers</c> — the TS analogue of <see cref="Koine.Compiler.Emit.CSharp.CSharpLayer"/>.
/// <see cref="Domain"/> (the domain model + application contracts) is always emitted and is the default;
/// <see cref="Infrastructure"/> additionally emits a runnable, dependency-light realization of those
/// contracts (issue #241: concrete repositories over an in-memory store, a unit of work, a transactional
/// outbox + dispatcher, validation/transaction pipeline behaviors, and a composition-root factory). The
/// opt-in layer implies <see cref="Domain"/>.
/// </summary>
internal enum TsLayer
{
    /// <summary>The domain model + application contracts — the historical, always-on output.</summary>
    Domain,

    /// <summary>The opt-in, dependency-light infrastructure realization of the domain contracts (issue #241).</summary>
    Infrastructure,
}

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

    /// <summary>
    /// The selected composable layers, parsed from the neutral <c>--layers</c> selector (the TS analogue
    /// of <see cref="Koine.Compiler.Emit.CSharp.CSharpEmitterOptions.Layers"/>). <c>null</c> (the default)
    /// means Domain-only — output byte-identical to the historical emitter. The opt-in
    /// <see cref="TsLayer.Infrastructure"/> always implies <see cref="TsLayer.Domain"/>.
    /// </summary>
    public IReadOnlySet<TsLayer>? Layers { get; init; }

    /// <summary>
    /// Carries the neutral <see cref="Koine.Compiler.Emit.EmitterOptions.RegexMatchTimeoutMs"/> author
    /// intent (#794/#812). JavaScript's stock <c>RegExp</c> has NO synchronous per-call timeout, so this
    /// value is ADVISORY: when set, the translator threads it into the runtime <c>regexMatch</c> seam's
    /// <c>timeoutMs?</c> parameter — the documented swap point for a linear-time engine (RE2) — but match
    /// behavior with the default engine is unchanged. <c>null</c> (the default) keeps the call site and
    /// runtime byte-identical to the historical emitter.
    /// </summary>
    public int? RegexMatchTimeoutMs { get; init; }

    /// <summary>
    /// True when the opt-in Infrastructure layer (issue #241) is requested. The Domain layer is always
    /// emitted, so a null/empty <see cref="Layers"/> set means Domain-only — output byte-identical to the
    /// historical emitter.
    /// </summary>
    public bool EmitsInfrastructure => Layers is not null && Layers.Contains(TsLayer.Infrastructure);

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
