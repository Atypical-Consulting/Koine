namespace Koine.Compiler.Emit;

/// <summary>
/// Target-agnostic, host-neutral emit configuration handed to an <see cref="IEmitterProvider"/>
/// (issue #69, Task 5). It is the compiler-level subset of the CLI's per-target options that the
/// emitters actually consume — output directory is a build concern and stays in the CLI. Each
/// provider maps this neutral bag to its own emitter's option type internally.
///
/// <para><see cref="NamespaceMap"/> remaps a bounded context's emitted
/// namespace/package (e.g. <c>Catalog → Acme.Catalog</c>). <see cref="InstantMode"/> and
/// <see cref="Layout"/> are forward keys consumed by emitters as they gain support; absent keys
/// are <c>null</c>/empty. <see cref="EmitSourceMaps"/> turns on source-map debug info (C#
/// <c>#line</c> directives, TypeScript <c>*.ts.map</c> sidecars); it defaults to <c>false</c> so
/// the unconfigured emitter is byte-identical. <see cref="ReferenceOnly"/> emits a declaration-only
/// contract surface (all signatures/interfaces, bodies stripped to reference stubs); it defaults to
/// <c>false</c> so the unconfigured emitter is byte-identical. <see cref="Layers"/> is a
/// comma-separated layer selector (e.g. <c>domain,application,infrastructure</c>) consumed by the C#
/// emitter; <c>null</c> means the historical Domain-only output. <see cref="ApplicationMediatr"/> and
/// <see cref="ApplicationMapping"/> are the C# Application-layer sub-options (issue #129: MediatR
/// request shape; <c>plain</c>|<c>mapperly</c> mapping). <see cref="RegexMatchTimeoutMs"/> is the
/// per-call match-timeout budget (milliseconds) for the <c>matches</c>-invariant ReDoS guard (#641);
/// <c>null</c> ⇒ the emitter's historical <c>1000</c> ms default. It is spiritually target-agnostic
/// (a generic "regex match timeout"); targets with no per-call timeout (TypeScript/Python/PHP/Rust
/// today) simply ignore it. <see cref="RegexMode"/> is a neutral forward key (issue #831) the C#
/// provider interprets as <c>inline</c> | <c>sourceGenerated</c> (case-insensitive) to select how a
/// <c>matches</c>-invariant regex guard is evaluated; other targets carry but ignore it (like
/// <see cref="RegexMatchTimeoutMs"/>). <see cref="Empty"/> applies no configuration, so a provider
/// given it produces output byte-identical to a parameterless emitter.</para>
/// </summary>
public sealed record EmitterOptions(
    IReadOnlyDictionary<string, string> NamespaceMap,
    string? InstantMode = null,
    string? Layout = null,
    bool EmitSourceMaps = false,
    bool ReferenceOnly = false,
    string? Layers = null,
    bool ApplicationMediatr = false,
    string? ApplicationMapping = null,
    int? RegexMatchTimeoutMs = null,
    string? RegexMode = null)
{
    /// <summary>An options bag with no remapping and all defaults — the parameterless path.</summary>
    public static readonly EmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));
}
