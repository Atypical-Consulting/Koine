namespace Koine.Compiler.Ast;

/// <summary>
/// The interned declaration-symbol layer (Commit 3, TARGET-AGNOSTIC). Exactly one <see cref="Symbol"/>
/// instance per declaration, carrying the <see cref="Symbol.ContainingSymbol"/> containment spine.
/// Built once per <see cref="SemanticModel"/> over the <see cref="ModelIndex"/>: it reuses every
/// existing resolution rule (R13.2 cross-context, the <c>*Id</c> convention, enum ownership, specs)
/// for the <em>rules</em> and owns the <em>identity</em>.
///
/// <para><b>Build ordering invariant.</b> Containers must be interned before the things they contain
/// (a <see cref="MemberSymbol"/>'s container is its <see cref="TypeSymbol"/>): the constructor builds
/// <em>contexts → types → (members, parameters, enum members, id-VOs) → specs</em>. Locals/lambda
/// parameters are interned lazily by the <see cref="Binder"/> as it descends a body. Every non-context
/// interned symbol has a non-null <see cref="Symbol.ContainingSymbol"/>.</para>
/// </summary>
internal sealed class SymbolTable
{
    private readonly KoineModel _model;
    private readonly ModelIndex _index;

    // All node/record keys use BCL ReferenceEqualityComparer.Instance — Member/TypeDecl/EnumMember/
    // SpecDecl are value-equality records, so identity keying is MANDATORY (two structurally-identical
    // declarations — e.g. two `id: String` fields with Span.None name spans — would otherwise merge).
    private readonly Dictionary<TypeDecl, TypeSymbol> _types = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<Member, MemberSymbol> _members = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<EnumMember, EnumMemberSymbol> _enumMembers = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<SpecDecl, SpecSymbol> _specs = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<ContextNode, ContextSymbol> _contexts = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<Param, ParameterSymbol> _parameters = new(ReferenceEqualityComparer.Instance);

    // The bounded context that declares each type, for containment + (context, name) disambiguation.
    private readonly Dictionary<TypeDecl, ContextSymbol> _typeContext = new(ReferenceEqualityComparer.Instance);

    // The mutable downward-navigation lists held by each interned symbol (same instance as the symbol's
    // init-set IReadOnlyList view): filled as members/types/parameters intern. Keyed by interned identity.
    private readonly Dictionary<ContextSymbol, List<TypeSymbol>> _contextTypeLists = new(ReferenceEqualityComparer.Instance);
    private readonly Dictionary<TypeSymbol, List<Symbol>> _typeMemberLists = new(ReferenceEqualityComparer.Instance);

    // Name-keyed views that REPRODUCE the legacy GetSymbol decisions, but hand back interned symbols.
    private readonly Dictionary<string, ContextSymbol> _contextsByName = new(StringComparer.Ordinal);
    private readonly Dictionary<string, IdValueObjectSymbol> _idValueObjects = new(StringComparer.Ordinal);

    public SymbolTable(KoineModel model, ModelIndex index)
    {
        _model = model;
        _index = index;

        // 1. Contexts (top-level containers; ContainingSymbol = null). Each context's downward Types
        //    list is an init-set List instance we keep a reference to and fill in step 2 as its types
        //    intern — the same shared-list pattern ContainingSymbol cannot use (a container is built
        //    before the things it contains).
        foreach (ContextNode ctx in model.Contexts)
        {
            var ctxTypes = new List<TypeSymbol>();
            var ctxSym = new ContextSymbol(ctx.Name, ctx.Span, ctx) { Types = ctxTypes };
            _contexts[ctx] = ctxSym;
            _contextTypeLists[ctxSym] = ctxTypes;
            // First declaration of a name wins the name-view (rare duplicate contexts are a validator concern).
            if (!_contextsByName.ContainsKey(ctx.Name))
            {
                _contextsByName[ctx.Name] = ctxSym;
            }
        }

        // 2. Types (container = their context) and their members/enum-members.
        foreach (ContextNode ctx in model.Contexts)
        {
            ContextSymbol ctxSym = _contexts[ctx];
            foreach (TypeDecl t in ctx.AllTypeDecls())
            {
                InternType(t, ctxSym);
            }
        }

        // 2b. Behavior parameters. Container = the behavior's owning TypeSymbol; the parameter also joins
        //     that type's downward Members list. Covers the behaviors that hang off an interned TypeSymbol:
        //     entity commands/factories, aggregate-repository finders, and query criteria. Service
        //     operations have NO owning TypeSymbol (a ServiceDecl is not a TypeDecl), so their parameters
        //     are intentionally not interned here.
        foreach ((TypeDecl decl, TypeSymbol typeSym) in _types)
        {
            switch (decl)
            {
                case EntityDecl e:
                    foreach (CommandDecl c in e.Commands)
                    {
                        InternParams(c.Parameters, typeSym);
                    }

                    foreach (FactoryDecl f in e.Factories)
                    {
                        InternParams(f.Parameters, typeSym);
                    }

                    break;
                case AggregateDecl { Repository: { } repo }:
                    foreach (FinderDecl find in repo.Finders)
                    {
                        InternParams(find.Parameters, typeSym);
                    }

                    break;
                case QueryDecl q:
                    InternParams(q.Criteria, typeSym);
                    break;
            }
        }

        // 3. Specs (context-scoped, plus aggregate-scoped). Interned after types so an aggregate-scoped
        //    spec can point at its aggregate's interned TypeSymbol.
        foreach (ContextNode ctx in model.Contexts)
        {
            ContextSymbol ctxSym = _contexts[ctx];
            foreach (SpecDecl spec in ctx.Specs)
            {
                InternSpec(spec, ctxSym);
            }

            foreach (TypeDecl t in ctx.Types)
            {
                if (t is AggregateDecl agg && _types.TryGetValue(agg, out TypeSymbol? aggSym))
                {
                    foreach (SpecDecl spec in agg.Specs)
                    {
                        InternSpec(spec, aggSym);
                    }
                }
            }
        }

        // 4. ID value objects (synthesized; no standalone declaration node). One per distinct *Id name
        //    in ModelIndex.IdTypeNames. DeclSpan + container = the owning entity's TypeSymbol when an
        //    entity declares `identified by <name>`, else SourceSpan.None with a context container (so
        //    containment stays non-null). This mirrors ModelIndex's *Id set exactly.
        Symbol fallbackContainer = _contexts.Values.Count > 0
            ? _contexts.Values.First()
            : ErrorSymbol.Instance;
        foreach (var idName in _index.IdTypeNames)
        {
            EntityDecl? owner = _index.AllTypes().OfType<EntityDecl>()
                .FirstOrDefault(e => string.Equals(e.IdentityName, idName, StringComparison.Ordinal));
            if (owner is not null && _types.TryGetValue(owner, out TypeSymbol? ownerSym))
            {
                SourceSpan span = !owner.NameSpan.IsNone ? owner.NameSpan : SourceSpan.None;
                _idValueObjects[idName] = new IdValueObjectSymbol(idName, span, owner) { ContainingSymbol = ownerSym };
            }
            else
            {
                // Convention-only *Id: no owning entity. Still intern one (matches Classify == IdValueObject)
                // so a `product: ProductId` reference has a stable symbol; container is a context (non-null).
                _idValueObjects[idName] = new IdValueObjectSymbol(idName) { ContainingSymbol = fallbackContainer };
            }
        }
    }

    private void InternType(TypeDecl t, ContextSymbol ctxSym)
    {
        if (_types.ContainsKey(t))
        {
            return;
        }

        // The downward Members list is the same List instance the symbol's init-set IReadOnlyList view
        // exposes; we fill it below as members intern (the type symbol must exist first to be each
        // member's container, so the list can only be populated after construction).
        var memberList = new List<Symbol>();
        var typeSym = new TypeSymbol(t.Name, t.NameSpan, _index.Classify(t.Name), t) { ContainingSymbol = ctxSym, Members = memberList };
        _types[t] = typeSym;
        _typeContext[t] = ctxSym;
        _typeMemberLists[typeSym] = memberList;
        _contextTypeLists[ctxSym].Add(typeSym);

        switch (t)
        {
            case ValueObjectDecl v:
                InternMembers(v.Members, typeSym, memberList);
                break;
            case EntityDecl e:
                InternMembers(e.Members, typeSym, memberList);
                break;
            case EventDecl ev:
                InternMembers(ev.Members, typeSym, memberList);
                break;
            case IntegrationEventDecl ie:
                InternMembers(ie.Members, typeSym, memberList);
                break;
            case EnumDecl en:
                foreach (EnumMember m in en.Members)
                {
                    if (!_enumMembers.ContainsKey(m))
                    {
                        var sym = new EnumMemberSymbol(m.Name, m.NameSpan, en.Name, m) { ContainingSymbol = typeSym };
                        _enumMembers[m] = sym;
                        memberList.Add(sym);
                    }
                }

                break;
        }
    }

    private void InternMembers(IReadOnlyList<Member> members, TypeSymbol owner, List<Symbol> collected)
    {
        foreach (Member m in members)
        {
            if (!_members.ContainsKey(m))
            {
                var sym = new MemberSymbol(m.Name, m.NameSpan, owner.Name, m) { ContainingSymbol = owner };
                _members[m] = sym;
                collected.Add(sym);
            }
        }
    }

    private void InternParams(IReadOnlyList<Param> parameters, TypeSymbol owner)
    {
        foreach (Param p in parameters)
        {
            if (!_parameters.ContainsKey(p))
            {
                SourceSpan span = !p.NameSpan.IsNone ? p.NameSpan : p.Span;
                var sym = new ParameterSymbol(p.Name, span, p) { ContainingSymbol = owner };
                _parameters[p] = sym;
                _typeMemberLists[owner].Add(sym);
            }
        }
    }

    private void InternSpec(SpecDecl spec, Symbol container)
    {
        if (!_specs.ContainsKey(spec))
        {
            _specs[spec] = new SpecSymbol(spec.Name, spec.NameSpan, spec) { ContainingSymbol = container };
        }
    }

    // ------------------------------------------------------------------------
    // Declaration → interned symbol (the GetDeclaredSymbol target).
    // ------------------------------------------------------------------------

    /// <summary>The single interned symbol declared by <paramref name="declaration"/>, or <c>null</c> when it is not a declaration.</summary>
    public Symbol? DeclaredSymbol(KoineNode declaration) => declaration switch
    {
        TypeDecl t => _types.TryGetValue(t, out TypeSymbol? s) ? s : null,
        Member m => _members.TryGetValue(m, out MemberSymbol? s) ? s : null,
        EnumMember em => _enumMembers.TryGetValue(em, out EnumMemberSymbol? s) ? s : null,
        SpecDecl sp => _specs.TryGetValue(sp, out SpecSymbol? s) ? s : null,
        ContextNode c => _contexts.TryGetValue(c, out ContextSymbol? s) ? s : null,
        Param p => _parameters.TryGetValue(p, out ParameterSymbol? s) ? s : null,
        _ => null
    };

    public TypeSymbol? TypeOf(TypeDecl decl) => _types.TryGetValue(decl, out TypeSymbol? s) ? s : null;
    public MemberSymbol? MemberSymbolOf(Member m) => _members.TryGetValue(m, out MemberSymbol? s) ? s : null;
    public EnumMemberSymbol? EnumMemberSymbolOf(EnumMember m) => _enumMembers.TryGetValue(m, out EnumMemberSymbol? s) ? s : null;

    /// <summary>The interned member symbol for <paramref name="memberName"/> of enum <paramref name="enumName"/>, else <c>null</c>.</summary>
    public EnumMemberSymbol? EnumMemberIn(string enumName, string memberName)
    {
        if (_index.TryGetDecl(enumName, out TypeDecl decl) && decl is EnumDecl e)
        {
            EnumMember? m = e.Members.FirstOrDefault(x => string.Equals(x.Name, memberName, StringComparison.Ordinal));
            return m is not null ? EnumMemberSymbolOf(m) : null;
        }

        return null;
    }
    public ContextSymbol? ContextOfType(TypeDecl decl) => _typeContext.TryGetValue(decl, out ContextSymbol? s) ? s : null;
    public ParameterSymbol? ParameterSymbolOf(Param p) => _parameters.TryGetValue(p, out ParameterSymbol? s) ? s : null;
    public ContextSymbol? ContextByName(string name) => _contextsByName.TryGetValue(name, out ContextSymbol? s) ? s : null;

    // ------------------------------------------------------------------------
    // Name-based interned lookups — REPRODUCE the legacy GetSymbol decisions so the
    // re-pointed SemanticModel shims hand back interned identity with byte-identical
    // null/non-null behavior. These NEVER allocate a fresh symbol.
    // ------------------------------------------------------------------------

    /// <summary>The interned <see cref="MemberSymbol"/> for a field of a value/entity/event type, else <c>null</c>.</summary>
    public MemberSymbol? MemberOf(string typeName, string memberName)
    {
        if (!_index.TryGetDecl(typeName, out TypeDecl decl))
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

        Member? m = members?.FirstOrDefault(x => string.Equals(x.Name, memberName, StringComparison.Ordinal));
        return m is not null && !m.NameSpan.IsNone ? MemberSymbolOf(m) : null;
    }

    /// <summary>
    /// Reproduces <see cref="SemanticModel.GetSymbol(string)"/> EXACTLY, returning interned symbols:
    /// a declared type, an unambiguous enum member, a named spec, or the entity owning an ID value
    /// object. <c>null</c> for primitives/collections and unknown/ambiguous names (incl. a
    /// convention-only <c>*Id</c> with no owning entity, matching the legacy null contract).
    /// </summary>
    public Symbol? StrongSymbol(string name)
    {
        if (_index.TryGetDecl(name, out TypeDecl decl) && !decl.NameSpan.IsNone)
        {
            return TypeOf(decl);
        }

        IReadOnlyList<string> owners = _index.EnumsDeclaring(name);
        if (owners.Count == 1 && _index.TryGetDecl(owners[0], out TypeDecl ed) && ed is EnumDecl e)
        {
            EnumMember? member = e.Members.FirstOrDefault(m => string.Equals(m.Name, name, StringComparison.Ordinal));
            if (member is not null && !member.NameSpan.IsNone)
            {
                return EnumMemberSymbolOf(member);
            }
        }

        SpecDecl? spec = _index.AllSpecs().FirstOrDefault(s => string.Equals(s.Name, name, StringComparison.Ordinal));
        if (spec is not null && !spec.NameSpan.IsNone)
        {
            return _specs.TryGetValue(spec, out SpecSymbol? ss) ? ss : null;
        }

        // ID type (e.g. ProductId) -> the entity that declares `identified by <name>`. Convention-only
        // *Id names (no owning entity) resolve to null here, EXACTLY like the legacy GetSymbol(name).
        EntityDecl? owner = _index.AllTypes().OfType<EntityDecl>()
            .FirstOrDefault(en => string.Equals(en.IdentityName, name, StringComparison.Ordinal));
        if (owner is not null && !owner.NameSpan.IsNone)
        {
            return _idValueObjects.TryGetValue(name, out IdValueObjectSymbol? id) ? id : null;
        }

        return null;
    }

    /// <summary>
    /// The interned ID value-object symbol for any <c>*Id</c> name in <see cref="ModelIndex.IdTypeNames"/>
    /// (entity-declared <em>or</em> convention-only), else <c>null</c>. The binder uses this to bind a
    /// <c>product: ProductId</c> reference to a stable symbol regardless of whether an entity declares it.
    /// </summary>
    public IdValueObjectSymbol? IdValueObject(string name) =>
        _idValueObjects.TryGetValue(name, out IdValueObjectSymbol? s) ? s : null;
}
