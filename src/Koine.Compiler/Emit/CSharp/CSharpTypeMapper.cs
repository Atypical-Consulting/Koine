using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.CSharp;

/// <summary>
/// Maps Koine <see cref="TypeRef"/>s to their C# type names. All primitive and
/// collection mapping decisions live here.
/// </summary>
internal sealed class CSharpTypeMapper
{
    private readonly ModelIndex _index;

    public CSharpTypeMapper(ModelIndex index) => _index = index;

    /// <summary>
    /// Returns the C# type name for a member's declared type. When the mapping
    /// requires a comment (e.g. Instant -> DateTimeOffset), it is returned via
    /// <paramref name="trailingComment"/> (without the leading <c>//</c>).
    /// </summary>
    public string Map(TypeRef type, out string? trailingComment)
    {
        trailingComment = null;
        return MapInternal(type, ref trailingComment);
    }

    public string Map(TypeRef type)
    {
        string? _ = null;
        return MapInternal(type, ref _);
    }

    private string MapInternal(TypeRef type, ref string? trailingComment)
    {
        var baseType = MapBase(type, ref trailingComment);
        // An optional field maps to the nullable form (value types and, under
        // nullable reference types, reference types).
        return type.IsOptional ? baseType + "?" : baseType;
    }

    private string MapBase(TypeRef type, ref string? trailingComment)
    {
        switch (type.Name)
        {
            case "String": return "string";
            case "Int": return "int";
            case "Decimal": return "decimal";
            case "Bool": return "bool";
            case "Instant":
                trailingComment = "TODO: NodaTime";
                return "DateTimeOffset";
            case ModelIndex.ListTypeName:
                return $"IReadOnlyList<{MapArg(type.Element, ref trailingComment)}>";
            case ModelIndex.SetTypeName:
                return $"IReadOnlySet<{MapArg(type.Element, ref trailingComment)}>";
            case ModelIndex.MapTypeName:
                return $"IReadOnlyDictionary<{MapArg(type.Element, ref trailingComment)}, {MapArg(type.Value, ref trailingComment)}>";
            case ModelIndex.RangeTypeName:
                return $"Range<{MapArg(type.Element, ref trailingComment)}>";
            default:
                // A qualified cross-context reference (R13.2) emits fully-qualified so it
                // needs no `using` and never collides with a same-named local/imported type.
                if (type.Qualifier is { } qualifier)
                {
                    var ns = _index.NamespaceOfTypeIn(qualifier, type.Name) ?? qualifier;
                    return ns + "." + type.Name;
                }
                // enum / value / entity / aggregate / ID types map to their own C# name.
                return type.Name;
        }
    }

    private string MapArg(TypeRef? arg, ref string? trailingComment) =>
        arg is not null ? MapInternal(arg, ref trailingComment) : "object";

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Set&lt;T&gt;</c>.</summary>
    public static bool IsSet(TypeRef type) => type.Name == ModelIndex.SetTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;
}
