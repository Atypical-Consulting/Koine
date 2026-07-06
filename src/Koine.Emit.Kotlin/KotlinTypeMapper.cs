using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Maps Koine <see cref="TypeRef"/>s to their Kotlin 2.x/JVM type strings (Kotlin stdlib + JDK types only —
/// no third-party dependency).
/// <list type="bullet">
///   <item><c>String</c> → <c>String</c></item>
///   <item><c>Int</c> → <c>Long</c> (64-bit, matching the JVM sibling's <c>long</c>)</item>
///   <item><c>Bool</c> → <c>Boolean</c></item>
///   <item><c>Decimal</c> → <c>java.math.BigDecimal</c> (money-safe)</item>
///   <item><c>Instant</c> → <c>java.time.Instant</c></item>
///   <item><c>List&lt;T&gt;</c> → read-only <c>List&lt;T&gt;</c> (<c>kotlin.collections.List</c>)</item>
///   <item><c>Set&lt;T&gt;</c> → read-only <c>Set&lt;T&gt;</c></item>
///   <item><c>Map&lt;K,V&gt;</c> → read-only <c>Map&lt;K, V&gt;</c></item>
///   <item><c>Range&lt;T&gt;</c> → <c>koine.runtime.Range&lt;T&gt;</c> (the shared runtime interval type)</item>
///   <item><c>T?</c> → Kotlin nullable <c>T?</c> — never <c>Optional</c></item>
///   <item>All other named types (value/entity/aggregate/enum/generated-ID) → their PascalCase name</item>
/// </list>
/// <para>
/// JDK types are emitted <b>fully qualified</b> (<c>java.math.BigDecimal</c>, <c>java.time.Instant</c>, …)
/// so the emitter needs no <c>import</c> bookkeeping and the output always compiles; the Kotlin
/// collection types (<c>List</c>/<c>Set</c>/<c>Map</c>) live in the auto-imported <c>kotlin.collections</c>
/// package, so they stay bare. Unlike the Java mapper there is no boxing distinction — Kotlin generics
/// hold the reference form automatically, so a bare <c>Int</c> and a <c>List&lt;Int&gt;</c> element both
/// render as <c>Long</c>. Optionality is expressed in the type system as <c>T?</c>, preserving the
/// model's optional-vs-required distinction that consuming Java platform types would erase.
/// </para>
/// </summary>
internal sealed class KotlinTypeMapper
{
    private readonly ModelIndex _index;
    private readonly string? _context;
    private readonly Func<string, string>? _packageFor;

    /// <summary>
    /// Creates a type mapper over <paramref name="index"/> (used to classify named references). When
    /// <paramref name="context"/> and <paramref name="packageFor"/> are supplied the mapper is
    /// <em>context-aware</em>: a declared type owned by a <em>different</em> bounded context is emitted
    /// <b>package-qualified</b> (<c>&lt;ownerPackage&gt;.&lt;Type&gt;</c>) so a flat multi-context source
    /// tree's cross-context references resolve — exactly like the Java backend does, and the Rust
    /// backend's <c>crate::&lt;module&gt;::Type</c>. A null <paramref name="context"/> keeps the legacy
    /// single-context behaviour (bare names). <paramref name="packageFor"/> is the emitter's own
    /// <c>PackageFor</c> so the qualification matches the owner's emitted package byte-for-byte.
    /// </summary>
    public KotlinTypeMapper(ModelIndex index, string? context = null, Func<string, string>? packageFor = null)
    {
        _index = index;
        _context = context;
        _packageFor = packageFor;
    }

    /// <summary>
    /// The Kotlin type string for a member's declared type. A nullable field appends <c>?</c> (Kotlin's
    /// type-system optionality); a non-nullable field uses the value form.
    /// </summary>
    public string Map(TypeRef type)
    {
        var baseType = MapBase(type);
        return type.IsOptional ? baseType + "?" : baseType;
    }

    /// <summary>The Kotlin rendering of a type ignoring its optionality.</summary>
    private string MapBase(TypeRef type) => type.Name switch
    {
        "String" => "String",
        "Int" => "Long",
        "Bool" => "Boolean",
        "Decimal" => "java.math.BigDecimal",
        "Instant" => "java.time.Instant",
        ModelIndex.ListTypeName => $"List<{MapArg(type.Element)}>",
        ModelIndex.SetTypeName => $"Set<{MapArg(type.Element)}>",
        ModelIndex.MapTypeName => $"Map<{MapArg(type.Element)}, {MapArg(type.Value)}>",
        ModelIndex.RangeTypeName => $"koine.runtime.Range<{MapArg(type.Element)}>",
        // value / entity / aggregate / enum / generated-ID / unknown types map to their Kotlin type name,
        // package-qualified when owned by a different context than the one being emitted.
        _ => QualifyTypeName(type.Name),
    };

    /// <summary>
    /// The Kotlin type name for a declared Koine type, package-qualified as
    /// <c>&lt;ownerPackage&gt;.&lt;Type&gt;</c> when the type is owned by a <em>different</em> bounded
    /// context than the one being emitted (so cross-context references resolve in the flat per-context
    /// package layout). Bare PascalCase otherwise — in the legacy context-agnostic mode, for a same-context
    /// (local) type, and for branded ID types, which are re-materialized locally by the emitter's unowned-id
    /// pass rather than qualified.
    /// </summary>
    public string QualifyTypeName(string koineName)
    {
        var pascal = KotlinNaming.ToTypeName(koineName);
        if (_context is null || _packageFor is null || !IsQualifiable(koineName)
            || OwnerContextOf(koineName) is not { } owner)
        {
            return pascal;
        }

        var ownerPackage = _packageFor(owner);
        return string.Equals(ownerPackage, _packageFor(_context), StringComparison.Ordinal)
            ? pascal
            : ownerPackage + "." + pascal;
    }

    /// <summary>The single bounded context whose package emits a type, or null when unknown/ambiguous.</summary>
    private string? OwnerContextOf(string koineName)
    {
        // A shared-kernel type is physically emitted into one canonical owner's package (e.g. the
        // pizzeria's `Currency`, jointly owned by Menu and Ordering, lands in Menu's package).
        if (_index.IsSharedKernelType(koineName) && _index.KernelOwnerOfType(koineName) is { } kernelOwner)
        {
            return kernelOwner;
        }

        IReadOnlyList<string> declaring = _index.DeclaringContextsOf(koineName);
        return declaring.Count == 1 ? declaring[0] : null;
    }

    /// <summary>
    /// True for the named declared kinds that emit a Kotlin type into a context package (so a foreign one is
    /// worth qualifying). Branded ID types are excluded: a foreign id is re-materialized locally by the
    /// emitter's unowned-id pass, never package-qualified.
    /// </summary>
    private bool IsQualifiable(string koineName) => _index.Classify(koineName) is
        TypeKind.Value or TypeKind.Entity or TypeKind.Aggregate or TypeKind.Enum
        or TypeKind.Event or TypeKind.IntegrationEvent or TypeKind.ReadModel or TypeKind.Query;

    /// <summary>
    /// Maps a type argument (a generic element / value). Defaults to <c>String</c> for a missing/null arg
    /// (mirrors the other backends' fallback). An optional argument keeps its <c>?</c> so a
    /// <c>List&lt;T?&gt;</c> reads through.
    /// </summary>
    private string MapArg(TypeRef? type) => type is not null ? Map(type) : "String";

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
