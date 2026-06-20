namespace Koine.Compiler.Semantics;

/// <summary>
/// A semantic analyzer over a resolved Koine model — the public plugin contract for opening the
/// compiler as a platform (issue #69). The built-in semantic checks are themselves implemented as
/// analyzers, and external assemblies may contribute their own: any public type with a public
/// parameterless constructor that implements this interface is discovered by the
/// <see cref="AnalyzerLoader"/> from an assembly named in <c>koine.config</c>'s <c>analyzers</c> key.
///
/// <para>An analyzer is <b>target-agnostic</b>: it inspects the semantic model and reports
/// <see cref="Koine.Compiler.Diagnostics.Diagnostic"/>s through the <see cref="AnalyzerContext"/>.
/// It must never reach into a code-emitter concept. Analyzers run in a defined order (built-ins
/// first, then externals) and append their diagnostics; an analyzer should be a pure function of the
/// model (no shared mutable state between runs) so the pipeline stays deterministic.</para>
/// </summary>
public interface IModelAnalyzer
{
    /// <summary>
    /// A stable, human-readable identity for this analyzer (e.g. <c>"koine.context-map"</c> or a
    /// vendor-qualified id for an external analyzer). Used for ordering, diagnostics, and tooling;
    /// it does not have to be globally unique but should be stable across versions.
    /// </summary>
    string Id { get; }

    /// <summary>
    /// Analyzes the model exposed by <paramref name="context"/> and reports any diagnostics through
    /// <see cref="AnalyzerContext.Report"/>. Implementations must not throw for an invalid model —
    /// they validate it; the host isolates a misbehaving external analyzer regardless.
    /// </summary>
    void Analyze(AnalyzerContext context);
}
