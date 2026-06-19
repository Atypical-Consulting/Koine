using Koine.Compiler.Ast;
using Koine.Compiler.Emit.Php;
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
        var result = new KoineCompiler().Compile("context C { value V { x: Int } }", new Koine.Compiler.Emit.CSharp.CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    private static ModelIndex IndexWithEnum()
    {
        var result = new KoineCompiler().Compile(
            "context C { enum Status { Active Inactive } value V { s: Status } }",
            new Koine.Compiler.Emit.CSharp.CSharpEmitter());
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
        mapper.Map(new TypeRef(koineName)).ShouldBe(expected);
    }

    [Fact]
    public void Decimal_maps_to_runtime_Decimal()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Decimal")).ShouldBe(@"\Koine\Runtime\Decimal");
    }

    [Fact]
    public void Instant_maps_to_DateTimeImmutable()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Instant")).ShouldBe(@"\DateTimeImmutable");
    }

    [Fact]
    public void Uuid_maps_to_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Uuid")).ShouldBe("string");
    }

    [Fact]
    public void Guid_maps_to_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("Guid")).ShouldBe("string");
    }

    // =========================================================================
    // Collection mappings
    // =========================================================================

    [Fact]
    public void List_of_Int_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"));
        mapper.Map(t).ShouldBe("array");
    }

    [Fact]
    public void Set_of_String_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.SetTypeName, Element: new TypeRef("String"));
        mapper.Map(t).ShouldBe("array");
    }

    [Fact]
    public void Map_of_String_Int_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.MapTypeName, Element: new TypeRef("String"), Value: new TypeRef("Int"));
        mapper.Map(t).ShouldBe("array");
    }

    // =========================================================================
    // Optional (?T) mappings
    // =========================================================================

    [Fact]
    public void Optional_Int_maps_to_nullable_int()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("Int", IsOptional: true);
        mapper.Map(t).ShouldBe("?int");
    }

    [Fact]
    public void Optional_String_maps_to_nullable_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("String", IsOptional: true);
        mapper.Map(t).ShouldBe("?string");
    }

    [Fact]
    public void Optional_Decimal_maps_to_nullable_runtime_Decimal()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("Decimal", IsOptional: true);
        mapper.Map(t).ShouldBe(@"?\Koine\Runtime\Decimal");
    }

    [Fact]
    public void Optional_List_of_Int_maps_to_nullable_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"), IsOptional: true);
        mapper.Map(t).ShouldBe("?array");
    }

    // =========================================================================
    // Enum classification → PascalCase class name
    // =========================================================================

    [Fact]
    public void Enum_type_maps_to_PascalCase_name()
    {
        var mapper = new PhpTypeMapper(IndexWithEnum());
        var t = new TypeRef("Status");
        mapper.Map(t).ShouldBe("Status");
    }

    // =========================================================================
    // Unknown / value object / entity → PascalCase name
    // =========================================================================

    [Fact]
    public void Unknown_type_maps_to_PascalCase()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        mapper.Map(new TypeRef("SomeType")).ShouldBe("SomeType");
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
        mapper.IsEnum(new TypeRef("Status")).ShouldBeTrue();
        mapper.IsEnum(new TypeRef("Int")).ShouldBeFalse();
    }
}
