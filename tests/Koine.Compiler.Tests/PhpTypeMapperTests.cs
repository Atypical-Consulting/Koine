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
        Assert.Equal(expected, mapper.Map(new TypeRef(koineName)));
    }

    [Fact]
    public void Decimal_maps_to_runtime_Decimal()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        Assert.Equal(@"\Koine\Runtime\Decimal", mapper.Map(new TypeRef("Decimal")));
    }

    [Fact]
    public void Instant_maps_to_DateTimeImmutable()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        Assert.Equal(@"\DateTimeImmutable", mapper.Map(new TypeRef("Instant")));
    }

    [Fact]
    public void Uuid_maps_to_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        Assert.Equal("string", mapper.Map(new TypeRef("Uuid")));
    }

    [Fact]
    public void Guid_maps_to_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        Assert.Equal("string", mapper.Map(new TypeRef("Guid")));
    }

    // =========================================================================
    // Collection mappings
    // =========================================================================

    [Fact]
    public void List_of_Int_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"));
        Assert.Equal("array", mapper.Map(t));
    }

    [Fact]
    public void Set_of_String_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.SetTypeName, Element: new TypeRef("String"));
        Assert.Equal("array", mapper.Map(t));
    }

    [Fact]
    public void Map_of_String_Int_maps_to_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.MapTypeName, Element: new TypeRef("String"), Value: new TypeRef("Int"));
        Assert.Equal("array", mapper.Map(t));
    }

    // =========================================================================
    // Optional (?T) mappings
    // =========================================================================

    [Fact]
    public void Optional_Int_maps_to_nullable_int()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("Int", IsOptional: true);
        Assert.Equal("?int", mapper.Map(t));
    }

    [Fact]
    public void Optional_String_maps_to_nullable_string()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("String", IsOptional: true);
        Assert.Equal("?string", mapper.Map(t));
    }

    [Fact]
    public void Optional_Decimal_maps_to_nullable_runtime_Decimal()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef("Decimal", IsOptional: true);
        Assert.Equal(@"?\Koine\Runtime\Decimal", mapper.Map(t));
    }

    [Fact]
    public void Optional_List_of_Int_maps_to_nullable_array()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"), IsOptional: true);
        Assert.Equal("?array", mapper.Map(t));
    }

    // =========================================================================
    // Enum classification → PascalCase class name
    // =========================================================================

    [Fact]
    public void Enum_type_maps_to_PascalCase_name()
    {
        var mapper = new PhpTypeMapper(IndexWithEnum());
        var t = new TypeRef("Status");
        Assert.Equal("Status", mapper.Map(t));
    }

    // =========================================================================
    // Unknown / value object / entity → PascalCase name
    // =========================================================================

    [Fact]
    public void Unknown_type_maps_to_PascalCase()
    {
        var mapper = new PhpTypeMapper(EmptyIndex());
        Assert.Equal("SomeType", mapper.Map(new TypeRef("SomeType")));
    }

    // =========================================================================
    // Static helpers
    // =========================================================================

    [Fact]
    public void IsList_returns_true_for_List()
    {
        Assert.True(PhpTypeMapper.IsList(new TypeRef(ModelIndex.ListTypeName)));
        Assert.False(PhpTypeMapper.IsList(new TypeRef(ModelIndex.SetTypeName)));
    }

    [Fact]
    public void IsMap_returns_true_for_Map()
    {
        Assert.True(PhpTypeMapper.IsMap(new TypeRef(ModelIndex.MapTypeName)));
        Assert.False(PhpTypeMapper.IsMap(new TypeRef(ModelIndex.ListTypeName)));
    }

    [Fact]
    public void IsEnum_returns_true_for_enum_type()
    {
        var mapper = new PhpTypeMapper(IndexWithEnum());
        Assert.True(mapper.IsEnum(new TypeRef("Status")));
        Assert.False(mapper.IsEnum(new TypeRef("Int")));
    }
}
