namespace Koine.Compiler.Tests;

/// <summary>
/// The shared word-boundary splitter (#1239) behind <see cref="RouteDerivation.Kebab"/> and the
/// per-language <c>ToSnakeCase</c> naming helpers (Rust/Python/Php): one canonical implementation of
/// "where does a new word start in this PascalCase/camelCase/mixed identifier" — a boundary starts
/// before an uppercase letter that follows a lowercase letter, or that ends an acronym run (an
/// uppercase letter followed by a lowercase one). Words are returned with their original casing
/// (callers lowercase/uppercase and join with their own separator).
/// <para>
/// A digit-then-uppercase transition (e.g. <c>V2Import</c>) is the one boundary the four
/// pre-extraction implementations genuinely disagreed on: <see cref="RouteDerivation.Kebab"/> always
/// split there; the per-language <c>ToSnakeCase</c> helpers never did (code review during #1239's
/// implementation). <see cref="IdentifierWords.Split"/> makes that an explicit
/// <c>splitAfterDigit</c> parameter instead of silently picking a winner, so every caller keeps its
/// own exact pre-extraction behavior.
/// </para>
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
    public void Split_breaks_on_word_and_acronym_boundaries_regardless_of_the_digit_flag(string name, string[] expected)
    {
        IdentifierWords.Split(name, splitAfterDigit: true).ShouldBe(expected);
        IdentifierWords.Split(name, splitAfterDigit: false).ShouldBe(expected);
    }

    [Theory]
    [InlineData("Order2Ship", new[] { "Order2", "Ship" })]
    [InlineData("V2Import", new[] { "V2", "Import" })]
    public void Split_breaks_after_a_digit_when_splitAfterDigit_is_true(string name, string[] expected)
    {
        IdentifierWords.Split(name, splitAfterDigit: true).ShouldBe(expected);
    }

    [Theory]
    [InlineData("Order2Ship", new[] { "Order2Ship" })]
    [InlineData("V2Import", new[] { "V2Import" })]
    public void Split_keeps_a_digit_glued_to_the_next_word_when_splitAfterDigit_is_false(string name, string[] expected)
    {
        IdentifierWords.Split(name, splitAfterDigit: false).ShouldBe(expected);
    }

    [Fact]
    public void Split_of_empty_string_returns_a_single_empty_word()
    {
        IdentifierWords.Split(string.Empty, splitAfterDigit: true).ShouldBe(new[] { string.Empty });
    }
}
