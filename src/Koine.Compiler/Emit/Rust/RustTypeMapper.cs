using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

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
                // qualified to their owning context's module when referenced from a different context.
                return QualifyTypeName(type.Name);
        }
    }

    /// <summary>
    /// The Rust type name for a declared Koine type, qualified as
    /// <c>crate::&lt;owner_module&gt;::&lt;Type&gt;</c> when the type is owned by a <em>different</em>
    /// bounded context than the one being emitted (so cross-context references resolve in the flat
    /// per-context module layout). Bare PascalCase otherwise — including in the legacy context-agnostic
    /// mode and for branded ID newtypes, which are re-materialized locally rather than qualified.
    /// </summary>
    public string QualifyTypeName(string koineName)
    {
        var pascal = RustNaming.ToPascalCase(koineName);
        if (_context is null || !IsQualifiable(koineName) || OwnerContextOf(koineName) is not { } owner)
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

        return OwnerContextOf(koineName) is { } owner
            && !string.Equals(ModuleNameOf(owner), ModuleNameOf(_context), StringComparison.Ordinal)
                ? owner
                : _context;
    }

    /// <summary>The single bounded context whose module emits a type, or null when unknown/ambiguous.</summary>
    private string? OwnerContextOf(string koineName)
    {
        // A shared-kernel type is physically emitted into one canonical owner's module (e.g. the
        // pizzeria's `Currency`, jointly owned by Menu and Ordering, lands in Menu's module).
        if (_index.IsSharedKernelType(koineName) && _index.KernelOwnerOfType(koineName) is { } kernelOwner)
        {
            return kernelOwner;
        }

        IReadOnlyList<string> declaring = _index.DeclaringContextsOf(koineName);
        return declaring.Count == 1 ? declaring[0] : null;
    }

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
        if (type.IsOptional)
        {
            return false;
        }

        return type.Name switch
        {
            // All smart enums emit as unit-variant Rust enums deriving `Copy` (associated data is
            // exposed via accessor methods, never as payload), so every enum value is `Copy`.
            "Int" or "Bool" or "Decimal" or "Instant" => true,
            _ => _index.Classify(type.Name) == TypeKind.Enum,
        };
    }
}
