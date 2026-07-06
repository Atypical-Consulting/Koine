using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// The immutable, per-<see cref="CSharpEmitter.Emit(KoineModel)"/> state that every emit method
/// reads but none mutates. Threading this record (rather than mutating instance fields)
/// keeps the emitter reentrant/stateless: a single <see cref="CSharpEmitter"/> can emit
/// many models concurrently with no shared mutable state.
/// </summary>
/// <param name="Index">
/// The model index, used to compute precise cross-namespace usings (R13.2/R13.3) and to
/// classify/resolve type references.
/// </param>
/// <param name="OperatorNeeds">
/// Value-object name -> its unified per-VO operator-demand record from the analyzer's single-pass
/// model (#836): the scalar multiply/divide factors, the plain binary <c>+</c>/<c>-</c> ops, the
/// <c>sum</c>-fold <see cref="OperatorNeedsAnalyzer.ValueObjectOperatorNeeds.IsSummable"/> flag, and
/// the precomputed <see cref="OperatorNeedsAnalyzer.ValueObjectOperatorNeeds.NeedsAdd"/> union. Read
/// via <c>GetValueOrDefault</c> so a value object with no arithmetic demand (absent key → <c>null</c>)
/// treats every signal as false/empty, exactly as the four separate maps did before (#836 follow-up).
/// Drives all demand-driven value-object operator generation (R9): scalar <c>*</c>/<c>/</c> (#832),
/// additive <c>+</c> (sum-fold or direct <c>fee + fee</c>, #833), and subtractive <c>-</c> (#833).
/// </param>
/// <param name="ContextNames">
/// All context (namespace) names in the model. Every type in a context shares the single
/// namespace &lt;Context&gt;; aggregates are boundaries, not namespaces.
/// </param>
/// <param name="IdStrategies">
/// ID type name -> its declared identity strategy (R11.1). An ID referenced but not owned
/// by any entity (e.g. a foreign-context *Id) defaults to Guid.
/// </param>
/// <param name="Options">
/// The configured C# emitter options (R16.1): namespace remapping, Instant handling. Empty
/// (no remapping) by default, so an unconfigured emit is byte-identical to the historical output.
/// </param>
/// <param name="Semantic">
/// The shared resolved model. The migrated value-object-invariant slice (Commit 4) reads its lowered
/// bound invariants off this (<see cref="SemanticModel.BoundInvariantsFor"/>); every other path ignores
/// it, so the lazy bound layer is forced only for the migrated slice.
/// </param>
internal sealed record EmitContext(
    ModelIndex Index,
    IReadOnlyDictionary<string, OperatorNeedsAnalyzer.ValueObjectOperatorNeeds> OperatorNeeds,
    IReadOnlyList<string> ContextNames,
    IReadOnlyDictionary<string, (IdentityStrategy Strategy, string? Backing)> IdStrategies,
    CSharpEmitterOptions Options,
    SemanticModel Semantic)
{
    /// <summary>
    /// Remaps a logical namespace to its emitted form per the configured
    /// <see cref="CSharpEmitterOptions.NamespaceMap"/> (R16.1); see
    /// <see cref="CSharpEmitterOptions.RemapNamespace"/>.
    /// </summary>
    public string RemapNamespace(string logicalNamespace) => Options.RemapNamespace(logicalNamespace);
}
