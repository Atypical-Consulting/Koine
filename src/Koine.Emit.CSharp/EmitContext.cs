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
/// <param name="ScalarNeeds">
/// Value-object name -> scalar C# types ("int"/"decimal") it is multiplied by in some
/// derived expression. Drives demand-driven scalar operator generation (R9).
/// </param>
/// <param name="ScalarDivNeeds">
/// Value-object name -> scalar C# types ("int"/"decimal") it is divided by in some derived
/// expression. The division dual of <see cref="ScalarNeeds"/>; drives demand-driven
/// <c>operator /</c> generation (#832), so <c>value-object / scalar</c> compiles.
/// </param>
/// <param name="AdditiveNeeds">
/// Value-object names that are folded with <c>+</c> somewhere (e.g.
/// <c>lines.sum(l =&gt; l.subtotal)</c> over a Money field). Drives generation of an
/// additive operator (R9).
/// </param>
/// <param name="DirectArithmeticNeeds">
/// Value-object name -> the additive operators (<see cref="BinaryOp.Add"/>/<see cref="BinaryOp.Sub"/>)
/// it appears as an operand of in a DIRECT same-type binary expression (e.g. <c>fee + fee</c>,
/// <c>fee - fee</c> — not a <c>sum</c> fold). Drives demand-driven generation of <c>operator +</c>
/// (in addition to <see cref="AdditiveNeeds"/>) and <c>operator -</c> for plain value objects (#833),
/// so direct same-type arithmetic compiles instead of emitting CS0019.
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
    IReadOnlyDictionary<string, IReadOnlySet<string>> ScalarNeeds,
    IReadOnlyDictionary<string, IReadOnlySet<string>> ScalarDivNeeds,
    IReadOnlySet<string> AdditiveNeeds,
    IReadOnlyDictionary<string, IReadOnlySet<BinaryOp>> DirectArithmeticNeeds,
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
