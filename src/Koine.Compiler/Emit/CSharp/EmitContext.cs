using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// The immutable, per-<see cref="CSharpEmitter.Emit"/> state that every emit method
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
/// <param name="AdditiveNeeds">
/// Value-object names that are folded with <c>+</c> somewhere (e.g.
/// <c>lines.sum(l =&gt; l.subtotal)</c> over a Money field). Drives generation of an
/// additive operator (R9).
/// </param>
/// <param name="ContextNames">
/// All context (namespace) names in the model. Every type in a context shares the single
/// namespace &lt;Context&gt;; aggregates are boundaries, not namespaces.
/// </param>
/// <param name="IdStrategies">
/// ID type name -> its declared identity strategy (R11.1). An ID referenced but not owned
/// by any entity (e.g. a foreign-context *Id) defaults to Guid.
/// </param>
internal sealed record EmitContext(
    ModelIndex Index,
    IReadOnlyDictionary<string, IReadOnlySet<string>> ScalarNeeds,
    IReadOnlySet<string> AdditiveNeeds,
    IReadOnlyList<string> ContextNames,
    IReadOnlyDictionary<string, (IdentityStrategy Strategy, string? Backing)> IdStrategies);
