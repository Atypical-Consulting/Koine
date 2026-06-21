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
/// <c>false</c> so the unconfigured emitter is byte-identical. <see cref="Layers"/> selects which
/// composable output layers to emit (e.g. <c>domain</c>, <c>application</c>; issue #129);
/// <c>null</c>/empty means the default domain-only output. <see cref="ApplicationMediatr"/> and
/// <see cref="ApplicationMapping"/> are the C# Application-layer sub-options (MediatR request shape;
/// <c>plain</c>|<c>mapperly</c> mapping). <see cref="Empty"/> applies no
/// configuration, so a provider given it produces output byte-identical to a parameterless emitter.</para>
/// </summary>
public sealed record EmitterOptions(
    IReadOnlyDictionary<string, string> NamespaceMap,
    string? InstantMode = null,
    string? Layout = null,
    bool EmitSourceMaps = false,
    bool ReferenceOnly = false,
    IReadOnlyList<string>? Layers = null,
    bool ApplicationMediatr = false,
    string? ApplicationMapping = null)
{
    /// <summary>An options bag with no remapping and all defaults — the parameterless path.</summary>
    public static readonly EmitterOptions Empty =
        new(new Dictionary<string, string>(StringComparer.Ordinal));
}
