using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// Maps Koine <see cref="TypeRef"/>s to their PHP type-hint strings per the type
/// table agreed in the PHP-emitter design.
/// <list type="bullet">
///   <item><c>String</c> → <c>string</c></item>
///   <item><c>Int</c> → <c>int</c></item>
///   <item><c>Bool</c> → <c>bool</c></item>
///   <item><c>Decimal</c> → <c>\Koine\Runtime\Decimal</c> (runtime type)</item>
///   <item><c>Instant</c> / DateTime → <c>\DateTimeImmutable</c></item>
///   <item><c>Uuid</c> / <c>Guid</c> → <c>string</c></item>
///   <item><c>List&lt;T&gt;</c> / <c>Set&lt;T&gt;</c> / <c>Map&lt;K,V&gt;</c> → <c>array</c></item>
///   <item><c>T?</c> → <c>?T</c> (PHP nullable prefix)</item>
///   <item>Enum types → the PascalCase class name</item>
///   <item>All other named types → PascalCase name</item>
/// </list>
/// </summary>
internal sealed class PhpTypeMapper
{
    private readonly ModelIndex _index;

    public PhpTypeMapper(ModelIndex index) => _index = index;

    /// <summary>The PHP type-hint string for a member's declared type.</summary>
    public string Map(TypeRef type)
    {
        var baseType = MapBase(type);
        // PHP nullable: prefix with `?`
        return type.IsOptional ? "?" + baseType : baseType;
    }

    private string MapBase(TypeRef type)
    {
        switch (type.Name)
        {
            case "String":
                return "string";
            case "Int":
                return "int";
            case "Bool":
                return "bool";
            case "Decimal":
                // Use the Koine runtime Decimal class (money-safe, never float).
                return @"\Koine\Runtime\Decimal";
            case "Instant":
                // PHP immutable date-time value.
                return @"\DateTimeImmutable";
            case "Uuid":
            case "Guid":
                // PHP represents UUIDs as strings.
                return "string";
            case ModelIndex.ListTypeName:
            case ModelIndex.SetTypeName:
            case ModelIndex.MapTypeName:
                // PHP uses `array` for all collection types; generics are not a runtime concept.
                return "array";
            default:
                // Model-declared enum → the PascalCase class name (PHP backed enum).
                if (_index.Classify(type.Name) == TypeKind.Enum)
                {
                    return PhpNaming.ClassName(type.Name);
                }

                // Value objects, entities, aggregates, unknown types → PascalCase class name.
                return PhpNaming.ClassName(type.Name);
        }
    }

    /// <summary>
    /// The phpstan PHPDoc value-type for a (possibly generic) collection or generic type — so a
    /// <c>@param</c>/<c>@var</c>/<c>@return</c> can refine the bare <c>array</c>/<c>Range</c> native hint
    /// that <c>phpstan --level max</c> rejects as untyped:
    /// <list type="bullet">
    ///   <item><c>List&lt;T&gt;</c> / <c>Set&lt;T&gt;</c> → <c>list&lt;T&gt;</c></item>
    ///   <item><c>Map&lt;K,V&gt;</c> → <c>array&lt;K, V&gt;</c></item>
    ///   <item><c>Range&lt;T&gt;</c> → <c>Range&lt;T&gt;</c> (the native hint stays <c>Range</c>)</item>
    /// </list>
    /// Returns <c>null</c> for a type whose native hint (<see cref="Map"/>) already fully specifies it
    /// (scalars, value objects, entities, enums). The element/value types reuse <see cref="Map"/>, so a
    /// class element renders as its short name (imported via the file's body scan) while
    /// <c>Instant</c>/<c>Decimal</c> stay fully-qualified. A nullable collection adds <c>|null</c>.
    /// </summary>
    public string? DocType(TypeRef type)
    {
        string? inner = type.Name switch
        {
            ModelIndex.ListTypeName or ModelIndex.SetTypeName when type.Element is not null
                => $"list<{Map(type.Element)}>",
            // `Map<K, V>` → `array<K, V>`. A non-scalar key (a value object / entity) renders e.g.
            // `array<Sku, int>`; phpstan --level max accepts this (it does not enforce the
            // int|string array-key constraint inside a generic PHPDoc — empirically [OK] on
            // PHPStan 2.x), so no key-type guard is needed for level-max parity (#583).
            ModelIndex.MapTypeName when type.Element is not null && type.Value is not null
                => $"array<{Map(type.Element)}, {Map(type.Value)}>",
            ModelIndex.RangeTypeName when type.Element is not null
                => $"Range<{Map(type.Element)}>",
            _ => null,
        };

        if (inner is null)
        {
            return null;
        }

        return type.IsOptional ? inner + "|null" : inner;
    }

    /// <summary>True when the member's type is a Koine <c>List&lt;T&gt;</c>.</summary>
    public static bool IsList(TypeRef type) => type.Name == ModelIndex.ListTypeName;

    /// <summary>True when the member's type is a Koine <c>Map&lt;K,V&gt;</c>.</summary>
    public static bool IsMap(TypeRef type) => type.Name == ModelIndex.MapTypeName;

    /// <summary>True when the type classifies as a Koine smart enum.</summary>
    public bool IsEnum(TypeRef type) => _index.Classify(type.Name) == TypeKind.Enum;
}
