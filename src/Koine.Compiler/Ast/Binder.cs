namespace Koine.Compiler.Ast;

/// <summary>
/// The binder (Commit 3, TARGET-AGNOSTIC). Descends the whole <see cref="KoineModel"/> ONCE via the
/// generated <see cref="KoineSyntaxVisitor"/>, maintaining a lexical-scope stack (current context,
/// current enclosing type, current behavior symbol, plus <c>let</c>/lambda locals), and records every
/// reference-bearing node → its interned <see cref="Symbol"/> into a <see cref="BindingTable"/>.
///
/// <para>Resolution is a faithful re-expression of the EXISTING string paths
/// (<see cref="SemanticModel.GetSymbol(string,string?)"/> / <see cref="ModelIndex.ResolveReference"/>),
/// not new semantics: it asks the same questions, then <em>interns and records</em>. The single source
/// of truth for resolution rules stays <see cref="ModelIndex"/>; the binder owns identity only.</para>
/// </summary>
internal sealed class Binder : KoineSyntaxVisitor
{
    private readonly SymbolTable _symbols;
    private readonly ModelIndex _index;
    private readonly BindingTable _bindings = new();

    // Lexical scope (push/pop as the visitor descends). The stack frames model the DSL's nesting.
    private ContextSymbol? _context;        // the bounded context currently being walked
    private string? _enclosingTypeName;     // nearest fielded type / spec target — the member-resolution scope
    private string? _enclosingContextName;  // the context that scope resolves in (R13.2)
    private Symbol? _enclosingBehavior;      // nearest behavior/spec/type symbol — container for locals

    // In-scope let-locals and lambda parameters, innermost-last (name -> interned symbol).
    private readonly List<(string Name, Symbol Symbol)> _locals = new();

    private Binder(SymbolTable symbols, ModelIndex index)
    {
        _symbols = symbols;
        _index = index;
    }

    /// <summary>Builds the symbol table and the binding table for <paramref name="model"/> in one walk.</summary>
    public static (SymbolTable Symbols, BindingTable Bindings) Bind(KoineModel model, ModelIndex index)
    {
        var symbols = new SymbolTable(model, index);
        var binder = new Binder(symbols, index);
        binder.Visit(model);
        return (symbols, binder._bindings);
    }

    // ---- Scope-pushing overrides ------------------------------------------------

    public override void VisitContextNode(ContextNode node)
    {
        ContextSymbol? prev = _context;
        _context = _symbols.ContextByName(node.Name);
        base.VisitContextNode(node);
        _context = prev;
    }

    public override void VisitValueObjectDecl(ValueObjectDecl node) => WithType(node, () => base.VisitValueObjectDecl(node));
    public override void VisitEntityDecl(EntityDecl node) => WithType(node, () => base.VisitEntityDecl(node));
    public override void VisitEventDecl(EventDecl node) => WithType(node, () => base.VisitEventDecl(node));
    public override void VisitIntegrationEventDecl(IntegrationEventDecl node) => WithType(node, () => base.VisitIntegrationEventDecl(node));

    private void WithType(TypeDecl node, Action walk)
    {
        string? prevType = _enclosingTypeName;
        string? prevCtx = _enclosingContextName;
        Symbol? prevBehavior = _enclosingBehavior;
        _enclosingTypeName = node.Name;
        _enclosingContextName = _context?.Name;
        _enclosingBehavior = _symbols.TypeOf(node) ?? _enclosingBehavior;
        walk();
        _enclosingTypeName = prevType;
        _enclosingContextName = prevCtx;
        _enclosingBehavior = prevBehavior;
    }

    public override void VisitSpecDecl(SpecDecl node)
    {
        // The spec's body resolves names against its target type (matching DefinitionAt's spec scope).
        string? prevType = _enclosingTypeName;
        string? prevCtx = _enclosingContextName;
        Symbol? prevBehavior = _enclosingBehavior;
        _enclosingTypeName = node.TargetType;
        _enclosingContextName = _context?.Name;
        _enclosingBehavior = _symbols.DeclaredSymbol(node) ?? _enclosingBehavior;

        // SpecDecl.TargetType binds (as a reference) to the target type's interned TypeSymbol.
        if (ResolveTypeName(node.TargetType, _enclosingContextName) is { } targetSym)
        {
            _bindings.Bind(node, targetSym);
        }

        base.VisitSpecDecl(node);

        _enclosingTypeName = prevType;
        _enclosingContextName = prevCtx;
        _enclosingBehavior = prevBehavior;
    }

    public override void VisitLetExpr(LetExpr node)
    {
        int mark = _locals.Count;
        // Each binding is in scope for the bindings that follow it and the body (sequential).
        foreach (LetBinding b in node.Bindings)
        {
            Visit(b.Value);
            if (_symbols.DeclaredSymbol(b) is { } declared)
            {
                _locals.Add((b.Name, declared));
            }
            else
            {
                var local = new LocalSymbol(b.Name, b.NameSpan, b) { ContainingSymbol = _enclosingBehavior ?? (Symbol?)_context ?? ErrorSymbol.Instance };
                _locals.Add((b.Name, local));
            }
        }

        Visit(node.Body);
        _locals.RemoveRange(mark, _locals.Count - mark);
    }

    public override void VisitLambdaExpr(LambdaExpr node)
    {
        int mark = _locals.Count;
        var param = new LambdaParameterSymbol(node.Parameter, node.Span, node)
        {
            ContainingSymbol = _enclosingBehavior ?? (Symbol?)_context ?? ErrorSymbol.Instance
        };
        _locals.Add((node.Parameter, param));
        Visit(node.Body);
        _locals.RemoveRange(mark, _locals.Count - mark);
    }

    // Behavior parameters are in scope for that behavior's body (requires/transitions/result/finder
    // expressions), so an identifier reference to a parameter resolves to its interned ParameterSymbol
    // (interned in the SymbolTable for command/factory/finder/query). Mirrors the let/lambda scoping.
    public override void VisitCommandDecl(CommandDecl node) => WithParams(node.Parameters, () => base.VisitCommandDecl(node));
    public override void VisitFactoryDecl(FactoryDecl node) => WithParams(node.Parameters, () => base.VisitFactoryDecl(node));
    public override void VisitFinderDecl(FinderDecl node) => WithParams(node.Parameters, () => base.VisitFinderDecl(node));
    public override void VisitQueryDecl(QueryDecl node) => WithParams(node.Criteria, () => base.VisitQueryDecl(node));

    private void WithParams(IReadOnlyList<Param> parameters, Action walk)
    {
        int mark = _locals.Count;
        foreach (Param p in parameters)
        {
            if (_symbols.ParameterSymbolOf(p) is { } ps)
            {
                _locals.Add((p.Name, ps));
            }
        }

        walk();
        _locals.RemoveRange(mark, _locals.Count - mark);
    }

    // ---- Reference-bearing overrides -------------------------------------------

    public override void VisitIdentifierExpr(IdentifierExpr node)
    {
        _bindings.Bind(node, ResolveIdentifier(node.Name));
        // No children.
    }

    public override void VisitTypeRef(TypeRef node)
    {
        if (ResolveTypeRef(node) is { } sym)
        {
            _bindings.Bind(node, sym);
        }

        base.VisitTypeRef(node); // descend into Element/Value type arguments
    }

    public override void VisitMemberAccessExpr(MemberAccessExpr node)
    {
        base.VisitMemberAccessExpr(node); // bind the receiver (and descend) first
        if (ResolveMemberAccessSelector(node) is { } selector)
        {
            _bindings.Bind(node, selector);
        }
    }

    /// <summary>
    /// Resolves a member-access selector (the <c>amount</c> in <c>total.amount</c>) to its interned
    /// symbol. Qualified enum references (<c>Phase.Active</c>) resolve to the enum member; otherwise the
    /// receiver's type is inferred (reusing <see cref="TypeResolver"/> over the lexical scope) and the
    /// selector resolves to that type's interned field. Best-effort: a non-field selector (a built-in op
    /// like <c>length</c>) or an undeterminable receiver leaves the node unbound (→ <see cref="ErrorSymbol"/>).
    /// </summary>
    private Symbol? ResolveMemberAccessSelector(MemberAccessExpr node)
    {
        if (node.Target is IdentifierExpr id && _index.IsEnumType(id.Name))
        {
            return _symbols.EnumMemberIn(id.Name, node.MemberName);
        }

        KoineType receiver = new TypeResolver(_index, _enclosingContextName).TypeOf(node.Target, BuildReceiverScope());
        if (receiver.IsError || receiver.Name is null)
        {
            return null;
        }

        return _symbols.MemberOf(receiver.Name, node.MemberName);
    }

    /// <summary>
    /// A best-effort lexical type scope for receiver inference: the enclosing type's fields plus the
    /// in-scope behavior parameters. Let/lambda locals (whose types need inference) are omitted — an
    /// unresolved receiver simply leaves the selector unbound.
    /// </summary>
    private TypeScope BuildReceiverScope()
    {
        IReadOnlyList<Member> members =
            _enclosingTypeName is not null && _index.TryGetDecl(_enclosingTypeName, out TypeDecl decl)
                ? FieldedMembers(decl)
                : Array.Empty<Member>();

        // Reuse the shared scope builders rather than open-coding KoineType.From over each name, so
        // receiver inference stays in lockstep with the rest of the compiler's scope construction.
        TypeScope scope = TypeScope.FromMembers(members, _index);
        foreach ((string name, Symbol sym) in _locals)
        {
            if (sym is ParameterSymbol p)
            {
                scope = scope.WithRef(name, p.Declaration.Type, _index);
            }
        }

        return scope;
    }

    private static IReadOnlyList<Member> FieldedMembers(TypeDecl decl) => decl switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => Array.Empty<Member>()
    };

    // ---- Resolution (reproduces the existing string paths) ---------------------

    /// <summary>
    /// Reproduces <see cref="SemanticModel.GetSymbol(string,string?)"/>: an in-scope let-local / lambda
    /// parameter first; then a field of the enclosing type (interned <see cref="MemberSymbol"/>); then
    /// the model-wide strong symbol (type / unambiguous enum member / spec / entity-owned ID). Falls
    /// back to <see cref="ErrorSymbol.Instance"/> for an unresolved name (built-in nullary ops, etc.).
    /// </summary>
    private Symbol ResolveIdentifier(string name)
    {
        // Innermost-first scan of let-locals / lambda parameters.
        for (int i = _locals.Count - 1; i >= 0; i--)
        {
            if (string.Equals(_locals[i].Name, name, StringComparison.Ordinal))
            {
                return _locals[i].Symbol;
            }
        }

        if (_enclosingTypeName is not null && _symbols.MemberOf(_enclosingTypeName, name) is { } member)
        {
            return member;
        }

        return _symbols.StrongSymbol(name) ?? ErrorSymbol.Instance;
    }

    /// <summary>
    /// Reproduces <see cref="ModelIndex.ResolveReference"/> + <see cref="ModelIndex.Classify"/>: a
    /// declared type in the current context (R13.2), a qualified <c>Context.T</c>, or the <c>*Id</c>
    /// convention. Primitives/collections bind to nothing (return <c>null</c>; the reference stays
    /// unbound and <see cref="BindingTable.GetSymbolInfo"/> answers <see cref="ErrorSymbol.Instance"/>).
    /// </summary>
    private Symbol? ResolveTypeRef(TypeRef tr)
    {
        TypeKind kind = _index.Classify(tr.Name);
        if (kind is TypeKind.Primitive or TypeKind.List or TypeKind.Set or TypeKind.Map or TypeKind.Range)
        {
            return null; // not a declaration
        }

        if (kind == TypeKind.IdValueObject)
        {
            return _symbols.IdValueObject(tr.Name);
        }

        // Qualified Context.T: resolve in that context.
        if (tr.Qualifier is { } qualifier)
        {
            return ResolveTypeName(tr.Name, qualifier);
        }

        return ResolveTypeName(tr.Name, _enclosingContextName);
    }

    /// <summary>The interned <see cref="TypeSymbol"/> for <paramref name="name"/> as seen from <paramref name="context"/> (R13.2), else <c>null</c>.</summary>
    private TypeSymbol? ResolveTypeName(string name, string? context)
    {
        // Context-scoped first (R13.2 — picks the right Money), then the global flat view.
        if (context is not null && _index.TryGetDeclIn(context, name, out TypeDecl decl))
        {
            return _symbols.TypeOf(decl);
        }

        if (_index.TryGetDecl(name, out TypeDecl global))
        {
            return _symbols.TypeOf(global);
        }

        return null;
    }
}
