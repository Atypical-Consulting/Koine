namespace Koine.Compiler.Ast.Bound;

/// <summary>
/// The per-<see cref="SemanticModel"/> bound artifact (Commit 4): lowers + caches the value-object
/// invariants the migrated emitter slice consumes. Built lazily off <see cref="SemanticModel"/> with
/// the same thread-safety discipline as the syntax graph (Commit 1) and binding table (Commit 3).
/// TARGET-AGNOSTIC.
///
/// <para>The cache is keyed by <see cref="ValueObjectDecl"/> using the BCL
/// <see cref="ReferenceEqualityComparer.Instance"/> — the recurring value-equality-record discipline
/// (4th incarnation): two identically-named value objects across different bounded contexts (R13.2) are
/// value-equal as records and would collide to one cache entry without it.</para>
/// </summary>
internal sealed class BoundModel
{
    private readonly SemanticModel _model;
    private readonly IReadOnlyDictionary<ValueObjectDecl, IReadOnlyList<BoundInvariant>> _invariantsByVo;

    private BoundModel(SemanticModel model, IReadOnlyDictionary<ValueObjectDecl, IReadOnlyList<BoundInvariant>> invariantsByVo)
    {
        _model = model;
        _invariantsByVo = invariantsByVo;
    }

    /// <summary>The lowered invariants of a value object (the migrated slice's entry point).</summary>
    public IReadOnlyList<BoundInvariant> InvariantsFor(ValueObjectDecl vo) =>
        _invariantsByVo.TryGetValue(vo, out IReadOnlyList<BoundInvariant>? bound) ? bound : LowerInvariants(vo);

    /// <summary>
    /// Lowers every value object's invariants once, in declaration order, scoped EXACTLY as the C#
    /// emitter scopes its expression translator for that value object (<c>TypeScope.FromMembers(vo.Members)</c>
    /// + the value object's bounded context, including the shared-kernel namespace remap) so the resolved
    /// types on the bound nodes are byte-identical to what the emitter saw.
    /// </summary>
    public static BoundModel Build(SemanticModel model)
    {
        ModelIndex index = model.Index;
        var byVo = new Dictionary<ValueObjectDecl, IReadOnlyList<BoundInvariant>>(ReferenceEqualityComparer.Instance);

        foreach (ContextNode ctx in model.Model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                if (type is not ValueObjectDecl vo || vo.Invariants.Count == 0)
                {
                    continue;
                }

                // A shared-kernel type is only lowered by its owning context (it is emitted once).
                if (index.IsSharedKernelType(vo.Name) && index.KernelOwnerOfType(vo.Name) != ctx.Name)
                {
                    continue;
                }

                // Mirror the emitter's namespace derivation so the resolution context (R13.2) matches.
                string ns = index.KernelNamespaceOfType(vo.Name)
                            ?? ModelIndex.NamespaceOf(ctx.Name, vo.ModulePath);
                string? context = ContextOf(ns);

                var lowerer = new Lowerer(model, TypeScope.FromMembers(vo.Members, index), context);
                byVo[vo] = vo.Invariants.Select(lowerer.LowerInvariant).ToList();
            }
        }

        return new BoundModel(model, byVo);
    }

    /// <summary>
    /// A best-effort fallback lowering for a value object not visited by <see cref="Build"/> (e.g. a
    /// hand-built value object not reachable by walking <c>model.Contexts</c>). Scopes on the value
    /// object's own members with no bounded context — matching a context-less translator. Always
    /// returns the lowered invariants (never empty when the value object has invariants), so coverage
    /// tests that hand-build value objects still exercise the lowerer.
    /// </summary>
    private IReadOnlyList<BoundInvariant> LowerInvariants(ValueObjectDecl vo)
    {
        var lowerer = new Lowerer(_model, TypeScope.FromMembers(vo.Members, _model.Index), context: null);
        return vo.Invariants.Select(lowerer.LowerInvariant).ToList();
    }

    /// <summary>The bounded-context segment of an emitted namespace (mirrors <c>CSharpEmitter.ContextOf</c>).</summary>
    private static string ContextOf(string ns)
    {
        int dot = ns.IndexOf('.');
        return dot < 0 ? ns : ns[..dot];
    }
}
