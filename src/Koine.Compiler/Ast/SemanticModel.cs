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

    /// <summary>
    /// The resolved type of <paramref name="expr"/> in the given <paramref name="scope"/>, as seen from
    /// <paramref name="context"/> (R13.2). Never <c>null</c> — an undeterminable type is
    /// <see cref="ErrorType"/>. The façade entry point for resolved-type queries.
    /// </summary>
    public KoineType GetTypeInfo(Expr expr, TypeScope scope, string? context = null) =>
        ResolverFor(context).TypeOf(expr, scope);

    /// <summary>
    /// Resolves a "strong" name to the declaration it refers to: a declared type, an unambiguous enum
    /// member, a named spec, or the entity that owns an ID value object. Returns <c>null</c> for
    /// primitives/collections and unknown or ambiguous names. The single resolution path the editor
    /// services share for go-to-definition, hover, and rename (R17).
    /// </summary>
    public Symbol? GetSymbol(string name)
    {
        if (Index.TryGetDecl(name, out TypeDecl decl) && decl.Span != SourceSpan.None)
        {
            return new TypeSymbol(name, decl.Span, Index.Classify(name), decl);
        }

        IReadOnlyList<string> owners = Index.EnumsDeclaring(name);
        if (owners.Count == 1 && Index.TryGetDecl(owners[0], out TypeDecl ed) && ed is EnumDecl e)
        {
            EnumMember? member = e.Members.FirstOrDefault(m => m.Name == name);
            if (member is not null && member.Span != SourceSpan.None)
            {
                return new EnumMemberSymbol(name, member.Span, owners[0], member);
            }
        }

        SpecDecl? spec = Index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null && spec.Span != SourceSpan.None)
        {
            return new SpecSymbol(name, spec.Span, spec);
        }

        // ID type (e.g. ProductId) -> the entity that declares `identified by <name>`. There is no
        // standalone ID node, so navigation deliberately lands on the owning entity's declaration.
        EntityDecl? owner = Index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
        if (owner is not null && owner.Span != SourceSpan.None)
        {
            return new IdValueObjectSymbol(name, owner.Span, owner);
        }

        return null;
    }
}
