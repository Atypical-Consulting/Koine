namespace Koine.Compiler.Ast.Bound;

/// <summary>
/// The per-<see cref="SemanticModel"/> bound artifact (Commit 4–5): lowers + caches each value object's
/// field projection (<see cref="BoundValueObject"/>) and its invariants, the forms the migrated emitter
/// slice consumes. Built lazily off <see cref="SemanticModel"/> with the same thread-safety discipline as
/// the syntax graph (Commit 1) and binding table (Commit 3). TARGET-AGNOSTIC.
///
/// <para>The cache is keyed by <see cref="ValueObjectDecl"/> using the BCL
/// <see cref="ReferenceEqualityComparer.Instance"/> — the recurring value-equality-record discipline
/// (4th incarnation): two identically-named value objects across different bounded contexts (R13.2) are
/// value-equal as records and would collide to one cache entry without it.</para>
/// </summary>
internal sealed class BoundModel
{
    private readonly SemanticModel _model;
    private readonly IReadOnlyDictionary<ValueObjectDecl, BoundValueObject> _byVo;

    private BoundModel(SemanticModel model, IReadOnlyDictionary<ValueObjectDecl, BoundValueObject> byVo)
    {
        _model = model;
        _byVo = byVo;
    }

    /// <summary>The lowered field projection + invariants of a value object (the Commit-5 entry point).</summary>
    public BoundValueObject BoundValueObjectFor(ValueObjectDecl vo) =>
        _byVo.TryGetValue(vo, out BoundValueObject? bound) ? bound : LowerValueObject(vo);

    /// <summary>The lowered invariants of a value object (the Commit-4 entry point, now folded into the projection).</summary>
    public IReadOnlyList<BoundInvariant> InvariantsFor(ValueObjectDecl vo) => BoundValueObjectFor(vo).Invariants;

    /// <summary>
    /// Lowers every value object once, in declaration order, scoped EXACTLY as the C# emitter scopes its
    /// expression translator for that value object (<c>TypeScope.FromMembers(vo.Members)</c> + the value
    /// object's bounded context, including the shared-kernel namespace remap) so the resolved types on the
    /// bound nodes are byte-identical to what the emitter saw. Field projection applies to ALL value
    /// objects, so (unlike the Commit-4 invariant-only build) value objects without invariants are lowered
    /// too.
    /// </summary>
    public static BoundModel Build(SemanticModel model)
    {
        ModelIndex index = model.Index;
        var byVo = new Dictionary<ValueObjectDecl, BoundValueObject>(ReferenceEqualityComparer.Instance);

        foreach (ContextNode ctx in model.Model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                if (type is not ValueObjectDecl vo)
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
                byVo[vo] = lowerer.LowerValueObject(vo);
            }
        }

        return new BoundModel(model, byVo);
    }

    /// <summary>
    /// A best-effort fallback lowering for a value object not visited by <see cref="Build"/> (e.g. a
    /// hand-built value object not reachable by walking <c>model.Contexts</c>). Scopes on the value
    /// object's own members with no bounded context — matching a context-less translator — so coverage
    /// tests that hand-build value objects still exercise the lowerer.
    /// </summary>
    private BoundValueObject LowerValueObject(ValueObjectDecl vo)
    {
        var lowerer = new Lowerer(_model, TypeScope.FromMembers(vo.Members, _model.Index), context: null);
        return lowerer.LowerValueObject(vo);
    }

    /// <summary>The bounded-context segment of an emitted namespace (mirrors <c>CSharpEmitter.ContextOf</c>).</summary>
    private static string ContextOf(string ns)
    {
        int dot = ns.IndexOf('.');
        return dot < 0 ? ns : ns[..dot];
    }
}
