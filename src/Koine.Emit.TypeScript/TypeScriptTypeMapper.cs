using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Maps Koine <see cref="TypeRef"/>s to their TypeScript type names per the R16.2 type
/// table. Money fidelity is preserved by mapping <c>Decimal</c> to the string-backed
/// runtime <c>Decimal</c> (a raw <c>number</c> would be lossy); <c>Instant</c> maps to the
/// branded ISO-8601 string runtime type. Collections map to their <c>readonly</c> forms so
/// the immutability the C# emitter enforces with <c>IReadOnly*</c> wrappers holds in TS too.
/// </summary>
internal sealed class TypeScriptTypeMapper
{
    private readonly ModelIndex _index;

    public TypeScriptTypeMapper(ModelIndex index) => _index = index;

    /// <summary>
    /// The TypeScript type name for a member's declared type. <paramref name="context"/> is the
    /// bounded context the reference is DECLARED in (e.g. the owning value object/entity's own
    /// context) — this mapper is built once per compile and reused across every context, so it
    /// carries no ambient context of its own; the caller supplies whichever context it already has
    /// in scope. Falls back to <see cref="TypeRef.Qualifier"/> alone (today's behavior) when a call
    /// site genuinely has no context to give (pass <c>null</c> explicitly).
    /// </summary>
    public string Map(TypeRef type, string? context)
    {
        var baseType = MapBase(type, context);
        // An optional field is a union with `undefined` (the TS analogue of C#'s `T?`).
        return type.IsOptional ? baseType + " | undefined" : baseType;
    }

    private string MapBase(TypeRef type, string? context)
    {
        switch (type.Name)
        {
            case "String":
                return "string";
            case "Int":
                return "number";
            case "Bool":
                return "boolean";
            case "Decimal":
                // String-backed runtime type: a JS `number` cannot represent money exactly.
                return "Decimal";
            case "Instant":
                // A branded ISO-8601 string (see TsRuntime); `now` -> Instant.now().
                return "Instant";
            case ModelIndex.ListTypeName:
                return $"readonly {MapArg(type.Element, context)}[]";
            case ModelIndex.SetTypeName:
                return $"ReadonlySet<{MapArg(type.Element, context)}>";
            case ModelIndex.MapTypeName:
                return $"ReadonlyMap<{MapArg(type.Element, context)}, {MapArg(type.Value, context)}>";
            case ModelIndex.RangeTypeName:
                return $"Range<{MapArg(type.Element, context)}>";
            default:
                // An enum's *type* is the member-instance interface (`<Enum>Member`); the bare
                // `<Enum>` name is the const value object, not a type. A qualified reference
                // (`type.Qualifier`) always wins; otherwise fall back to the caller's own context —
                // closing the gap for a BARE reference to the declaring context's own same-named type.
                if (_index.Classify(type.Qualifier ?? context, type.Name) == TypeKind.Enum)
                {
                    return TypeScriptNaming.ToPascalCase(type.Name) + "Member";
                }

                // value / entity / aggregate / ID types map to their own TS name.
                return TypeScriptNaming.ToPascalCase(type.Name);
        }
    }

    private string MapArg(TypeRef? arg, string? context) => arg is not null ? Map(arg, context) : "unknown";

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Set&lt;T&gt;</c>.</summary>
    public static bool IsSet(TypeRef type) => type.Name == ModelIndex.SetTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;

    /// <summary>
    /// True when the type classifies as a smart enum (rendered as a string-literal union).
    /// <paramref name="context"/> is the bounded context the reference is declared in — see
    /// <see cref="Map"/> for why the mapper needs it passed per call instead of holding it itself.
    /// </summary>
    public bool IsEnum(TypeRef type, string? context) => _index.Classify(type.Qualifier ?? context, type.Name) == TypeKind.Enum;
}
