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

    /// <summary>The <see cref="MemberSymbol"/> for a field of a value/entity/event type, else <c>null</c>.</summary>
    private MemberSymbol? MemberOf(string typeName, string memberName)
    {
        if (!Index.TryGetDecl(typeName, out TypeDecl decl))
        {
            return null;
        }

        IReadOnlyList<Member>? members = decl switch
        {
            ValueObjectDecl v => v.Members,
            EntityDecl e => e.Members,
            EventDecl ev => ev.Members,
            IntegrationEventDecl ie => ie.Members,
            _ => null
        };

        Member? m = members?.FirstOrDefault(x => x.Name == memberName);
        return m is not null && !m.NameSpan.IsNone ? new MemberSymbol(memberName, m.NameSpan, typeName, m) : null;
    }

    /// <summary>
    /// The innermost node whose <see cref="SourceSpan.Span"/> contains the 0-based absolute
    /// <paramref name="offset"/>, or <c>null</c> when none does. <see cref="SourceSpan.None"/>
    /// nodes (no width) never match. This is the precise position→node map that powers
    /// in-expression and spec-body navigation.
    /// </summary>
    public KoineNode? NodeAt(int offset)
    {
        KoineNode? best = null;
        var bestLength = int.MaxValue;
        foreach (KoineNode node in NodeWalker.Descendants(Model))
        {
            SourceSpan span = node.Span;
            if (span.IsNone || span.Length <= 0)
            {
                continue;
            }

            if (offset >= span.Offset && offset < span.Offset + span.Length && span.Length < bestLength)
            {
                best = node;
                bestLength = span.Length;
            }
        }

        return best;
    }

    /// <summary>
    /// The innermost declaration/member node whose <see cref="KoineNode.NameSpan"/> covers the
    /// 0-based absolute <paramref name="offset"/> — i.e. the node for which the offset sits on the
    /// declaration's own name, as opposed to anywhere in its body. <c>null</c> when the offset is
    /// not on any declaration name. Used by rename to classify whether a same-named token is a
    /// declaration's name (and of what structural role) versus a mere reference.
    /// </summary>
    public KoineNode? DeclarationNameAt(int offset)
    {
        KoineNode? best = null;
        var bestLength = int.MaxValue;
        foreach (KoineNode node in NodeWalker.Descendants(Model))
        {
            SourceSpan span = node.NameSpan;
            if (span.IsNone || span.Length <= 0)
            {
                continue;
            }

            if (offset >= span.Offset && offset < span.Offset + span.Length && span.Length < bestLength)
            {
                best = node;
                bestLength = span.Length;
            }
        }

        return best;
    }

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
            // A member's owning type is the nearest enclosing fielded-type declaration.
            case Member m when EnclosingFieldedTypeNameAt(offset) is { } owner:
                return new MemberSymbol(m.Name, m.NameSpan, owner, m);
            // An enum member resolves precisely to its owning enum, even when a same-named type exists.
            case EnumMember em when EnclosingEnumNameAt(offset) is { } enumName:
                return new EnumMemberSymbol(em.Name, em.NameSpan, enumName, em);
            // Type / spec declarations resolve through the name path (they are globally unique).
            case TypeDecl t:
                return GetSymbol(t.Name);
            case SpecDecl s:
                return GetSymbol(s.Name);
            default:
                return null;
        }
    }

    /// <summary>The name of the innermost value/entity/event/integration-event declaration whose body contains <paramref name="offset"/>.</summary>
    private string? EnclosingFieldedTypeNameAt(int offset)
    {
        string? name = null;
        var bestLength = int.MaxValue;
        foreach (KoineNode node in NodeWalker.Descendants(Model))
        {
            if (node is ValueObjectDecl or EntityDecl or EventDecl or IntegrationEventDecl
                && Contains(node.Span, offset) && node.Span.Length < bestLength)
            {
                name = ((TypeDecl)node).Name;
                bestLength = node.Span.Length;
            }
        }

        return name;
    }

    /// <summary>The name of the innermost enum declaration whose body contains <paramref name="offset"/>.</summary>
    private string? EnclosingEnumNameAt(int offset)
    {
        string? name = null;
        var bestLength = int.MaxValue;
        foreach (KoineNode node in NodeWalker.Descendants(Model))
        {
            if (node is EnumDecl e && Contains(node.Span, offset) && node.Span.Length < bestLength)
            {
                name = e.Name;
                bestLength = node.Span.Length;
            }
        }

        return name;
    }

    private static bool Contains(SourceSpan span, int offset) =>
        !span.IsNone && span.Length > 0 && offset >= span.Offset && offset < span.Offset + span.Length;

    /// <summary>
    /// Resolves go-to-definition at a 0-based absolute <paramref name="offset"/>: finds the
    /// innermost name-bearing node under the cursor (an identifier / member-access / call, a
    /// type reference, or a declaration's own name) and resolves it via
    /// <see cref="GetSymbol(string, string?)"/> using the enclosing type as the lexical scope.
    /// Returns <c>null</c> when nothing name-bearing sits at the offset or it does not resolve.
    /// </summary>
    public Symbol? DefinitionAt(int offset)
    {
        string? name = null;
        string? enclosingType = null;
        var nameLength = int.MaxValue;

        // Track the innermost enclosing type declaration AND the innermost name-bearing node,
        // in a single pass over the tree.
        foreach (KoineNode node in NodeWalker.Descendants(Model))
        {
            SourceSpan span = node.Span;
            if (span.IsNone || span.Length <= 0)
            {
                continue;
            }

            var contains = offset >= span.Offset && offset < span.Offset + span.Length;
            if (!contains)
            {
                continue;
            }

            switch (node)
            {
                // A type body: its own fields are in scope.
                case ValueObjectDecl or EntityDecl or EventDecl or IntegrationEventDecl:
                    enclosingType = ((TypeDecl)node).Name;
                    break;
                // A spec body resolves field references against the spec's target type (R10.1),
                // which unblocks navigation inside `spec X on T = <expr>`.
                case SpecDecl spec:
                    enclosingType = spec.TargetType;
                    break;
            }

            if (NameAtNode(node, offset) is { } candidate && candidate.Length < nameLength)
            {
                name = candidate.Name;
                nameLength = candidate.Length;
            }
        }

        return name is null ? null : GetSymbol(name, enclosingType);
    }

    /// <summary>
    /// The name (and the width of the node it came from, for innermost-wins tie-breaking) that a
    /// node contributes at <paramref name="offset"/>, or <c>null</c> if the node carries no
    /// navigable name there. Only a bare <see cref="IdentifierExpr"/> reference and a
    /// <see cref="TypeRef"/> resolve precisely by offset. A member-access/call selector
    /// (e.g. the <c>total</c> in <c>order.total</c>) is NOT resolved here — that needs the
    /// receiver's inferred type, beyond the name-only <see cref="GetSymbol(string, string?)"/> path —
    /// so the cursor there falls through to the legacy token-based resolution.
    /// </summary>
    private static (string Name, int Length)? NameAtNode(KoineNode node, int offset) => node switch
    {
        IdentifierExpr id => (id.Name, node.Span.Length),
        TypeRef tr => (tr.Name, node.Span.Length),
        _ => null
    };

    public Symbol? GetSymbol(string name)
    {
        if (Index.TryGetDecl(name, out TypeDecl decl) && !decl.NameSpan.IsNone)
        {
            return new TypeSymbol(name, decl.NameSpan, Index.Classify(name), decl);
        }

        IReadOnlyList<string> owners = Index.EnumsDeclaring(name);
        if (owners.Count == 1 && Index.TryGetDecl(owners[0], out TypeDecl ed) && ed is EnumDecl e)
        {
            EnumMember? member = e.Members.FirstOrDefault(m => m.Name == name);
            if (member is not null && !member.NameSpan.IsNone)
            {
                return new EnumMemberSymbol(name, member.NameSpan, owners[0], member);
            }
        }

        SpecDecl? spec = Index.AllSpecs().FirstOrDefault(s => s.Name == name);
        if (spec is not null && !spec.NameSpan.IsNone)
        {
            return new SpecSymbol(name, spec.NameSpan, spec);
        }

        // ID type (e.g. ProductId) -> the entity that declares `identified by <name>`. There is no
        // standalone ID node, so navigation deliberately lands on the owning entity's name.
        EntityDecl? owner = Index.AllTypes().OfType<EntityDecl>().FirstOrDefault(en => en.IdentityName == name);
        if (owner is not null && !owner.NameSpan.IsNone)
        {
            return new IdValueObjectSymbol(name, owner.NameSpan, owner);
        }

        return null;
    }
}
