using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Maps Koine <see cref="TypeRef"/>s to their Java 17 type strings (stdlib only — no third-party
/// dependency).
/// <list type="bullet">
///   <item><c>String</c> → <c>String</c></item>
///   <item><c>Int</c> → <c>long</c> (boxed to <c>Long</c> inside a generic / <c>Optional</c>)</item>
///   <item><c>Bool</c> → <c>boolean</c> (boxed to <c>Boolean</c> inside a generic / <c>Optional</c>)</item>
///   <item><c>Decimal</c> → <c>java.math.BigDecimal</c> (money-safe)</item>
///   <item><c>Instant</c> → <c>java.time.Instant</c></item>
///   <item><c>List&lt;T&gt;</c> → <c>java.util.List&lt;T&gt;</c></item>
///   <item><c>Set&lt;T&gt;</c> → <c>java.util.Set&lt;T&gt;</c></item>
///   <item><c>Map&lt;K,V&gt;</c> → <c>java.util.Map&lt;K, V&gt;</c></item>
///   <item><c>Range&lt;T&gt;</c> → <c>koine.runtime.Range&lt;T&gt;</c> (the shared runtime interval type)</item>
///   <item><c>T?</c> → <c>java.util.Optional&lt;T&gt;</c> (with <c>T</c> boxed if primitive)</item>
///   <item>All other named types (value/entity/aggregate/enum/generated-ID) → their PascalCase name</item>
/// </list>
/// <para>
/// Stdlib types are emitted <b>fully qualified</b> (<c>java.math.BigDecimal</c>, <c>java.util.List</c>, …)
/// so the emitter needs no import bookkeeping and the output always compiles. A generated ID maps to its
/// own wrapper type name (the <c>record</c> the ID task emits over a <c>java.util.UUID</c>/<c>String</c>),
/// exactly like every other named type. Java generics cannot hold a primitive, so any <c>Int</c>/<c>Bool</c>
/// in a type-argument or <c>Optional</c> position is boxed to <c>Long</c>/<c>Boolean</c>.
/// </para>
/// </summary>
internal sealed class JavaTypeMapper
{
    private readonly ModelIndex _index;

    /// <summary>Creates a type mapper over <paramref name="index"/> (used to classify named references).</summary>
    public JavaTypeMapper(ModelIndex index)
    {
        _index = index;
    }

    /// <summary>
    /// The Java type string for a member's declared type. A nullable field wraps in
    /// <c>java.util.Optional&lt;T&gt;</c> (boxing a primitive <c>T</c>); a non-nullable field uses the
    /// value form, so a bare <c>Int</c> stays the unboxed <c>long</c>.
    /// </summary>
    public string Map(TypeRef type) =>
        type.IsOptional ? $"java.util.Optional<{MapBase(type, boxed: true)}>" : MapBase(type, boxed: false);

    /// <summary>
    /// The Java rendering of a type ignoring its optionality. <paramref name="boxed"/> selects the
    /// reference form of a primitive (<c>Long</c>/<c>Boolean</c> vs <c>long</c>/<c>boolean</c>), required
    /// wherever the type sits in a generic / <c>Optional</c> position.
    /// </summary>
    private string MapBase(TypeRef type, bool boxed) => type.Name switch
    {
        "String" => "String",
        "Int" => boxed ? "Long" : "long",
        "Bool" => boxed ? "Boolean" : "boolean",
        "Decimal" => "java.math.BigDecimal",
        "Instant" => "java.time.Instant",
        ModelIndex.ListTypeName => $"java.util.List<{MapArg(type.Element)}>",
        ModelIndex.SetTypeName => $"java.util.Set<{MapArg(type.Element)}>",
        ModelIndex.MapTypeName => $"java.util.Map<{MapArg(type.Element)}, {MapArg(type.Value)}>",
        ModelIndex.RangeTypeName => $"koine.runtime.Range<{MapArg(type.Element)}>",
        // value / entity / aggregate / enum / generated-ID / unknown types map to their Java type name.
        _ => JavaNaming.Type(type.Name),
    };

    /// <summary>
    /// Maps a type argument (a generic element / value, or an <c>Optional</c> payload): primitives are
    /// boxed and an optional argument is itself wrapped in <c>Optional</c>. Defaults to <c>String</c> for a
    /// missing/null arg (mirrors the other backends' fallback).
    /// </summary>
    private string MapArg(TypeRef? type)
    {
        if (type is null)
        {
            return "String";
        }

        return type.IsOptional
            ? $"java.util.Optional<{MapBase(type, boxed: true)}>"
            : MapBase(type, boxed: true);
    }

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Set&lt;T&gt;</c>.</summary>
    public static bool IsSet(TypeRef type) => type.Name == ModelIndex.SetTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;

    /// <summary>True when the member's type is any Koine collection (<c>List</c>/<c>Set</c>/<c>Map</c>).</summary>
    public static bool IsCollection(TypeRef type) => IsList(type) || IsSet(type) || IsMap(type);

    /// <summary>True when the member's type classifies as a Koine smart enum.</summary>
    public bool IsEnum(TypeRef type) => _index.Classify(type.Name) == TypeKind.Enum;
}
