namespace Koine.Compiler.Ast;

/// <summary>The resolved category of a type reference.</summary>
public enum TypeKind
{
    Primitive,
    List,
    Set,
    Map,
    Range,
    Value,
    Entity,
    Aggregate,
    Enum,
    Event,
    /// <summary>A read-model DTO projected from a source type (R12.3).</summary>
    ReadModel,
    /// <summary>A query object with typed criteria (R12.4).</summary>
    Query,
    /// <summary>A generated ID value object (wraps a Guid), e.g. <c>OrderId</c>.</summary>
    IdValueObject,
    Unknown
}

/// <summary>
/// Target-agnostic name resolution over a <see cref="KoineModel"/>. Used by both
/// the semantic validator and the emitter so they classify type references the
/// same way.
///
/// <para>For v0, user type names are treated as unique within a model (flat
/// resolution); nested aggregate types resolve from anywhere in their context.</para>
///
/// <para><b>ID convention:</b> a name is an <see cref="TypeKind.IdValueObject"/>
/// when it appears in an <c>identified by</c> clause, or when it is referenced as
/// a field type and matches <c>^[A-Z]\w*Id$</c> without being otherwise declared.
/// This lets fields like <c>product: ProductId</c> resolve even when no entity
/// declares <c>ProductId</c>.</para>
/// </summary>
public sealed class ModelIndex
{
    public static readonly IReadOnlySet<string> Primitives =
        new HashSet<string> { "String", "Int", "Decimal", "Bool", "Instant" };

    public const string ListTypeName = "List";
    public const string SetTypeName = "Set";
    public const string MapTypeName = "Map";
    public const string RangeTypeName = "Range";

    private readonly Dictionary<string, TypeDecl> _byName = new(StringComparer.Ordinal);
    private readonly HashSet<string> _idTypeNames = new(StringComparer.Ordinal);

    // Per-context resolution (R13.2/R13.3). _declaringContexts: a simple type name -> the
    // contexts that declare it (>1 means it's cross-context ambiguous unless qualified).
    // _namespaceByContextType: context -> (type name -> the C# namespace it emits into).
    private readonly HashSet<string> _contextNames = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _declaringContexts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Dictionary<string, string>> _namespaceByContextType = new(StringComparer.Ordinal);
    // context -> (type name -> its declaration), for context-aware member resolution when
    // the same simple name is declared in more than one context (R13.2).
    private readonly Dictionary<string, Dictionary<string, TypeDecl>> _declsByContext = new(StringComparer.Ordinal);
    // context -> (imported type name -> the context(s) that name was imported from).
    private readonly Dictionary<string, Dictionary<string, List<string>>> _importsByContext = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _enumMemberToType = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _enumMembersByName = new(StringComparer.Ordinal);
    // Specs keyed by target type name, then spec name (R10.1). v0 flat resolution.
    private readonly Dictionary<string, Dictionary<string, SpecDecl>> _specsByTarget = new(StringComparer.Ordinal);
    private static readonly IReadOnlyDictionary<string, SpecDecl> NoSpecs = new Dictionary<string, SpecDecl>();

    public KoineModel Model { get; }

    /// <summary>All ID value-object names that must be generated.</summary>
    public IReadOnlyCollection<string> IdTypeNames => _idTypeNames;

    /// <summary>
    /// Maps an enum member name to its owning enum type name (e.g. <c>Draft</c> -&gt;
    /// <c>OrderStatus</c>). For v0 members are assumed globally unique; on a clash
    /// the last declaration wins (see roadmap R3.5 for scoped resolution).
    /// </summary>
    public IReadOnlyDictionary<string, string> EnumMemberToType => _enumMemberToType;

    /// <summary>All enum types that declare a given member name (≥2 means ambiguous).</summary>
    public IReadOnlyList<string> EnumsDeclaring(string member) =>
        _enumMembersByName.TryGetValue(member, out var list) ? list : Array.Empty<string>();

    /// <summary>True when <paramref name="name"/> is the name of a declared enum type.</summary>
    public bool IsEnumType(string name) => Classify(name) == TypeKind.Enum;

    public ModelIndex(KoineModel model)
    {
        Model = model;

        // 1. Index every declared type (flat, recursing into aggregates).
        foreach (var ctx in model.Contexts)
            foreach (var t in ctx.Types)
                IndexType(t);

        // 1b. Per-context indexing for namespace computation and cross-context
        //     resolution (R13.2/R13.3): which context owns each type, and the full
        //     namespace (context + module path) it emits into.
        foreach (var ctx in model.Contexts)
        {
            _contextNames.Add(ctx.Name);
            var nsByType = new Dictionary<string, string>(StringComparer.Ordinal);
            var declsByType = new Dictionary<string, TypeDecl>(StringComparer.Ordinal);
            foreach (var t in FlattenTypes(ctx))
            {
                var ns = NamespaceOf(ctx.Name, t.ModulePath);
                nsByType[t.Name] = ns;
                declsByType[t.Name] = t;
                if (!_declaringContexts.TryGetValue(t.Name, out var owners))
                    _declaringContexts[t.Name] = owners = new List<string>();
                if (!owners.Contains(ctx.Name))
                    owners.Add(ctx.Name);
            }
            _namespaceByContextType[ctx.Name] = nsByType;
            _declsByContext[ctx.Name] = declsByType;
        }

        // 1c. Resolve each context's imports to (name -> owning context(s)). A name
        //     imported from two contexts is ambiguous when used unqualified (R13.2).
        //     Unknown contexts / non-exported names are skipped here (the validator reports them).
        foreach (var ctx in model.Contexts)
        {
            var imported = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var imp in ctx.Imports)
            {
                if (!_namespaceByContextType.TryGetValue(imp.Context, out var theirTypes))
                    continue;
                var names = imp.IsWildcard ? theirTypes.Keys : (IEnumerable<string>)imp.Names;
                foreach (var name in names)
                {
                    if (!theirTypes.ContainsKey(name))
                        continue;
                    if (!imported.TryGetValue(name, out var owners))
                        imported[name] = owners = new List<string>();
                    if (!owners.Contains(imp.Context))
                        owners.Add(imp.Context);
                }
            }
            _importsByContext[ctx.Name] = imported;
        }

        // 2. Collect ID-value-object names from `identified by` clauses…
        foreach (var decl in AllTypes())
            if (decl is EntityDecl e)
                _idTypeNames.Add(e.IdentityName);

        // 3. …and from `*Id` references not otherwise declared, anywhere a type can be
        //    named (fields, event payloads, command/factory/operation parameters, returns).
        foreach (var ctx in model.Contexts)
            foreach (var typeRef in AllTypeRefsIn(ctx))
                NoteIdReferences(typeRef);

        // 3b. Index specs by their target type (from context AND aggregate scope).
        foreach (var ctx in model.Contexts)
        {
            foreach (var spec in ctx.Specs) IndexSpec(spec);
            foreach (var t in ctx.Types)
                if (t is AggregateDecl agg)
                    foreach (var spec in agg.Specs) IndexSpec(spec);
        }

        // 3c. Register each context's ID value objects (emitted into its BASE namespace,
        //     R13.3) so a module-namespaced type that references an ID gets a precise using.
        foreach (var ctx in model.Contexts)
        {
            if (!_namespaceByContextType.TryGetValue(ctx.Name, out var nsByType))
                continue;
            void NoteId(string name)
            {
                if ((_idTypeNames.Contains(name) || IsIdConvention(name)) && !nsByType.ContainsKey(name))
                    nsByType[name] = ctx.Name;
            }
            foreach (var t in FlattenTypes(ctx))
                if (t is EntityDecl e)
                    NoteId(e.IdentityName);
            foreach (var tr in AllTypeRefsIn(ctx))
                NoteIdNamesIn(tr, NoteId);
        }

        // 4. Index enum members so bare members (e.g. `Draft`) resolve to a type.
        //    Track ALL owning enums per member so shared names can be disambiguated.
        foreach (var decl in AllTypes())
            if (decl is EnumDecl e)
                foreach (var member in e.MemberNames)
                {
                    _enumMemberToType[member] = e.Name; // first/last owner (unambiguous case)
                    if (!_enumMembersByName.TryGetValue(member, out var owners))
                        _enumMembersByName[member] = owners = new List<string>();
                    if (!owners.Contains(e.Name))
                        owners.Add(e.Name);
                }
    }

    /// <summary>
    /// Resolves the declared type of a member on a named value/entity type, using the
    /// GLOBAL view (a simple-name lookup). Returns <c>false</c> for primitives, collections,
    /// unknown types, or unknown members. Prefer the context-aware overload when the
    /// reference site's context is known (so a name shared across contexts resolves locally).
    /// </summary>
    public bool TryGetMemberType(string typeName, string memberName, out TypeRef type)
    {
        type = null!;
        return _byName.TryGetValue(typeName, out var decl) && MemberTypeOf(decl, memberName, out type);
    }

    /// <summary>
    /// Resolves a member type with <paramref name="context"/>-aware type resolution (R13.2):
    /// the named type is resolved in that context's scope first (local, then an unambiguous
    /// import), falling back to the global view — so a <c>Money</c> declared in two contexts
    /// resolves to the right one at each reference site.
    /// </summary>
    public bool TryGetMemberType(string? context, string typeName, string memberName, out TypeRef type)
    {
        type = null!;
        if (context is not null && TryGetDeclIn(context, typeName, out var decl))
            return MemberTypeOf(decl, memberName, out type);
        return TryGetMemberType(typeName, memberName, out type);
    }

    /// <summary>Resolves a type name to its declaration as seen from <paramref name="context"/> (local, then an unambiguous import).</summary>
    public bool TryGetDeclIn(string context, string typeName, out TypeDecl decl)
    {
        if (_declsByContext.TryGetValue(context, out var local) && local.TryGetValue(typeName, out decl!))
            return true;
        if (_importsByContext.TryGetValue(context, out var imports)
            && imports.TryGetValue(typeName, out var owners) && owners.Count == 1
            && _declsByContext.TryGetValue(owners[0], out var theirs) && theirs.TryGetValue(typeName, out decl!))
            return true;
        decl = null!;
        return false;
    }

    /// <summary>Finds a member's declared type on a value/entity/event declaration (entity <c>id</c> -&gt; its ID type).</summary>
    private static bool MemberTypeOf(TypeDecl decl, string memberName, out TypeRef type)
    {
        type = null!;
        IReadOnlyList<Member> members;
        switch (decl)
        {
            case ValueObjectDecl v: members = v.Members; break;
            case EventDecl ev: members = ev.Members; break;
            case EntityDecl e:
                if (memberName is "id" or "Id")
                {
                    type = new TypeRef(e.IdentityName);
                    return true;
                }
                members = e.Members;
                break;
            default: return false;
        }

        foreach (var m in members)
            if (string.Equals(m.Name, memberName, StringComparison.Ordinal))
            {
                type = m.Type;
                return true;
            }
        return false;
    }

    /// <summary>
    /// Every type reference a context names: value/entity/event fields, command,
    /// factory and operation parameters, and operation return types. Used so an
    /// <c>*Id</c> (or other) type referenced only in a payload or a parameter is still
    /// indexed and emitted.
    /// </summary>
    public static IEnumerable<TypeRef> AllTypeRefsIn(ContextNode ctx)
    {
        foreach (var t in FlattenTypes(ctx))
        {
            switch (t)
            {
                case ValueObjectDecl v:
                    foreach (var m in v.Members) yield return m.Type;
                    break;
                case EntityDecl e:
                    foreach (var m in e.Members) yield return m.Type;
                    foreach (var c in e.Commands)
                        foreach (var p in c.Parameters) yield return p.Type;
                    foreach (var f in e.Factories)
                        foreach (var p in f.Parameters) yield return p.Type;
                    break;
                case EventDecl ev:
                    foreach (var m in ev.Members) yield return m.Type;
                    break;
                case AggregateDecl agg when agg.Repository is { } repo:
                    foreach (var finder in repo.Finders)
                    {
                        yield return finder.ResultType;
                        foreach (var p in finder.Parameters) yield return p.Type;
                    }
                    break;
                case ReadModelDecl rm:
                    foreach (var f in rm.Fields)
                        if (f.Type is not null) yield return f.Type;
                    break;
                case QueryDecl q:
                    yield return q.ResultType;
                    foreach (var p in q.Criteria) yield return p.Type;
                    break;
            }
        }

        foreach (var svc in ctx.Services)
        {
            foreach (var op in svc.Operations)
            {
                yield return op.ReturnType;
                foreach (var p in op.Parameters) yield return p.Type;
            }
            foreach (var uc in svc.UseCases)
            {
                if (uc.ReturnType is not null) yield return uc.ReturnType;
                foreach (var p in uc.Parameters) yield return p.Type;
            }
        }
    }

    private static IEnumerable<TypeDecl> FlattenTypes(ContextNode ctx)
    {
        foreach (var t in ctx.Types)
        {
            yield return t;
            if (t is AggregateDecl agg)
                foreach (var nested in agg.Types)
                    yield return nested;
        }
    }

    private void IndexSpec(SpecDecl spec)
    {
        if (!_specsByTarget.TryGetValue(spec.TargetType, out var map))
            _specsByTarget[spec.TargetType] = map = new Dictionary<string, SpecDecl>(StringComparer.Ordinal);
        map[spec.Name] = spec; // last wins on a duplicate (the validator reports it)
    }

    /// <summary>The specs declared over <paramref name="targetType"/>, by spec name.</summary>
    public IReadOnlyDictionary<string, SpecDecl> SpecsFor(string targetType) =>
        _specsByTarget.TryGetValue(targetType, out var map) ? map : NoSpecs;

    /// <summary>Looks up the spec named <paramref name="name"/> declared over <paramref name="targetType"/>.</summary>
    public bool TryGetSpec(string targetType, string name, out SpecDecl spec)
    {
        spec = null!;
        return _specsByTarget.TryGetValue(targetType, out var map) && map.TryGetValue(name, out spec!);
    }

    /// <summary>Every spec declared in the model.</summary>
    public IEnumerable<SpecDecl> AllSpecs() => _specsByTarget.Values.SelectMany(m => m.Values);

    /// <summary>True when <paramref name="name"/> is a spec on any target type.</summary>
    public bool IsAnySpec(string name) => _specsByTarget.Values.Any(m => m.ContainsKey(name));

    private void IndexType(TypeDecl t)
    {
        _byName[t.Name] = t;
        if (t is AggregateDecl agg)
            foreach (var nested in agg.Types)
                IndexType(nested);
    }

    /// <summary>Invokes <paramref name="note"/> for every type name within a (possibly generic) type reference.</summary>
    private static void NoteIdNamesIn(TypeRef tr, Action<string> note)
    {
        note(tr.Name);
        if (tr.Element is not null) NoteIdNamesIn(tr.Element, note);
        if (tr.Value is not null) NoteIdNamesIn(tr.Value, note);
    }

    private void NoteIdReferences(TypeRef type)
    {
        if (type.Element is not null) NoteIdReferences(type.Element);
        if (type.Value is not null) NoteIdReferences(type.Value);
        if (!_byName.ContainsKey(type.Name) && IsIdConvention(type.Name))
            _idTypeNames.Add(type.Name);
    }

    /// <summary>True when <paramref name="name"/> follows the ID naming convention.</summary>
    public static bool IsIdConvention(string name) =>
        name.Length > 2 && name.EndsWith("Id", StringComparison.Ordinal) && char.IsUpper(name[0]);

    /// <summary>Every declared type across all contexts and aggregates.</summary>
    public IEnumerable<TypeDecl> AllTypes()
    {
        foreach (var decl in _byName.Values)
            yield return decl;
    }

    public bool TryGetDecl(string typeName, out TypeDecl decl) => _byName.TryGetValue(typeName, out decl!);

    /// <summary>All names a type reference could legally resolve to (for suggestions).</summary>
    public IEnumerable<string> CandidateTypeNames =>
        _byName.Keys
            .Concat(Primitives)
            .Concat(new[] { ListTypeName, SetTypeName, MapTypeName, RangeTypeName })
            .Concat(_idTypeNames)
            .Distinct(StringComparer.Ordinal);

    /// <summary>The declared member names of a value/entity type (for suggestions).</summary>
    public IEnumerable<string> MemberNames(string typeName) => _byName.TryGetValue(typeName, out var decl)
        ? decl switch
        {
            ValueObjectDecl v => v.Members.Select(m => m.Name),
            EntityDecl e => e.Members.Select(m => m.Name),
            _ => Enumerable.Empty<string>()
        }
        : Enumerable.Empty<string>();

    // ------------------------------------------------------------------------
    // Cross-context resolution & namespaces (R13.2 / R13.3)
    // ------------------------------------------------------------------------

    /// <summary>How a type reference resolves from a given context.</summary>
    public enum RefKind
    {
        Resolved,
        UnimportedCrossContext,
        Ambiguous,
        UnknownContext,
        NotExported,
        Unknown
    }

    /// <summary>The outcome of resolving a reference, plus the candidate contexts (for the message).</summary>
    public readonly record struct RefResolution(RefKind Kind, IReadOnlyList<string> Candidates);

    /// <summary>True when <paramref name="name"/> is a declared bounded context.</summary>
    public bool IsContext(string name) => _contextNames.Contains(name);

    /// <summary>True when <paramref name="context"/> declares a type named <paramref name="typeName"/>.</summary>
    public bool DeclaresType(string context, string typeName) =>
        _namespaceByContextType.TryGetValue(context, out var m) && m.ContainsKey(typeName);

    /// <summary>The contexts that declare a type with this simple name.</summary>
    public IReadOnlyList<string> DeclaringContextsOf(string typeName) =>
        _declaringContexts.TryGetValue(typeName, out var l) ? l : Array.Empty<string>();

    /// <summary>The C# namespace a context+module-path emits into (e.g. <c>Billing.Pricing</c>).</summary>
    public static string NamespaceOf(string context, IReadOnlyList<string> modulePath) =>
        modulePath.Count == 0 ? context : context + "." + string.Join(".", modulePath);

    /// <summary>The namespace a type emits into, as declared in <paramref name="context"/> (or null).</summary>
    public string? NamespaceOfTypeIn(string context, string typeName) =>
        _namespaceByContextType.TryGetValue(context, out var m) && m.TryGetValue(typeName, out var ns) ? ns : null;

    /// <summary>
    /// For the emitter: every type name visible from <paramref name="context"/> (its own types,
    /// across all modules, plus unambiguously-imported foreign types) mapped to the namespace it
    /// lives in. Used to compute the precise <c>using</c> set for a file (R13.2/R13.3).
    /// </summary>
    public IReadOnlyDictionary<string, string> VisibleTypeNamespaces(string context)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        if (_namespaceByContextType.TryGetValue(context, out var local))
            foreach (var kv in local)
                result[kv.Key] = kv.Value;
        if (_importsByContext.TryGetValue(context, out var imported))
            foreach (var kv in imported)
                // A local type shadows an imported one of the same name — never overwrite it.
                if (!result.ContainsKey(kv.Key) && kv.Value.Count == 1 && NamespaceOfTypeIn(kv.Value[0], kv.Key) is { } ns)
                    result[kv.Key] = ns;
        return result;
    }

    /// <summary>
    /// Resolves a type reference from <paramref name="fromContext"/> (R13.2): local types and the
    /// <c>*Id</c> convention need no import; a qualified <c>Context.T</c> resolves directly; an
    /// imported name resolves (ambiguous if imported from two contexts); an un-imported foreign
    /// type is an error. Primitives/collections and genuinely-unknown names resolve trivially
    /// (the latter is reported as KOI0101 elsewhere).
    /// </summary>
    public RefResolution ResolveReference(string fromContext, TypeRef tr)
    {
        var name = tr.Name;

        if (tr.Qualifier is { } qualifier)
        {
            if (!IsContext(qualifier))
                return new RefResolution(RefKind.UnknownContext, new[] { qualifier });
            if (!DeclaresType(qualifier, name))
                return new RefResolution(RefKind.NotExported, new[] { qualifier });
            return Ok;
        }

        var kind = Classify(name);
        if (kind is TypeKind.Primitive or TypeKind.List or TypeKind.Set or TypeKind.Map or TypeKind.Range)
            return Ok;
        if (DeclaresType(fromContext, name))
            return Ok;                              // local to this context
        if (kind == TypeKind.IdValueObject)
            return Ok;                              // *Id convention: emitted locally, no import

        if (_importsByContext.TryGetValue(fromContext, out var imports) && imports.TryGetValue(name, out var owners))
            return owners.Count == 1 ? Ok : new RefResolution(RefKind.Ambiguous, owners);

        var declaring = DeclaringContextsOf(name).Where(c => c != fromContext).ToList();
        if (declaring.Count > 0)
            return new RefResolution(RefKind.UnimportedCrossContext, declaring);

        return new RefResolution(RefKind.Unknown, Array.Empty<string>());
    }

    private static readonly RefResolution Ok = new(RefKind.Resolved, Array.Empty<string>());

    /// <summary>Classifies a type by its simple name.</summary>
    public TypeKind Classify(string typeName)
    {
        if (Primitives.Contains(typeName)) return TypeKind.Primitive;
        if (typeName == ListTypeName) return TypeKind.List;
        if (typeName == SetTypeName) return TypeKind.Set;
        if (typeName == MapTypeName) return TypeKind.Map;
        if (typeName == RangeTypeName) return TypeKind.Range;
        if (_byName.TryGetValue(typeName, out var decl))
            return decl switch
            {
                ValueObjectDecl => TypeKind.Value,
                EntityDecl => TypeKind.Entity,
                AggregateDecl => TypeKind.Aggregate,
                EnumDecl => TypeKind.Enum,
                EventDecl => TypeKind.Event,
                ReadModelDecl => TypeKind.ReadModel,
                QueryDecl => TypeKind.Query,
                _ => TypeKind.Unknown
            };
        if (_idTypeNames.Contains(typeName) || IsIdConvention(typeName)) return TypeKind.IdValueObject;
        return TypeKind.Unknown;
    }

    /// <summary>True when a type reference resolves to a known type.</summary>
    public bool IsKnownType(string typeName) => Classify(typeName) != TypeKind.Unknown;
}
