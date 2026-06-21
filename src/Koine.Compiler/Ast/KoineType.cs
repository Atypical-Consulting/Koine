namespace Koine.Compiler.Ast;

/// <summary>
/// A RESOLVED type, distinct from the syntactic <see cref="TypeRef"/> (what the source wrote).
/// Every node carries its <see cref="TypeKind"/> classification, so consumers read the kind directly
/// instead of re-calling <see cref="ModelIndex.Classify"/>. Inference never returns <c>null</c>:
/// an undeterminable type is the explicit <see cref="ErrorType"/> sentinel.
///
/// <para><b>Migration note (E1):</b> during the binding-pass migration <see cref="ErrorType"/> is kept
/// exactly as permissive as the previous <c>TypeRef?</c>-<c>null</c> contract — it does NOT yet strictly
/// absorb operations (that would change inferred results and diagnostics). Strict absorption / a distinct
/// strict <c>UnknownType</c> is a deliberate later tightening.</para>
/// </summary>
public abstract class KoineType
{
    /// <summary>The resolved classification of this type.</summary>
    public abstract TypeKind Kind { get; }

    /// <summary>Whether the type is optional/nullable (a <c>T?</c>).</summary>
    public abstract bool IsOptional { get; }

    /// <summary>The simple type name for primitives and named types; <c>null</c> for collections/error.</summary>
    public virtual string? Name => null;

    /// <summary>The (first) element type of a collection (a <c>List&lt;T&gt;</c> element or a <c>Map</c> key).</summary>
    public virtual KoineType? Element => null;

    /// <summary>The value type of a <c>Map&lt;K,V&gt;</c>.</summary>
    public virtual KoineType? Value => null;

    /// <summary>The context qualifier on a named reference (e.g. <c>Billing.Money</c>), for member resolution.</summary>
    public virtual string? Qualifier => null;

    /// <summary>True for the <see cref="ErrorType"/> sentinel (an undeterminable type).</summary>
    public bool IsError => this is ErrorType;

    /// <summary>True for the numeric primitives (<c>Int</c>/<c>Decimal</c>).</summary>
    public bool IsNumeric => Kind == TypeKind.Primitive && Name is "Int" or "Decimal";

    /// <summary>True when this is a value object or a generated ID value object (value-equality scalar).</summary>
    public bool IsValueLike => Kind is TypeKind.Value or TypeKind.IdValueObject;

    /// <summary>True when this is a user-declared value object or entity.</summary>
    public bool IsUserType => Kind is TypeKind.Value or TypeKind.Entity;

    /// <summary>The element type of a <c>List&lt;T&gt;</c>/<c>Set&lt;T&gt;</c> receiver, else <c>null</c>
    /// (mirrors <see cref="TypeResolver.ElementOf"/>: a <c>Map</c>/<c>Range</c> is not a sequence).</summary>
    public KoineType? SequenceElement => Kind is TypeKind.List or TypeKind.Set ? Element : null;

    /// <summary>Returns the same type with its optionality set to <paramref name="optional"/>.</summary>
    public abstract KoineType WithOptional(bool optional);

    /// <summary>
    /// Converts back to a syntactic <see cref="TypeRef"/> (for consumers not yet migrated, and for the
    /// <see cref="TypeResolver.Infer"/> shim). <see cref="ErrorType"/> maps to <c>null</c> — the previous
    /// "unknown" contract.
    /// </summary>
    public TypeRef? ToTypeRef() => this switch
    {
        PrimitiveType p => new TypeRef(p.Name!, IsOptional: p.IsOptional),
        NamedType n => new TypeRef(n.Name!, IsOptional: n.IsOptional, Qualifier: n.Qualifier),
        CollectionType c => new TypeRef(
            CollectionName(c.Kind), c.Element?.ToTypeRef(), c.Value?.ToTypeRef(), c.IsOptional),
        _ => null
    };

    /// <summary>
    /// Classifies a syntactic <see cref="TypeRef"/> into a resolved <see cref="KoineType"/> using
    /// <paramref name="index"/>. A <c>null</c> reference, or one whose name does not resolve, becomes
    /// <see cref="ErrorType"/> — preserving the previous "unknown" semantics exactly.
    /// </summary>
    public static KoineType From(TypeRef? tr, ModelIndex index)
    {
        if (tr is null)
        {
            return ErrorType.Instance;
        }

        TypeKind kind = index.Classify(tr.Name);
        switch (kind)
        {
            case TypeKind.Primitive:
                return new PrimitiveType(tr.Name, tr.IsOptional);
            case TypeKind.List or TypeKind.Set or TypeKind.Map or TypeKind.Range:
                KoineType element = tr.Element is null ? ErrorType.Instance : From(tr.Element, index);
                KoineType? value = tr.Value is null ? null : From(tr.Value, index);
                return new CollectionType(kind, element, value, tr.IsOptional);
            default:
                // An unknown name stays a (Unknown-kind) named type, NOT ErrorType: it round-trips
                // back to its TypeRef so the Infer shim is byte-identical for invalid models. Only a
                // genuinely undeterminable type (a null reference) is ErrorType.
                return new NamedType(tr.Name, kind, tr.IsOptional, tr.Qualifier);
        }
    }

    /// <summary>The Koine surface name of a collection kind.</summary>
    internal static string CollectionName(TypeKind kind) => kind switch
    {
        TypeKind.List => ModelIndex.ListTypeName,
        TypeKind.Set => ModelIndex.SetTypeName,
        TypeKind.Map => ModelIndex.MapTypeName,
        TypeKind.Range => ModelIndex.RangeTypeName,
        _ => "?"
    };
}

/// <summary>A primitive type: <c>Int</c>, <c>Decimal</c>, <c>String</c>, <c>Bool</c>, <c>Instant</c>.</summary>
public sealed class PrimitiveType : KoineType
{
    private readonly string _name;
    private readonly bool _optional;

    public PrimitiveType(string name, bool optional = false)
    {
        _name = name;
        _optional = optional;
    }

    public override TypeKind Kind => TypeKind.Primitive;
    public override bool IsOptional => _optional;
    public override string Name => _name;
    public override KoineType WithOptional(bool optional) => new PrimitiveType(_name, optional);
}

/// <summary>A reference to a declared type (value object, entity, enum, event, ID value object, …).</summary>
public sealed class NamedType : KoineType
{
    private readonly TypeKind _kind;
    private readonly bool _optional;
    private readonly string? _qualifier;

    public NamedType(string name, TypeKind kind, bool optional = false, string? qualifier = null)
    {
        Name = name;
        _kind = kind;
        _optional = optional;
        _qualifier = qualifier;
    }

    public override TypeKind Kind => _kind;
    public override bool IsOptional => _optional;
    public override string? Name { get; }
    public override string? Qualifier => _qualifier;
    public override KoineType WithOptional(bool optional) => new NamedType(Name!, _kind, optional, _qualifier);
}

/// <summary>A collection type: <c>List&lt;T&gt;</c>, <c>Set&lt;T&gt;</c>, <c>Map&lt;K,V&gt;</c>, <c>Range&lt;T&gt;</c>.</summary>
public sealed class CollectionType : KoineType
{
    private readonly TypeKind _kind;
    private readonly bool _optional;

    public CollectionType(TypeKind kind, KoineType element, KoineType? value = null, bool optional = false)
    {
        _kind = kind;
        Element = element;
        Value = value;
        _optional = optional;
    }

    public override TypeKind Kind => _kind;
    public override bool IsOptional => _optional;
    public override KoineType? Element { get; }
    public override KoineType? Value { get; }
    public override KoineType WithOptional(bool optional) => new CollectionType(_kind, Element!, Value, optional);
}

/// <summary>The undeterminable-type sentinel (replaces the previous <c>TypeRef?</c>-<c>null</c>).</summary>
public sealed class ErrorType : KoineType
{
    public static readonly ErrorType Instance = new();

    private ErrorType() { }

    public override TypeKind Kind => TypeKind.Unknown;
    public override bool IsOptional => false;
    public override KoineType WithOptional(bool optional) => this;
}
