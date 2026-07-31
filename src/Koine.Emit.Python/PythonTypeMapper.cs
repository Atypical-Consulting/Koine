using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Maps Koine <see cref="TypeRef"/>s to their Python type-annotation strings per the type
/// table agreed in the Python-emitter design.
/// <list type="bullet">
///   <item><c>String</c> → <c>str</c></item>
///   <item><c>Int</c> → <c>int</c></item>
///   <item><c>Bool</c> → <c>bool</c></item>
///   <item><c>Decimal</c> → <c>Decimal</c> (from <c>decimal</c> stdlib)</item>
///   <item><c>Instant</c> → <c>datetime</c> (from <c>datetime</c> stdlib)</item>
///   <item><c>List&lt;T&gt;</c> → <c>tuple[T, ...]</c> (immutable, homogeneous)</item>
///   <item><c>Set&lt;T&gt;</c> → <c>frozenset[T]</c></item>
///   <item><c>Map&lt;K,V&gt;</c> → <c>Mapping[K, V]</c> (from <c>collections.abc</c>)</item>
///   <item><c>Range&lt;T&gt;</c> → <c>Range[T]</c> (from <c>koine_runtime</c>)</item>
///   <item><c>T?</c> → <c>T | None</c> (PEP 604, Python 3.10+)</item>
///   <item>Enum types → their PascalCase class name (Python <c>enum.Enum</c> subclass itself, no "Member" indirection)</item>
///   <item>All other named types → PascalCase name</item>
/// </list>
/// <para>
/// <b>Import responsibility (Task 5+):</b> The SHORT names used here require these per-file
/// header imports from the emitter:
/// <c>from decimal import Decimal</c>, <c>from datetime import datetime</c>,
/// <c>from collections.abc import Mapping</c>. <c>tuple</c> and <c>frozenset</c> are Python
/// builtins — no import needed. <c>Range</c> comes from <c>koine_runtime</c>.
/// </para>
/// </summary>
internal sealed class PythonTypeMapper
{
    private readonly ModelIndex _index;

    public PythonTypeMapper(ModelIndex index) => _index = index;

    /// <summary>
    /// The Python type-annotation string for a member's declared type. <paramref name="context"/> is
    /// the bounded context the reference is DECLARED in (e.g. the owning value object/entity's own
    /// context) — this mapper is built once per compile and reused across every context, so it
    /// carries no ambient context of its own; the caller supplies whichever context it already has
    /// in scope. Falls back to <see cref="TypeRef.Qualifier"/> alone (today's behavior) when a call
    /// site genuinely has no context to give (pass <c>null</c> explicitly).
    /// </summary>
    public string Map(TypeRef type, string? context)
    {
        var baseType = MapBase(type, context);
        // An optional field is a union with `None` (Python PEP 604 `T | None`).
        return type.IsOptional ? baseType + " | None" : baseType;
    }

    private string MapBase(TypeRef type, string? context)
    {
        switch (type.Name)
        {
            case "String":
                return "str";
            case "Int":
                return "int";
            case "Bool":
                return "bool";
            case "Decimal":
                // Use decimal.Decimal (stdlib); money-safe, never float.
                // Import: `from decimal import Decimal` — emitter's per-file header responsibility.
                return "Decimal";
            case "Instant":
                // Use datetime.datetime (stdlib).
                // Import: `from datetime import datetime` — emitter's per-file header responsibility.
                return "datetime";
            case ModelIndex.ListTypeName:
                // Immutable homogeneous sequence: tuple[T, ...]  (builtin, no import).
                return $"tuple[{MapArg(type.Element, context)}, ...]";
            case ModelIndex.SetTypeName:
                // Immutable set: frozenset[T]  (builtin, no import).
                return $"frozenset[{MapArg(type.Element, context)}]";
            case ModelIndex.MapTypeName:
                // Read-only mapping: Mapping[K, V]
                // Import: `from collections.abc import Mapping` — emitter's per-file header responsibility.
                return $"Mapping[{MapArg(type.Element, context)}, {MapArg(type.Value, context)}]";
            case ModelIndex.RangeTypeName:
                // Koine range: Range[T] from koine_runtime.
                return $"Range[{MapArg(type.Element, context)}]";
            default:
                // Python uses the enum class directly as a type annotation (unlike TypeScript,
                // which indirects through a <Enum>Member interface). The class IS the type. A
                // qualified reference (`type.Qualifier`) always wins; otherwise fall back to the
                // caller's own context — closing the gap for a BARE reference to the declaring
                // context's own same-named type (issue #1638). Note the enum/non-enum branches here
                // happen to return the identical PascalCase name either way (unlike TS's `<Enum>Member`
                // indirection), so this particular call site's classification never surfaces a visibly
                // different `Map` result today — see `IsEnum` below for the call site where a
                // misclassification IS observable.
                if (_index.Classify(type.Qualifier ?? context, type.Name) == TypeKind.Enum)
                {
                    return PythonNaming.ToPascalCase(type.Name);
                }

                // value / entity / aggregate / ID / unknown types map to their own Python class name.
                return PythonNaming.ToPascalCase(type.Name);
        }
    }

    /// <summary>Maps a type argument, returning <c>object</c> for a missing/null arg.</summary>
    private string MapArg(TypeRef? arg, string? context) => arg is not null ? Map(arg, context) : "object";

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Set&lt;T&gt;</c>.</summary>
    public static bool IsSet(TypeRef type) => type.Name == ModelIndex.SetTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;

    /// <summary>
    /// True when the type classifies as a Koine smart enum. <paramref name="context"/> is the
    /// bounded context the reference is declared in — see <see cref="Map"/> for why the mapper needs
    /// it passed per call instead of holding it itself.
    /// </summary>
    public bool IsEnum(TypeRef type, string? context) => _index.Classify(type.Qualifier ?? context, type.Name) == TypeKind.Enum;
}
