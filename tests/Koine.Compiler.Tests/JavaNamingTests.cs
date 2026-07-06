using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="JavaNaming"/> and <see cref="JavaTypeMapper"/> — the identifier casing /
/// reserved-word renaming and the pure Koine-<see cref="TypeRef"/>-to-Java-type mapping table the Java
/// backend relies on (PascalCase types, camelCase members, lowercase packages, trailing-underscore
/// keyword renaming, and the dependency-free Java 17 stdlib type strings).
/// </summary>
public class JavaNamingTests
{
    private static ModelIndex EmptyIndex()
    {
        var result = new KoineCompiler().Compile(
            "context C { value V { x: Int } }", new CSharpEmitter());
        return new SemanticModel(result.Model!).Index;
    }

    // --- JavaNaming: casing ---

    [Theory]
    [InlineData("order_line", "OrderLine")]
    [InlineData("unitPrice", "UnitPrice")]
    [InlineData("OrderLine", "OrderLine")]
    [InlineData("money", "Money")]
    public void Type_produces_PascalCase(string input, string expected)
    {
        JavaNaming.Type(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("UnitPrice", "unitPrice")]
    [InlineData("unit_price", "unitPrice")]
    [InlineData("unitPrice", "unitPrice")]
    [InlineData("amount", "amount")]
    public void Member_produces_camelCase(string input, string expected)
    {
        JavaNaming.Member(input).ShouldBe(expected);
    }

    [Fact]
    public void Package_lowercases_the_context_segment()
    {
        JavaNaming.Package("Billing").ShouldBe("billing");
    }

    // --- JavaNaming: reserved-word renaming ---

    [Theory]
    [InlineData("class", "class_")]     // a keyword: renamed (Java has no @/r# escape)
    [InlineData("new", "new_")]
    [InlineData("default", "default_")]
    [InlineData("record", "record_")]   // a contextual keyword
    [InlineData("var", "var_")]
    [InlineData("yield", "yield_")]
    [InlineData("amount", "amount")]    // not a keyword: unchanged
    public void EscapeIdentifier_renames_reserved_words(string input, string expected)
    {
        JavaNaming.EscapeIdentifier(input).ShouldBe(expected);
    }

    [Fact]
    public void EscapeIdentifier_never_leaves_a_reserved_word_verbatim()
    {
        JavaNaming.EscapeIdentifier("class").ShouldNotBe("class");
    }

    [Fact]
    public void Member_escapes_a_reserved_word()
    {
        JavaNaming.Member("class").ShouldBe("class_");
    }

    // --- JavaTypeMapper: primitives ---

    [Theory]
    [InlineData("String", "String")]
    [InlineData("Int", "long")]
    [InlineData("Bool", "boolean")]
    [InlineData("Decimal", "java.math.BigDecimal")]
    [InlineData("Instant", "java.time.Instant")]
    public void Map_translates_primitives(string koineName, string expected)
    {
        new JavaTypeMapper(EmptyIndex()).Map(new TypeRef(koineName)).ShouldBe(expected);
    }

    [Fact]
    public void Map_money_decimal_is_BigDecimal()
    {
        new JavaTypeMapper(EmptyIndex()).Map(new TypeRef("Decimal")).ShouldBe("java.math.BigDecimal");
    }

    // --- JavaTypeMapper: optionals (boxed inside Optional<>) ---

    [Fact]
    public void Map_optional_boxes_the_primitive()
    {
        new JavaTypeMapper(EmptyIndex())
            .Map(new TypeRef("Int", IsOptional: true)).ShouldBe("java.util.Optional<Long>");
    }

    [Fact]
    public void Map_optional_reference_type_stays_unboxed()
    {
        new JavaTypeMapper(EmptyIndex())
            .Map(new TypeRef("String", IsOptional: true)).ShouldBe("java.util.Optional<String>");
    }

    // --- JavaTypeMapper: collections (element boxed) ---

    [Fact]
    public void Map_list_boxes_its_element()
    {
        new JavaTypeMapper(EmptyIndex())
            .Map(new TypeRef("List", new TypeRef("Int"))).ShouldBe("java.util.List<Long>");
    }

    [Fact]
    public void Map_list_of_strings()
    {
        new JavaTypeMapper(EmptyIndex())
            .Map(new TypeRef("List", new TypeRef("String"))).ShouldBe("java.util.List<String>");
    }

    // --- JavaTypeMapper: named types / generated ids map to their PascalCase wrapper name ---

    [Fact]
    public void Map_named_type_uses_its_PascalCase_wrapper_name()
    {
        new JavaTypeMapper(EmptyIndex()).Map(new TypeRef("order_id")).ShouldBe("OrderId");
    }
}
