using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Maps Koine <see cref="TypeRef"/>s to their Rust type strings.
/// <list type="bullet">
///   <item><c>String</c> → <c>String</c></item>
///   <item><c>Int</c> → <c>i64</c></item>
///   <item><c>Bool</c> → <c>bool</c></item>
///   <item><c>Decimal</c> → <c>Decimal</c> (<c>rust_decimal::Decimal</c>, money-safe)</item>
///   <item><c>Instant</c> → <c>Instant</c> (a <c>std::time::SystemTime</c> alias from the runtime)</item>
///   <item><c>List&lt;T&gt;</c> → <c>Vec&lt;T&gt;</c></item>
///   <item><c>Set&lt;T&gt;</c> → <c>HashSet&lt;T&gt;</c></item>
///   <item><c>Map&lt;K,V&gt;</c> → <c>HashMap&lt;K, V&gt;</c></item>
///   <item><c>Range&lt;T&gt;</c> → <c>Range&lt;T&gt;</c> (the runtime interval type)</item>
///   <item><c>T?</c> → <c>Option&lt;T&gt;</c></item>
///   <item>All other named types (value/entity/aggregate/enum/ID) → their PascalCase name</item>
/// </list>
/// <para>
/// The SHORT names (<c>Decimal</c>, <c>Instant</c>, <c>HashSet</c>, <c>HashMap</c>, <c>Range</c>)
/// require the per-module <c>use</c> header the emitter assembles; <c>Vec</c>/<c>Option</c> are in the
/// Rust prelude and need none.
/// </para>
/// </summary>
internal sealed class RustTypeMapper
{
    private readonly ModelIndex _index;
    private readonly string? _context;
    private readonly RustEmitterOptions _options;

    /// <summary>
    /// Creates a type mapper. When <paramref name="context"/> is supplied the mapper is
    /// <em>context-aware</em>: a declared type owned by a different bounded context is qualified as
    /// <c>crate::&lt;owner_module&gt;::&lt;Type&gt;</c> so a flat multi-context crate's cross-context
    /// references resolve. A null context keeps the legacy single-context behaviour (bare names).
    /// </summary>
    public RustTypeMapper(ModelIndex index, string? context = null, RustEmitterOptions? options = null)
    {
        _index = index;
        _context = context;
        _options = options ?? RustEmitterOptions.Empty;
    }

    /// <summary>The Rust type string for a member's declared type (wrapping optionals in <c>Option</c>).</summary>
    public string Map(TypeRef type)
    {
        var baseType = MapBase(type);
        return type.IsOptional ? $"Option<{baseType}>" : baseType;
    }

    private string MapBase(TypeRef type)
    {
        switch (type.Name)
        {
            case "String":
                return "String";
            case "Int":
                return "i64";
            case "Bool":
                return "bool";
            case "Decimal":
                return "Decimal";
            case "Instant":
                return "Instant";
            case ModelIndex.ListTypeName:
                return $"Vec<{MapArg(type.Element)}>";
            case ModelIndex.SetTypeName:
                return $"HashSet<{MapArg(type.Element)}>";
            case ModelIndex.MapTypeName:
                return $"HashMap<{MapArg(type.Element)}, {MapArg(type.Value)}>";
            case ModelIndex.RangeTypeName:
                return $"Range<{MapArg(type.Element)}>";
            default:
                // value / entity / aggregate / enum / ID / unknown types map to their Rust type name,
                // qualified to their owning context's module when referenced from a different context —
                // honoring any explicit `Context.T` qualifier the reference carries (#1124).
                return QualifyTypeName(type);
        }
    }

    /// <summary>
    /// The Rust type name for a member's declared type, threading the reference's explicit
    /// <see cref="TypeRef.Qualifier"/> (a <c>Context.T</c> the modeller wrote) into owner resolution so a
    /// qualified multi-owner reference qualifies to the named owner rather than the ordinal default (#1124).
    /// </summary>
    public string QualifyTypeName(TypeRef type) => QualifyTypeNameCore(type.Name, type.Qualifier);

    /// <summary>
    /// The Rust type name for a declared Koine type named with no explicit qualifier (event / enum /
    /// read-model call sites). Delegates to <see cref="QualifyTypeNameCore"/> with a <c>null</c> qualifier.
    /// </summary>
    public string QualifyTypeName(string koineName) => QualifyTypeNameCore(koineName, qualifier: null);

    /// <summary>
    /// The Rust type name for a declared Koine type, qualified as
    /// <c>crate::&lt;owner_module&gt;::&lt;Type&gt;</c> when the type is owned by a <em>different</em>
    /// bounded context than the one being emitted (so cross-context references resolve in the flat
    /// per-context module layout). Bare PascalCase otherwise — including in the legacy context-agnostic
    /// mode and for branded ID newtypes, which are re-materialized locally rather than qualified.
    /// </summary>
    private string QualifyTypeNameCore(string koineName, string? qualifier)
    {
        var pascal = RustNaming.ToPascalCase(koineName);
        if (_context is null || !IsQualifiable(koineName) || OwnerContextOf(koineName, qualifier) is not { } owner)
        {
            return pascal;
        }

        var ownerModule = ModuleNameOf(owner);
        return string.Equals(ownerModule, ModuleNameOf(_context), StringComparison.Ordinal)
            ? pascal
            : $"crate::{ownerModule}::{pascal}";
    }

    /// <summary>
    /// The bounded context whose module emits the enum that a reference to <paramref name="koineName"/>
    /// resolves to — the key into the per-<c>(context, enum)</c> variant table. Mirrors
    /// <see cref="QualifyTypeName"/> exactly: a uniquely-owned or shared-kernel type living in a
    /// <em>different</em> module resolves to that owner (the reference qualifies as
    /// <c>crate::&lt;owner&gt;::Type</c>); otherwise the bare name binds to the current module, so the
    /// current context wins — including the same-name-in-multiple-contexts case (#437) where a bare
    /// reference must resolve against the local sibling, not the first-declared one. Null only in the
    /// legacy context-agnostic mode.
    /// </summary>
    public string? ResolveOwnerContext(string koineName)
    {
        if (_context is null)
        {
            return null;
        }

        // Same short-circuit as QualifyTypeName: a non-qualifiable type (e.g. a branded Id, which is
        // re-materialized locally rather than module-qualified) binds to the current module.
        return IsQualifiable(koineName)
            && OwnerContextOf(koineName) is { } owner
            && !string.Equals(ModuleNameOf(owner), ModuleNameOf(_context), StringComparison.Ordinal)
                ? owner
                : _context;
    }

    /// <summary>
    /// The single bounded context whose module emits a type, via the shared, deterministic
    /// <see cref="ModelIndex.ResolveOwner(string, string)"/> policy (issue #1091) — so a <b>multi-owner</b> type
    /// referenced from a third context resolves to a canonical owner (<c>crate::&lt;owner&gt;::T</c>)
    /// rather than degrading to a bare, unresolvable name. Shared-kernel homing, unique-owner
    /// resolution, and the #437 same-module bind are all handled by that one policy. An explicit
    /// <paramref name="qualifier"/> (the reference's <c>Context.T</c>) pins the owner when set (#1124).
    /// Null only in the legacy context-agnostic mode.
    /// </summary>
    private string? OwnerContextOf(string koineName, string? qualifier = null) =>
        _context is { } ctx ? _index.ResolveOwner(koineName, qualifier, ctx).Owner : null;

    /// <summary>
    /// True for the named declared kinds that emit a Rust type into a context module (so a foreign one
    /// is worth qualifying). Branded ID newtypes are excluded: a foreign id is re-materialized locally
    /// by <c>OrderedUnownedIds</c>, never module-qualified.
    /// </summary>
    private bool IsQualifiable(string koineName) => _index.Classify(koineName) is
        TypeKind.Value or TypeKind.Entity or TypeKind.Aggregate or TypeKind.Enum
        or TypeKind.Event or TypeKind.IntegrationEvent or TypeKind.ReadModel or TypeKind.Query;

    /// <summary>The Rust module name a context's types emit into (snake_case, with any configured remap).</summary>
    private string ModuleNameOf(string context) => _options.RemapModule(RustNaming.ToSnakeCase(context));

    /// <summary>Maps a type argument, defaulting to <c>String</c> for a missing/null arg.</summary>
    private string MapArg(TypeRef? arg) => arg is not null ? Map(arg) : "String";

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Set&lt;T&gt;</c>.</summary>
    public static bool IsSet(TypeRef type) => type.Name == ModelIndex.SetTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;

    /// <summary>True when the member's type classifies as a Koine smart enum.</summary>
    public bool IsEnum(TypeRef type) => _index.Classify(type.Name) == TypeKind.Enum;

    /// <summary>
    /// True when a value of this type is <c>Copy</c> in the emitted Rust (so accessors and arguments
    /// can pass it by value): the scalar primitives, <c>Instant</c> (SystemTime), <c>Decimal</c>, and
    /// data-free smart enums. Anything that owns a heap allocation (<c>String</c>, collections) or may
    /// transitively (other value/entity types) is NOT <c>Copy</c>.
    /// </summary>
    public bool IsCopy(TypeRef type)
    {
        // Optionality is irrelevant to this classification: `Option<T>` is `Copy` exactly when `T` is, so
        // the check is on the UNDERLYING type throughout. A bare `self`-field read of a Copy member
        // already produces an owned value via Rust's own Copy semantics, so an accessor for the same
        // field must match — returning `&Option<T>` where a sibling read yields `Option<T>` is a real
        // E0308 (#1373 for the primitives; #1508 for enums, which the old `IsOptional` short-circuit
        // still misclassified because it ran ahead of the enum branch below).
        if (type.Name is "Int" or "Bool" or "Decimal" or "Instant")
        {
            return true;
        }

        // All smart enums emit as unit-variant Rust enums deriving `Copy` (associated data is exposed
        // via accessor methods, never as payload), so every enum value is `Copy`. Everything else
        // (`String`, collections, other value/entity types) classifies `false` here regardless of
        // optionality — no separate optional guard needed.
        return _index.Classify(type.Name) == TypeKind.Enum;
    }
}
