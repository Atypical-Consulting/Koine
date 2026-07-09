namespace Koine.Compiler.Tests;

/// <summary>
/// The shared word-boundary splitter (#1239) behind <see cref="RouteDerivation.Kebab"/> and the
/// per-language <c>ToSnakeCase</c> naming helpers (Rust/Python/Php): one canonical implementation of
/// "where does a new word start in this PascalCase/camelCase/mixed identifier" — a boundary starts
/// before an uppercase letter that follows a lowercase/digit, or that ends an acronym run (an
/// uppercase letter followed by a lowercase one). Words are returned with their original casing
/// (callers lowercase/uppercase and join with their own separator).
/// </summary>
public class IdentifierWordsTests
{
    [Theory]
    [InlineData("OrderById", new[] { "Order", "By", "Id" })]
    [InlineData("XMLImport", new[] { "XML", "Import" })]
    [InlineData("UnitPrice", new[] { "Unit", "Price" })]
    [InlineData("unitPrice", new[] { "unit", "Price" })]
    [InlineData("URLPath", new[] { "URL", "Path" })]
    [InlineData("subtotal", new[] { "subtotal" })]
    [InlineData("EUR", new[] { "EUR" })]
    [InlineData("Order2Ship", new[] { "Order2", "Ship" })]
    [InlineData("V2Import", new[] { "V2", "Import" })]
    public void Split_breaks_on_word_and_acronym_boundaries(string name, string[] expected)
    {
        IdentifierWords.Split(name).ShouldBe(expected);
    }

    [Fact]
    public void Split_of_empty_string_returns_a_single_empty_word()
    {
        IdentifierWords.Split(string.Empty).ShouldBe(new[] { string.Empty });
    }
}
