using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="RustTypeMapper"/> — the pure type-mapping table that converts Koine
/// <see cref="TypeRef"/>s to their Rust type strings.
/// </summary>
public class RustTypeMapperTests
{
    private static ModelIndex EmptyIndex()
    {
        var result = new KoineCompiler().Compile(
            "context C { value V { x: Int } }", new CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    private static ModelIndex IndexWithEnums()
    {
        var result = new KoineCompiler().Compile(
            "context C { enum Bare { Active Inactive } enum Data(n: Int) { One(1) } value V { b: Bare d: Data } }",
            new CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    [Theory]
    [InlineData("String", "String")]
    [InlineData("Int", "i64")]
    [InlineData("Bool", "bool")]
    [InlineData("Decimal", "Decimal")]
    [InlineData("Instant", "Instant")]
    public void Primitive_types_map_correctly(string koineName, string expected)
    {
        new RustTypeMapper(EmptyIndex()).Map(new TypeRef(koineName)).ShouldBe(expected);
    }

    [Fact]
    public void List_maps_to_Vec()
    {
        new RustTypeMapper(EmptyIndex())
            .Map(new TypeRef("List", new TypeRef("Int"))).ShouldBe("Vec<i64>");
    }

    [Fact]
    public void Set_maps_to_HashSet()
    {
        new RustTypeMapper(EmptyIndex())
            .Map(new TypeRef("Set", new TypeRef("String"))).ShouldBe("HashSet<String>");
    }

    [Fact]
    public void Map_maps_to_HashMap()
    {
        new RustTypeMapper(EmptyIndex())
            .Map(new TypeRef("Map", new TypeRef("String"), new TypeRef("Int"))).ShouldBe("HashMap<String, i64>");
    }

    [Fact]
    public void Range_maps_to_runtime_Range()
    {
        new RustTypeMapper(EmptyIndex())
            .Map(new TypeRef("Range", new TypeRef("Instant"))).ShouldBe("Range<Instant>");
    }

    [Fact]
    public void Optional_wraps_in_Option()
    {
        new RustTypeMapper(EmptyIndex())
            .Map(new TypeRef("String", IsOptional: true)).ShouldBe("Option<String>");
    }

    [Fact]
    public void Named_types_map_to_their_PascalCase_name()
    {
        new RustTypeMapper(EmptyIndex()).Map(new TypeRef("order_line")).ShouldBe("OrderLine");
    }

    [Fact]
    public void Copy_is_true_for_scalars_and_all_enums()
    {
        var mapper = new RustTypeMapper(IndexWithEnums());
        mapper.IsCopy(new TypeRef("Int")).ShouldBeTrue();
        mapper.IsCopy(new TypeRef("Decimal")).ShouldBeTrue();
        // Both enum kinds emit as unit-variant Rust enums deriving Copy (associated data via methods).
        mapper.IsCopy(new TypeRef("Bare")).ShouldBeTrue();
        mapper.IsCopy(new TypeRef("Data")).ShouldBeTrue();
        mapper.IsCopy(new TypeRef("String")).ShouldBeFalse();
        mapper.IsCopy(new TypeRef("Int", IsOptional: true)).ShouldBeFalse();
    }
}
