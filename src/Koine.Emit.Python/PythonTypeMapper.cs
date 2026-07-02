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

    /// <summary>The Python type-annotation string for a member's declared type.</summary>
    public string Map(TypeRef type)
    {
        var baseType = MapBase(type);
        // An optional field is a union with `None` (Python PEP 604 `T | None`).
        return type.IsOptional ? baseType + " | None" : baseType;
    }

    private string MapBase(TypeRef type)
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
                return $"tuple[{MapArg(type.Element)}, ...]";
            case ModelIndex.SetTypeName:
                // Immutable set: frozenset[T]  (builtin, no import).
                return $"frozenset[{MapArg(type.Element)}]";
            case ModelIndex.MapTypeName:
                // Read-only mapping: Mapping[K, V]
                // Import: `from collections.abc import Mapping` — emitter's per-file header responsibility.
                return $"Mapping[{MapArg(type.Element)}, {MapArg(type.Value)}]";
            case ModelIndex.RangeTypeName:
                // Koine range: Range[T] from koine_runtime.
                return $"Range[{MapArg(type.Element)}]";
            default:
                // Python uses the enum class directly as a type annotation (unlike TypeScript,
                // which indirects through a <Enum>Member interface). The class IS the type.
                if (_index.Classify(type.Name) == TypeKind.Enum)
                {
                    return PythonNaming.ToPascalCase(type.Name);
                }

                // value / entity / aggregate / ID / unknown types map to their own Python class name.
                return PythonNaming.ToPascalCase(type.Name);
        }
    }

    /// <summary>Maps a type argument, returning <c>object</c> for a missing/null arg.</summary>
    private string MapArg(TypeRef? arg) => arg is not null ? Map(arg) : "object";

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Set&lt;T&gt;</c>.</summary>
    public static bool IsSet(TypeRef type) => type.Name == ModelIndex.SetTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;

    /// <summary>True when the type classifies as a Koine smart enum.</summary>
    public bool IsEnum(TypeRef type) => _index.Classify(type.Name) == TypeKind.Enum;
}
