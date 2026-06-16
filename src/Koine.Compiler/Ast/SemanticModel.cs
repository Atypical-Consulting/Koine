namespace Koine.Compiler.Ast;

/// <summary>
/// The single source of truth for a compilation's resolved view of a <see cref="KoineModel"/>.
/// Built once and shared across the semantic validator, the emitter, and the editor/LSP services,
/// so name/type resolution (the <see cref="ModelIndex"/>) is computed exactly once instead of being
/// rebuilt independently by each consumer (previously 6+ duplicate builds per request).
///
/// <para>This is a Roslyn-style façade over the immutable syntax tree: the <see cref="KoineModel"/>
/// stays the source of truth and this answers resolved questions about it. Phase 1 owns the single
/// <see cref="ModelIndex"/> and hands out per-context <see cref="TypeResolver"/>s; later phases add a
/// Symbol layer (<c>GetSymbolInfo</c>/<c>GetDeclaredSymbol</c>) and resolved-type queries
/// (<c>GetTypeInfo</c>) with an explicit error type.</para>
/// </summary>
public sealed class SemanticModel
{
    /// <summary>The syntax model this resolves over.</summary>
    public KoineModel Model { get; }

    /// <summary>The one name/type resolution index for the whole compilation.</summary>
    public ModelIndex Index { get; }

    public SemanticModel(KoineModel model)
    {
        Model = model;
        Index = new ModelIndex(model);
    }

    /// <summary>
    /// A type resolver scoped to <paramref name="context"/> so a type name shared across bounded
    /// contexts (R13.2) resolves to that context's declaration; <c>null</c> resolves globally.
    /// </summary>
    public TypeResolver ResolverFor(string? context = null) => new(Index, context);
}
