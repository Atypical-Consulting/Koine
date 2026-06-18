using Koine.Compiler.Ast;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="PythonTypeMapper"/> — the pure type-mapping table that converts
/// Koine <see cref="TypeRef"/>s to their Python type-annotation strings.
/// </summary>
public class PythonTypeMapperTests
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
    [InlineData("String", "str")]
    [InlineData("Int", "int")]
    [InlineData("Bool", "bool")]
    [InlineData("Decimal", "Decimal")]
    [InlineData("Instant", "datetime")]
    public void Primitive_types_map_correctly(string koineName, string expected)
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        Assert.Equal(expected, mapper.Map(new TypeRef(koineName)));
    }

    [Fact]
    public void Decimal_maps_to_Decimal()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        Assert.Equal("Decimal", mapper.Map(new TypeRef("Decimal")));
    }

    [Fact]
    public void Instant_maps_to_datetime()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        Assert.Equal("datetime", mapper.Map(new TypeRef("Instant")));
    }

    // =========================================================================
    // Collection mappings
    // =========================================================================

    [Fact]
    public void List_of_Int_maps_to_tuple()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"));
        Assert.Equal("tuple[int, ...]", mapper.Map(t));
    }

    [Fact]
    public void Set_of_String_maps_to_frozenset()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.SetTypeName, Element: new TypeRef("String"));
        Assert.Equal("frozenset[str]", mapper.Map(t));
    }

    [Fact]
    public void Map_of_String_Int_maps_to_Mapping()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.MapTypeName, Element: new TypeRef("String"), Value: new TypeRef("Int"));
        Assert.Equal("Mapping[str, int]", mapper.Map(t));
    }

    [Fact]
    public void Range_of_Int_maps_to_Range()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.RangeTypeName, Element: new TypeRef("Int"));
        Assert.Equal("Range[int]", mapper.Map(t));
    }

    // =========================================================================
    // Optional (T | None) mappings
    // =========================================================================

    [Fact]
    public void Optional_Int_maps_to_int_or_None()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef("Int", IsOptional: true);
        Assert.Equal("int | None", mapper.Map(t));
    }

    [Fact]
    public void Optional_List_of_Int_maps_correctly()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName, Element: new TypeRef("Int"), IsOptional: true);
        Assert.Equal("tuple[int, ...] | None", mapper.Map(t));
    }

    [Fact]
    public void Optional_String_maps_to_str_or_None()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef("String", IsOptional: true);
        Assert.Equal("str | None", mapper.Map(t));
    }

    [Fact]
    public void Optional_Decimal_maps_to_Decimal_or_None()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef("Decimal", IsOptional: true);
        Assert.Equal("Decimal | None", mapper.Map(t));
    }

    // =========================================================================
    // Null type arg (missing element) → object
    // =========================================================================

    [Fact]
    public void List_with_null_element_maps_to_object()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        var t = new TypeRef(ModelIndex.ListTypeName); // no element arg
        Assert.Equal("tuple[object, ...]", mapper.Map(t));
    }

    // =========================================================================
    // Enum classification → PascalCase name directly (no "Member" suffix like TS)
    // =========================================================================

    [Fact]
    public void Enum_type_maps_to_PascalCase_name()
    {
        var mapper = new PythonTypeMapper(IndexWithEnum());
        var t = new TypeRef("Status");
        Assert.Equal("Status", mapper.Map(t));
    }

    // =========================================================================
    // Unknown / value object / entity → PascalCase name
    // =========================================================================

    [Fact]
    public void Unknown_type_maps_to_PascalCase()
    {
        var mapper = new PythonTypeMapper(EmptyIndex());
        Assert.Equal("SomeType", mapper.Map(new TypeRef("SomeType")));
    }

    // =========================================================================
    // Static helpers
    // =========================================================================

    [Fact]
    public void IsList_returns_true_for_List()
    {
        Assert.True(PythonTypeMapper.IsList(new TypeRef(ModelIndex.ListTypeName)));
        Assert.False(PythonTypeMapper.IsList(new TypeRef(ModelIndex.SetTypeName)));
    }

    [Fact]
    public void IsSet_returns_true_for_Set()
    {
        Assert.True(PythonTypeMapper.IsSet(new TypeRef(ModelIndex.SetTypeName)));
        Assert.False(PythonTypeMapper.IsSet(new TypeRef(ModelIndex.ListTypeName)));
    }

    [Fact]
    public void IsMap_returns_true_for_Map()
    {
        Assert.True(PythonTypeMapper.IsMap(new TypeRef(ModelIndex.MapTypeName)));
        Assert.False(PythonTypeMapper.IsMap(new TypeRef(ModelIndex.ListTypeName)));
    }

    [Fact]
    public void IsEnum_returns_true_for_enum_type()
    {
        var mapper = new PythonTypeMapper(IndexWithEnum());
        Assert.True(mapper.IsEnum(new TypeRef("Status")));
        Assert.False(mapper.IsEnum(new TypeRef("Int")));
    }
}
