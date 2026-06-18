using System.Threading;
using Koine.Compiler.Ast.Bound;

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

    private readonly Lazy<SyntaxGraph> _graph;
    private readonly Lazy<(SymbolTable Symbols, BindingTable Bindings)> _binding;
    private readonly Lazy<BoundModel> _bound;

    public SemanticModel(KoineModel model)
    {
        Model = model;
        Index = new ModelIndex(model);
        // Built on first position/navigation query only — the emit path never touches it.
        // Thread-safe so a cached/shared SemanticModel can't race the build under concurrent LSP requests.
        _graph = new Lazy<SyntaxGraph>(() => new SyntaxGraph(Model), LazyThreadSafetyMode.ExecutionAndPublication);
        // The interned symbol identity + binding table (Commit 3), built lazily with the same
        // thread-safety discipline as _graph; the emit path (which goes through Index) never forces it.
        _binding = new Lazy<(SymbolTable, BindingTable)>(
            () => Binder.Bind(Model, Index), LazyThreadSafetyMode.ExecutionAndPublication);
        // The lowered bound-IR slice (Commit 4): VO invariants, lowered + cached, built lazily with the
        // same thread-safety discipline. Only the migrated VO-invariant emit path forces it; everything
        // else in the C# emitter and ALL of the TS emitter never touch it, so they pay nothing.
        _bound = new Lazy<BoundModel>(() => BoundModel.Build(this), LazyThreadSafetyMode.ExecutionAndPublication);
    }

    private SymbolTable Symbols => _binding.Value.Symbols;

    /// <summary>The lowered invariants of a value object (the migrated slice's entry point, Commit 4).</summary>
    internal IReadOnlyList<BoundInvariant> BoundInvariantsFor(ValueObjectDecl vo) => _bound.Value.InvariantsFor(vo);

    /// <summary>
    /// The symbol a reference-bearing node resolves to (Roslyn <c>GetSymbolInfo</c>). Never <c>null</c>
    /// — an unresolved reference is <see cref="ErrorSymbol.Instance"/>, mirroring <see cref="ErrorType"/>.
    /// </summary>
    public Symbol GetSymbolInfo(KoineNode node) => _binding.Value.Bindings.GetSymbolInfo(node);

    /// <summary>
    /// The interned symbol declared by a declaration node (Roslyn <c>GetDeclaredSymbol</c>), or
    /// <c>null</c> when the node is not a declaration. The same instance is returned every call.
    /// </summary>
    public Symbol? GetDeclaredSymbol(KoineNode declaration) => Symbols.DeclaredSymbol(declaration);

    /// <summary>The node's parent, or <c>null</c> for the root. Red-layer navigation (Roslyn <c>Parent</c>).</summary>
    public KoineNode? Parent(KoineNode node) => _graph.Value.Parent(node);

    /// <summary>The node's child nodes in source order.</summary>
    public IReadOnlyList<KoineNode> ChildNodes(KoineNode node) => _graph.Value.ChildNodes(node);

    /// <summary>The parent chain, nearest-first, excluding <paramref name="node"/>.</summary>
    public IEnumerable<KoineNode> Ancestors(KoineNode node) => _graph.Value.Ancestors(node);

    /// <summary><paramref name="node"/> first, then its ancestors.</summary>
    public IEnumerable<KoineNode> AncestorsAndSelf(KoineNode node) => _graph.Value.AncestorsAndSelf(node);

    /// <summary>The nearest <typeparamref name="T"/> at or above <paramref name="node"/>, or <c>null</c>.</summary>
    public T? FirstAncestorOrSelf<T>(KoineNode node) where T : KoineNode => _graph.Value.FirstAncestorOrSelf<T>(node);

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
    /// <summary>
    /// Resolves a name referenced from within <paramref name="enclosingType"/>'s expressions
    /// (an invariant / command / factory body): a field of that type resolves to its
    /// <see cref="MemberSymbol"/>; otherwise falls back to the model-wide <see cref="GetSymbol(string)"/>
    /// (types, enum members, specs, ID value objects). This is the in-expression navigation entry point.
    /// </summary>
    public Symbol? GetSymbol(string name, string? enclosingType)
    {
        if (enclosingType is not null && MemberOf(enclosingType, name) is { } member)
        {
            return member;
        }

        return GetSymbol(name);
    }

    /// <summary>
    /// The <see cref="MemberSymbol"/> for a field of a value/entity/event type, else <c>null</c>.
    /// Re-pointed (Commit 3) to return the INTERNED symbol from the table — identity is gained while
    /// the null/non-null contract and all carried fields stay byte-identical.
    /// </summary>
    private MemberSymbol? MemberOf(string typeName, string memberName) => Symbols.MemberOf(typeName, memberName);

    /// <summary>
    /// The innermost node whose <see cref="SourceSpan"/> contains the 0-based absolute
    /// <paramref name="offset"/>, or <c>null</c> when none does. The position→node map that powers
    /// in-expression and spec-body navigation.
    /// </summary>
    public KoineNode? NodeAt(int offset) => _graph.Value.FindNode(offset);

    /// <summary>
    /// The innermost declaration/member node whose <see cref="KoineNode.NameSpan"/> covers the
    /// 0-based absolute <paramref name="offset"/>; <c>null</c> when the offset is not on any
    /// declaration name. Used by rename to classify a token as a declaration's own name.
    /// </summary>
    public KoineNode? DeclarationNameAt(int offset) => _graph.Value.FindNameNode(offset);

    /// <summary>
    /// The <see cref="Symbol"/> for the declaration whose own name sits at the 0-based absolute
    /// <paramref name="offset"/> (a "GetDeclaredSymbol" entry point). Unlike
    /// <see cref="GetSymbol(string,string?)"/>, this resolves by POSITION, so an enum member whose
    /// name collides with a type name resolves to the enum member (the thing actually under the
    /// cursor), not the type. <c>null</c> when the offset is not on a renameable declaration name.
    /// </summary>
    public Symbol? DeclaredSymbolAt(int offset)
    {
        if (DeclarationNameAt(offset) is not { } node)
        {
            return null;
        }

        switch (node)
        {
            // A member's owning type is the nearest enclosing fielded-type declaration. Re-pointed
            // (Commit 3) to the interned symbol; the enclosing-type guard preserves legacy behavior.
            case Member m when EnclosingFieldedTypeNameAt(offset) is { }:
                return Symbols.MemberSymbolOf(m);
            // An enum member resolves precisely to its owning enum, even when a same-named type exists.
            case EnumMember em when EnclosingEnumNameAt(offset) is { }:
                return Symbols.EnumMemberSymbolOf(em);
            // Type / spec declarations resolve through the name path (they are globally unique).
            case TypeDecl t:
                return GetSymbol(t.Name);
            case SpecDecl s:
                return GetSymbol(s.Name);
            default:
                return null;
        }
    }

    /// <summary>The name of the innermost value/entity/event/integration-event declaration enclosing <paramref name="offset"/>.</summary>
    private string? EnclosingFieldedTypeNameAt(int offset)
    {
        if (_graph.Value.FindNode(offset) is not { } node)
        {
            return null;
        }

        foreach (KoineNode anc in _graph.Value.AncestorsAndSelf(node))
        {
            if (anc is ValueObjectDecl or EntityDecl or EventDecl or IntegrationEventDecl)
            {
                return ((TypeDecl)anc).Name;
            }
        }

        return null;
    }

    /// <summary>The name of the innermost enum declaration enclosing <paramref name="offset"/>.</summary>
    private string? EnclosingEnumNameAt(int offset)
    {
        if (_graph.Value.FindNode(offset) is not { } node)
        {
            return null;
        }

        return _graph.Value.FirstAncestorOrSelf<EnumDecl>(node)?.Name;
    }

    /// <summary>
    /// Resolves go-to-definition at a 0-based absolute <paramref name="offset"/>: finds the innermost
    /// name-bearing node under the cursor (a bare identifier reference or a type reference) and
    /// resolves it via <see cref="GetSymbol(string, string?)"/> using the enclosing type as the
    /// lexical scope. <c>null</c> when nothing name-bearing sits at the offset or it does not resolve.
    /// </summary>
    public Symbol? DefinitionAt(int offset)
    {
        if (_graph.Value.FindNode(offset) is not { } node)
        {
            return null;
        }

        string? name = node switch
        {
            IdentifierExpr id => id.Name,
            TypeRef tr => tr.Name,
            _ => null
        };
        if (name is null)
        {
            return null;
        }

        // The lexical scope: the nearest enclosing fielded type, or a spec body's target type.
        string? enclosingType = null;
        foreach (KoineNode anc in _graph.Value.AncestorsAndSelf(node))
        {
            if (anc is ValueObjectDecl or EntityDecl or EventDecl or IntegrationEventDecl)
            {
                enclosingType = ((TypeDecl)anc).Name;
                break;
            }

            if (anc is SpecDecl spec)
            {
                enclosingType = spec.TargetType;
                break;
            }
        }

        return GetSymbol(name, enclosingType);
    }

    public Symbol? GetSymbol(string name)
    {
        // Re-pointed (Commit 3) to the INTERNED table. SymbolTable.StrongSymbol reproduces the legacy
        // decisions EXACTLY (declared type → unambiguous enum member → spec → entity-owned ID; null for
        // primitives/collections, unknown/ambiguous names, and convention-only *Id), so callers like
        // WorkspaceIndex.StrongSpan keep their null-for-unknown contract while gaining identity.
        return Symbols.StrongSymbol(name);
    }
}
