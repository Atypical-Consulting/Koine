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
/// How the opt-in Application layer (issue #129) maps DTOs ↔ commands and aggregates ↔ read models.
/// <see cref="Plain"/> emits hand-rolled mapper code (the default, zero third-party deps);
/// <see cref="Mapperly"/> is a reserved forward value for source-generated mapping (treated as
/// <see cref="Plain"/> until the Mapperly emission lands).
/// </summary>
internal enum CSharpMappingMode
{
    /// <summary>Hand-rolled mapping code, no third-party dependency (the default).</summary>
    Plain,

    /// <summary>Reserved: Mapperly source-generated mapping (not yet emitted; behaves as <see cref="Plain"/>).</summary>
    Mapperly,
}

/// <summary>
/// A composable layer of the C# target, selected via <c>--layers</c> / <c>targets.csharp.layers</c>.
/// <see cref="Domain"/> (the Domain model + application contracts) is always emitted and is the
/// default; <see cref="Application"/> additionally emits the opt-in Application layer (issue #129) —
/// concrete command/factory handlers, FluentValidation validators, query handlers and the DI
/// extension; <see cref="Infrastructure"/> additionally emits a runnable EF Core realization of those
/// contracts (issue #128: DbContext, entity configurations, repositories, unit of work, transactional
/// outbox + dispatcher, and the DI registration extension). Both opt-in layers imply <see cref="Domain"/>.
/// </summary>
internal enum CSharpLayer
{
    /// <summary>The Domain model + application contracts — the historical, always-on output.</summary>
    Domain,

    /// <summary>The opt-in Application layer (issue #129): handlers, validators, query handlers, DI.</summary>
    Application,

    /// <summary>The opt-in EF Core infrastructure realization of the Domain contracts (issue #128).</summary>
    Infrastructure,
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
/// <remarks>
/// <see cref="ReferenceOnly"/> produces a reference-assembly-style contract surface: every type
/// declaration, member signature, interface, attribute and using is preserved, but each executable
/// body (constructor/method/operator/factory/accessor) is replaced with the canonical
/// <c>throw null!;</c> reference stub — no invariant checks, no field mutation, no business
/// expressions. The default (<c>false</c>) is the historical full emit, byte-identical to the
/// unconfigured emitter.
/// <para><see cref="EmitApplication"/> turns on the opt-in Application layer (issue #129):
/// concrete command/factory handlers, FluentValidation validators, query handlers and the DI
/// extension, emitted alongside the domain output. <see cref="ApplicationMediatr"/> selects the
/// MediatR request/handler shape (default plain handlers); <see cref="Mapping"/> selects the
/// DTO/read-model mapping strategy. All three default off / plain, so an unconfigured emit stays
/// byte-identical to the historical output.</para>
/// <para><see cref="RegexMatchTimeoutMs"/> is the per-call match timeout (milliseconds, default
/// <c>1000</c>) the emitter stamps onto every <c>matches</c>-invariant <c>Regex.IsMatch(…)</c> guard,
/// so an author-supplied catastrophic-backtracking pattern in a value-object constructor cannot run
/// unbounded and become a ReDoS sink (issue #641). A timed-out match surfaces as a contained
/// <c>RegexMatchTimeoutException</c> from the constructor, not a hang.</para>
/// </remarks>
internal sealed record CSharpEmitterOptions(
    IReadOnlyDictionary<string, string> NamespaceMap,
    CSharpInstantMode InstantMode = CSharpInstantMode.DateTimeOffset,
    bool EmitSourceMaps = false,
    bool ReferenceOnly = false,
    IReadOnlySet<CSharpLayer>? Layers = null,
    bool ApplicationMediatr = false,
    CSharpMappingMode Mapping = CSharpMappingMode.Plain,
    int RegexMatchTimeoutMs = 1000)
{
    public static readonly CSharpEmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));

    /// <summary>
    /// True when the opt-in Application layer (issue #129) is requested. The Domain layer is always
    /// emitted, so a null/empty <see cref="Layers"/> set means Domain-only.
    /// </summary>
    public bool EmitApplication => Layers is not null && Layers.Contains(CSharpLayer.Application);

    /// <summary>
    /// True when the opt-in Infrastructure layer (issue #128) is requested. The Domain layer is
    /// always emitted, so a null/empty <see cref="Layers"/> set means Domain-only — output
    /// byte-identical to the historical emitter.
    /// </summary>
    public bool EmitsInfrastructure => Layers is not null && Layers.Contains(CSharpLayer.Infrastructure);

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
