using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="PhpTypeMapper"/> — the pure type-mapping table that converts
/// Koine <see cref="TypeRef"/>s to their PHP type-hint strings.
/// </summary>
public class PhpTypeMapperTests
{
    // Build a ModelIndex from a minimal compiled model that declares an enum so we can test
    // enum classification. For all primitive/collection tests we just need an empty index.
    private static ModelIndex EmptyIndex()
    {
        var result = new KoineCompiler().Compile("context C { value V { x: Int } }", new CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    private static ModelIndex IndexWithEnum()
    {
        var result = new KoineCompiler().Compile(
            "context C { enum Status { Active Inactive } value V { s: Status } }",
            new CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    // =========================================================================
    // Primitive mappings
    // =========================================================================

    [Theory]
    [InlineData("String", "string")]
    [InlineData("Int", "int")]
    [InlineData("Bool", "bool")]
    public void Primitive_types_map_correctly(string koineName, string expected)
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef(koineName), context: null).ShouldBe(expected);
    }

    [Fact]
    public void Decimal_maps_to_runtime_Decimal()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Decimal"), context: null).ShouldBe(@"\Koine\Runtime\Decimal");
    }

    [Fact]
    public void Instant_maps_to_DateTimeImmutable()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Instant"), context: null).ShouldBe(@"\DateTimeImmutable");
    }

    [Fact]
    public void Uuid_maps_to_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Uuid"), context: null).ShouldBe("string");
    }

    [Fact]
    public void Guid_maps_to_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Guid"), context: null).ShouldBe("string");
    }

    // =========================================================================
    // Collection mappings
    // =========================================================================

    [Fact]
    public void List_of_Int_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"));
        mapper.Map(t, context: null).ShouldBe("array");
    }

    [Fact]
    public void Set_of_String_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.SetTypeName, Element: new TypeRef("String"));
        mapper.Map(t, context: null).ShouldBe("array");
    }

    [Fact]
    public void Map_of_String_Int_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.MapTypeName, Element: new TypeRef("String"), Value: new TypeRef("Int"));
        mapper.Map(t, context: null).ShouldBe("array");
    }

    // =========================================================================
    // Optional (?T) mappings
    // =========================================================================

    [Fact]
    public void Optional_Int_maps_to_nullable_int()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("Int", IsOptional: true);
        mapper.Map(t, context: null).ShouldBe("?int");
    }

    [Fact]
    public void Optional_String_maps_to_nullable_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("String", IsOptional: true);
        mapper.Map(t, context: null).ShouldBe("?string");
    }

    [Fact]
    public void Optional_Decimal_maps_to_nullable_runtime_Decimal()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("Decimal", IsOptional: true);
        mapper.Map(t, context: null).ShouldBe(@"?\Koine\Runtime\Decimal");
    }

    [Fact]
    public void Optional_List_of_Int_maps_to_nullable_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"), IsOptional: true);
        mapper.Map(t, context: null).ShouldBe("?array");
    }

    // =========================================================================
    // Enum classification → PascalCase class name
    // =========================================================================

    [Fact]
    public void Enum_type_maps_to_PascalCase_name()
    {
        var mapper = new PhpTypeMapper(IndexWithEnum());
        var t = new TypeRef("Status");
        mapper.Map(t, context: null).ShouldBe("Status");
    }

    // =========================================================================
    // Unknown / value object / entity → PascalCase name
    // =========================================================================

    [Fact]
    public void Unknown_type_maps_to_PascalCase()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("SomeType"), context: null).ShouldBe("SomeType");
    }

    // =========================================================================
    // Static helpers
    // =========================================================================

    [Fact]
    public void IsList_returns_true_for_List()
    {
        PhpTypeMapper.IsList(new TypeRef(ModelIndex.ListTypeName)).ShouldBeTrue();
        PhpTypeMapper.IsList(new TypeRef(ModelIndex.SetTypeName)).ShouldBeFalse();
    }

    [Fact]
    public void IsMap_returns_true_for_Map()
    {
        PhpTypeMapper.IsMap(new TypeRef(ModelIndex.MapTypeName)).ShouldBeTrue();
        PhpTypeMapper.IsMap(new TypeRef(ModelIndex.ListTypeName)).ShouldBeFalse();
    }

    [Fact]
    public void IsEnum_returns_true_for_enum_type()
    {
        var mapper = new PhpTypeMapper(IndexWithEnum());
        mapper.IsEnum(new TypeRef("Status"), context: null).ShouldBeTrue();
        mapper.IsEnum(new TypeRef("Int"), context: null).ShouldBeFalse();
    }

    // =========================================================================
    // Issue #1638: context-aware Classify for a bare (unqualified) reference
    // =========================================================================

    /// <summary>
    /// Builds a <see cref="ModelIndex"/> from two contexts that each declare a type named
    /// <c>Status</c> of a DIFFERENT kind: <c>Billing</c> (declared first) owns an ENUM, and
    /// <c>Shipping</c> (declared after) owns a differently-kinded VALUE OBJECT. The flat/global
    /// <c>_byName</c> index is last-write-wins, so a context-BLIND lookup of the bare name
    /// <c>"Status"</c> resolves to Shipping's value object, not Billing's own enum.
    /// </summary>
    private static ModelIndex IndexWithSameNamedEnumAndValueAcrossContexts()
    {
        const string src =
            """
            context Billing {
              enum Status {
                Open
                Closed
              }
              value Invoice {
                status: Status
              }
            }

            context Shipping {
              value Status {
                code: Int
              }
            }
            """;
        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return new SemanticModel(result.Model!).Index;
    }

    /// <summary>
    /// Issue #1638: <c>PhpTypeMapper</c> is constructed ONCE per compile and reused across every
    /// context, so it carries no ambient context of its own — only the <c>TypeRef.Qualifier</c>,
    /// which the parser leaves <c>null</c> for the common, BARE (unqualified) same-context
    /// reference. Before the fix, <c>IsEnum</c>'s <c>_index.Classify(type.Qualifier, type.Name)</c>
    /// degraded straight to the flat, context-blind, last-write-wins <c>Classify(typeName)</c>
    /// fallback for a bare reference — so a bare <c>Status</c> resolved against Billing's OWN
    /// context still misclassified as Shipping's later-declared, differently-kinded value object.
    /// <para>
    /// Passing the declaring context explicitly (the fix) makes <c>IsEnum</c> resolve Billing's
    /// bare <c>Status</c> reference against Billing's own scope first, correctly classifying it as
    /// an enum. Unlike the TypeScript mapper — whose enum/non-enum branches emit different strings
    /// (a bare <c>Status</c> vs. a <c>StatusMember</c> interface), so the misclassification is
    /// visible in the compiled TypeScript output — PHP's <c>MapBase</c> enum/non-enum branches both
    /// return the identical <c>PhpNaming.ClassName(type.Name)</c> string (a PHP backed enum's class
    /// name IS the type-hint, same as a value object's), so <c>Map</c>'s emitted type-hint never
    /// observably regresses for this construct. <c>IsEnum</c> has no emitter caller today either
    /// (see <c>PhpConformanceTests.Bare_unqualified_member_field_resolves_the_correct_context_for_a_same_named_sibling_type</c>),
    /// so this unit test is the layer where the fix is actually observable for PHP.
    /// </para>
    /// </summary>
    [Fact]
    public void IsEnum_resolves_bare_reference_against_declaring_context_not_flat_last_writer()
    {
        var index = IndexWithSameNamedEnumAndValueAcrossContexts();
        var mapper = new PhpTypeMapper(index);
        var bareStatus = new TypeRef("Status"); // no Qualifier — a bare, unqualified reference.

        // Resolved against Billing (where Invoice.status is actually declared): Billing's own
        // Status is an enum.
        mapper.IsEnum(bareStatus, context: "Billing").ShouldBeTrue();

        // With no context at all (today's un-fixable fallback case), the flat last-write-wins index
        // still resolves to Shipping's value object — unchanged, not a regression.
        mapper.IsEnum(bareStatus, context: null).ShouldBeFalse();
    }
}
