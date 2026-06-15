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
    private readonly Dictionary<string, string> _enumMemberToType = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<string>> _enumMembersByName = new(StringComparer.Ordinal);

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

        // 2. Collect ID-value-object names from `identified by` clauses…
        foreach (var decl in AllTypes())
            if (decl is EntityDecl e)
                _idTypeNames.Add(e.IdentityName);

        // 3. …and from `*Id` field type references not otherwise declared.
        foreach (var decl in AllTypes())
        {
            switch (decl)
            {
                case ValueObjectDecl v:
                    foreach (var m in v.Members) NoteIdReferences(m.Type);
                    break;
                case EntityDecl en:
                    foreach (var m in en.Members) NoteIdReferences(m.Type);
                    break;
            }
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
    /// Resolves the declared type of a member on a named value/entity type.
    /// Returns <c>false</c> for primitives, collections, unknown types, or unknown
    /// members. The synthetic entity member <c>id</c> resolves to its ID type.
    /// </summary>
    public bool TryGetMemberType(string typeName, string memberName, out TypeRef type)
    {
        type = null!;
        if (!_byName.TryGetValue(typeName, out var decl))
            return false;

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

    private void IndexType(TypeDecl t)
    {
        _byName[t.Name] = t;
        if (t is AggregateDecl agg)
            foreach (var nested in agg.Types)
                IndexType(nested);
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
                _ => TypeKind.Unknown
            };
        if (_idTypeNames.Contains(typeName) || IsIdConvention(typeName)) return TypeKind.IdValueObject;
        return TypeKind.Unknown;
    }

    /// <summary>True when a type reference resolves to a known type.</summary>
    public bool IsKnownType(string typeName) => Classify(typeName) != TypeKind.Unknown;
}
