namespace Koine.Compiler.Ast;

/// <summary>
/// Canonical, TARGET-AGNOSTIC traversal helpers over the semantic model. These
/// centralize the flatten-into-aggregates and root-resolution logic that was
/// previously copied across the validator and the C# emitter.
/// </summary>
public static class AstExtensions
{
    /// <summary>
    /// Every type a context declares, flattening modules (already in <see cref="ContextNode.Types"/>)
    /// and each aggregate's nested types. Nested aggregates recurse safely.
    /// </summary>
    public static IEnumerable<TypeDecl> AllTypeDecls(this ContextNode ctx)
    {
        foreach (TypeDecl t in ctx.Types)
        {
            yield return t;
            if (t is AggregateDecl agg)
            {
                foreach (TypeDecl nested in agg.AllTypeDecls())
                {
                    yield return nested;
                }
            }
        }
    }

    /// <summary>The nested types of an aggregate, flattening any nested aggregates.</summary>
    private static IEnumerable<TypeDecl> AllTypeDecls(this AggregateDecl agg)
    {
        foreach (TypeDecl t in agg.Types)
        {
            yield return t;
            if (t is AggregateDecl nested)
            {
                foreach (TypeDecl deeper in nested.AllTypeDecls())
                {
                    yield return deeper;
                }
            }
        }
    }

    /// <summary>Every entity a context declares (flattening modules and aggregates).</summary>
    public static IEnumerable<EntityDecl> AllEntities(this ContextNode ctx) =>
        ctx.AllTypeDecls().OfType<EntityDecl>();

    /// <summary>
    /// The aggregate's resolved root entity (the nested entity whose name matches
    /// <see cref="AggregateDecl.RootName"/>), or <c>null</c> when it cannot be resolved
    /// (already a validation error).
    /// </summary>
    public static EntityDecl? RootEntity(this AggregateDecl agg) =>
        agg.Types.OfType<EntityDecl>().FirstOrDefault(e => e.Name == agg.RootName);
}
