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
    private readonly string? _context;
    private readonly Func<string, string>? _packageFor;

    /// <summary>
    /// Creates a type mapper over <paramref name="index"/> (used to classify named references). When
    /// <paramref name="context"/> and <paramref name="packageFor"/> are supplied the mapper is
    /// <em>context-aware</em>: a declared type owned by a <em>different</em> bounded context is emitted
    /// <b>package-qualified</b> (<c>&lt;ownerPackage&gt;.&lt;Type&gt;</c>) so a flat multi-context source
    /// tree's cross-context references resolve — exactly like the Rust backend qualifies a foreign type as
    /// <c>crate::&lt;module&gt;::Type</c>. A null <paramref name="context"/> keeps the legacy
    /// single-context behaviour (bare names). <paramref name="packageFor"/> is the emitter's own
    /// <c>PackageFor</c> so the qualification matches the owner's emitted package byte-for-byte.
    /// </summary>
    public JavaTypeMapper(ModelIndex index, string? context = null, Func<string, string>? packageFor = null)
    {
        _index = index;
        _context = context;
        _packageFor = packageFor;
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
        // value / entity / aggregate / enum / generated-ID / unknown types map to their Java type name,
        // package-qualified when owned by a different context than the one being emitted — honoring any
        // explicit `Context.T` qualifier the reference carries (#1124).
        _ => QualifyTypeName(type),
    };

    /// <summary>
    /// The Java type name for a member's declared type, threading the reference's explicit
    /// <see cref="TypeRef.Qualifier"/> (a <c>Context.T</c> the modeller wrote) into owner resolution so a
    /// qualified multi-owner reference qualifies to the named owner rather than the ordinal default (#1124).
    /// </summary>
    public string QualifyTypeName(TypeRef type) => QualifyTypeNameCore(type.Name, type.Qualifier);

    /// <summary>
    /// The Java type name for a declared Koine type named with no explicit qualifier. Delegates to
    /// <see cref="QualifyTypeNameCore"/> with a <c>null</c> qualifier.
    /// </summary>
    public string QualifyTypeName(string koineName) => QualifyTypeNameCore(koineName, qualifier: null);

    /// <summary>
    /// The Java type name for a declared Koine type, package-qualified as
    /// <c>&lt;ownerPackage&gt;.&lt;Type&gt;</c> when the type is owned by a <em>different</em> bounded
    /// context than the one being emitted (so cross-context references resolve in the flat per-context
    /// package layout). Bare PascalCase otherwise — in the legacy context-agnostic mode, for a same-context
    /// (local) type, and for branded ID types, which are re-materialized locally by the emitter's unowned-id
    /// pass rather than qualified.
    /// </summary>
    private string QualifyTypeNameCore(string koineName, string? qualifier)
    {
        var pascal = JavaNaming.Type(koineName);
        if (_context is null || _packageFor is null || !IsQualifiable(koineName)
            || OwnerContextOf(koineName, qualifier) is not { } owner)
        {
            return pascal;
        }

        var ownerPackage = _packageFor(owner);
        return string.Equals(ownerPackage, _packageFor(_context), StringComparison.Ordinal)
            ? pascal
            : ownerPackage + "." + pascal;
    }

    /// <summary>
    /// The single bounded context whose package emits a type, via the shared, deterministic
    /// <see cref="ModelIndex.ResolveOwner(string, string)"/> policy (issue #1091) — so a <b>multi-owner</b> type
    /// referenced from a third context resolves to a canonical owner (<c>&lt;ownerPackage&gt;.T</c>)
    /// rather than degrading to a bare, unresolvable name. Shared-kernel homing, unique-owner
    /// resolution, and the #437 same-package bind are all handled by that one policy. An explicit
    /// <paramref name="qualifier"/> (the reference's <c>Context.T</c>) pins the owner when set (#1124).
    /// Null only in the legacy context-agnostic mode.
    /// </summary>
    private string? OwnerContextOf(string koineName, string? qualifier = null) =>
        _context is { } ctx ? _index.ResolveOwner(koineName, qualifier, ctx).Owner : null;

    /// <summary>
    /// True for the named declared kinds that emit a Java type into a context package (so a foreign one is
    /// worth qualifying). Branded ID types are excluded: a foreign id is re-materialized locally by the
    /// emitter's unowned-id pass, never package-qualified.
    /// </summary>
    private bool IsQualifiable(string koineName) => _index.Classify(koineName) is
        TypeKind.Value or TypeKind.Entity or TypeKind.Aggregate or TypeKind.Enum
        or TypeKind.Event or TypeKind.IntegrationEvent or TypeKind.ReadModel or TypeKind.Query;

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
