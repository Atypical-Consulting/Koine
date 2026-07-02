using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.TypeScript;

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

    /// <summary>The TypeScript type name for a member's declared type.</summary>
    public string Map(TypeRef type)
    {
        var baseType = MapBase(type);
        // An optional field is a union with `undefined` (the TS analogue of C#'s `T?`).
        return type.IsOptional ? baseType + " | undefined" : baseType;
    }

    private string MapBase(TypeRef type)
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
                return $"readonly {MapArg(type.Element)}[]";
            case ModelIndex.SetTypeName:
                return $"ReadonlySet<{MapArg(type.Element)}>";
            case ModelIndex.MapTypeName:
                return $"ReadonlyMap<{MapArg(type.Element)}, {MapArg(type.Value)}>";
            case ModelIndex.RangeTypeName:
                return $"Range<{MapArg(type.Element)}>";
            default:
                // An enum's *type* is the member-instance interface (`<Enum>Member`); the bare
                // `<Enum>` name is the const value object, not a type.
                if (_index.Classify(type.Name) == TypeKind.Enum)
                {
                    return TypeScriptNaming.ToPascalCase(type.Name) + "Member";
                }

                // value / entity / aggregate / ID types map to their own TS name.
                return TypeScriptNaming.ToPascalCase(type.Name);
        }
    }

    private string MapArg(TypeRef? arg) => arg is not null ? Map(arg) : "unknown";

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Set&lt;T&gt;</c>.</summary>
    public static bool IsSet(TypeRef type) => type.Name == ModelIndex.SetTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;

    /// <summary>True when the type classifies as a smart enum (rendered as a string-literal union).</summary>
    public bool IsEnum(TypeRef type) => _index.Classify(type.Name) == TypeKind.Enum;
}
