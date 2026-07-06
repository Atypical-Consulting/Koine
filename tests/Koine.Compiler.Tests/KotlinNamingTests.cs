using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="KotlinNaming"/> and <see cref="KotlinTypeMapper"/> — the identifier casing /
/// hard-keyword backtick escaping and the pure Koine-<see cref="TypeRef"/>-to-Kotlin-type mapping table the
/// Kotlin backend relies on (PascalCase types, camelCase members, lowercase packages, backtick keyword
/// escaping — the Kotlin analogue of the Java backend's trailing-underscore rename — and the
/// dependency-free Kotlin 2.x/JVM stdlib type strings).
/// </summary>
public class KotlinNamingTests
{
    private static ModelIndex EmptyIndex()
    {
        var result = new KoineCompiler().Compile(
            "context C { value V { x: Int } }", new CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    // --- KotlinNaming: casing ---

    [Theory]
    [InlineData("order_line", "OrderLine")]
    [InlineData("unitPrice", "UnitPrice")]
    [InlineData("OrderLine", "OrderLine")]
    [InlineData("money", "Money")]
    public void ToTypeName_produces_PascalCase(string input, string expected)
    {
        KotlinNaming.ToTypeName(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("UnitPrice", "unitPrice")]
    [InlineData("unit_price", "unitPrice")]
    [InlineData("unitPrice", "unitPrice")]
    [InlineData("amount", "amount")]
    public void ToMemberName_produces_camelCase(string input, string expected)
    {
        KotlinNaming.ToMemberName(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("Billing", "billing")]
    [InlineData("OrderManagement", "ordermanagement")]
    public void ToPackageSegment_lowercases_the_context_segment(string input, string expected)
    {
        KotlinNaming.ToPackageSegment(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("object", "`object`")]        // lowercases to a hard keyword -> backtick-escaped
    [InlineData("when", "`when`")]
    [InlineData("Object", "`object`")]         // casing doesn't matter: lowercase collides -> escaped
    [InlineData("Billing", "billing")]         // not a keyword: lowercased, unchanged
    [InlineData("Order_Management", "ordermanagement")]  // separators dropped, not a keyword
    [InlineData("value", "value")]             // a SOFT keyword: legal as a package segment, unchanged
    public void ToPackageSegmentEscaped_backticks_keyword_segments(string input, string expected)
    {
        KotlinNaming.ToPackageSegmentEscaped(input).ShouldBe(expected);
    }

    // --- KotlinNaming: hard-keyword backtick escaping ---

    [Theory]
    [InlineData("when", "`when`")]      // a hard keyword: escaped with backticks (Kotlin's @/r# analogue)
    [InlineData("object", "`object`")]
    [InlineData("in", "`in`")]
    [InlineData("fun", "`fun`")]
    [InlineData("is", "`is`")]
    [InlineData("val", "`val`")]
    [InlineData("typealias", "`typealias`")]
    [InlineData("amount", "amount")]    // not a keyword: unchanged
    [InlineData("value", "value")]      // a SOFT keyword: legal as an identifier, unchanged
    public void EscapeIdentifier_backticks_hard_keywords(string input, string expected)
    {
        KotlinNaming.EscapeIdentifier(input).ShouldBe(expected);
    }

    [Fact]
    public void ToMemberName_escapes_a_hard_keyword()
    {
        KotlinNaming.ToMemberName("when").ShouldBe("`when`");
        KotlinNaming.ToMemberName("object").ShouldBe("`object`");
    }

    // --- KotlinTypeMapper: primitives ---

    [Theory]
    [InlineData("String", "String")]
    [InlineData("Int", "Long")]
    [InlineData("Bool", "Boolean")]
    [InlineData("Decimal", "java.math.BigDecimal")]
    [InlineData("Instant", "java.time.Instant")]
    public void Map_translates_primitives(string koineName, string expected)
    {
        new KotlinTypeMapper(EmptyIndex()).Map(new TypeRef(koineName)).ShouldBe(expected);
    }

    // --- KotlinTypeMapper: optionals map to Kotlin nullable T?, never Optional ---

    [Fact]
    public void Map_optional_string_is_nullable()
    {
        new KotlinTypeMapper(EmptyIndex())
            .Map(new TypeRef("String", IsOptional: true)).ShouldBe("String?");
    }

    [Fact]
    public void Map_optional_int_is_nullable_Long()
    {
        new KotlinTypeMapper(EmptyIndex())
            .Map(new TypeRef("Int", IsOptional: true)).ShouldBe("Long?");
    }

    // --- KotlinTypeMapper: collections ---

    [Fact]
    public void Map_list_of_ints()
    {
        new KotlinTypeMapper(EmptyIndex())
            .Map(new TypeRef("List", new TypeRef("Int"))).ShouldBe("List<Long>");
    }

    [Fact]
    public void Map_set_of_strings()
    {
        new KotlinTypeMapper(EmptyIndex())
            .Map(new TypeRef("Set", new TypeRef("String"))).ShouldBe("Set<String>");
    }

    [Fact]
    public void Map_map_of_string_to_int()
    {
        new KotlinTypeMapper(EmptyIndex())
            .Map(new TypeRef("Map", new TypeRef("String"), new TypeRef("Int"))).ShouldBe("Map<String, Long>");
    }

    [Fact]
    public void Map_nullable_list_is_nullable()
    {
        new KotlinTypeMapper(EmptyIndex())
            .Map(new TypeRef("List", new TypeRef("String"), IsOptional: true)).ShouldBe("List<String>?");
    }

    [Fact]
    public void Map_range_maps_to_runtime_Range()
    {
        new KotlinTypeMapper(EmptyIndex())
            .Map(new TypeRef("Range", new TypeRef("Instant"))).ShouldBe("koine.runtime.Range<java.time.Instant>");
    }

    // --- KotlinTypeMapper: named types / generated ids map to their PascalCase wrapper name ---

    [Fact]
    public void Map_named_type_uses_its_PascalCase_wrapper_name()
    {
        new KotlinTypeMapper(EmptyIndex()).Map(new TypeRef("order_id")).ShouldBe("OrderId");
    }
}
