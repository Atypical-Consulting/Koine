using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class SemanticTokenProviderTests
{
    private static readonly SemanticTokenProvider Provider = new();

    private static IReadOnlyList<SemanticToken> Tokenize(string src) => Provider.Tokenize(src);

    [Fact]
    public void Legend_lists_the_expected_token_types_and_modifiers()
    {
        SemanticTokenProvider.TokenTypeNames.ShouldBe(new[] { "type", "enum", "enumMember", "property", "keyword", "parameter" });
        SemanticTokenProvider.TokenModifierNames.ShouldBe(new[] { "declaration" });
    }

    [Fact]
    public void Legend_order_matches_the_enum_numeric_values()
    {
        // The LSP shell emits the enum's int value as the legend index, so they must agree.
        SemanticTokenProvider.TokenTypeNames[(int)SemanticTokenType.Type].ShouldBe("type");
        SemanticTokenProvider.TokenTypeNames[(int)SemanticTokenType.Enum].ShouldBe("enum");
        SemanticTokenProvider.TokenTypeNames[(int)SemanticTokenType.EnumMember].ShouldBe("enumMember");
        SemanticTokenProvider.TokenTypeNames[(int)SemanticTokenType.Property].ShouldBe("property");
        SemanticTokenProvider.TokenTypeNames[(int)SemanticTokenType.Keyword].ShouldBe("keyword");
        SemanticTokenProvider.TokenTypeNames[(int)SemanticTokenType.Parameter].ShouldBe("parameter");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Declaration].ShouldBe("declaration");
    }

    [Fact]
    public void Broken_document_yields_no_tokens()
    {
        // A value with no name does not parse: degrade gracefully to an empty token set.
        Tokenize("context C {\n  value {\n  }\n}\n").ShouldBeEmpty();
    }

    [Fact]
    public void Type_declaration_name_is_a_type_with_declaration_modifier()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        var tokens = Tokenize(src);

        // "Money" is declared on line 2 (0-based line 1) at column 8 ("  value ").
        var money = tokens.Single(t => t.Line == 1 && t.StartChar == 8);
        money.Type.ShouldBe(SemanticTokenType.Type);
        money.Length.ShouldBe("Money".Length);
        money.Modifiers.ShouldBe(1 << (int)SemanticTokenModifier.Declaration);
    }

    [Fact]
    public void Member_name_is_a_property_and_its_type_is_a_type()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        var tokens = Tokenize(src);

        // "amount" is the member name; "Decimal" its (primitive) type.
        var amount = tokens.Single(t => t.Line == 1 && t.Length == "amount".Length
            && t.Type == SemanticTokenType.Property);
        amount.Modifiers.ShouldBe(1 << (int)SemanticTokenModifier.Declaration);

        tokens.ShouldContain(t => t.Length == "Decimal".Length && t.Type == SemanticTokenType.Type);
    }

    [Fact]
    public void Type_reference_is_classified_as_type_without_declaration_modifier()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var tokens = Tokenize(src);

        // "Money" referenced on line 3 (0-based 2) as the field type of price.
        var reference = tokens.Single(t => t.Line == 2 && t.Length == "Money".Length
            && t.Type == SemanticTokenType.Type);
        reference.Modifiers.ShouldBe(0); // a reference carries no declaration modifier
    }

    [Fact]
    public void Enum_type_and_members_are_classified()
    {
        var src = "context C {\n  enum Status { Draft, Active }\n}\n";
        var tokens = Tokenize(src);

        tokens.ShouldContain(t => t.Length == "Status".Length && t.Type == SemanticTokenType.Enum);
        tokens.ShouldContain(t => t.Length == "Draft".Length && t.Type == SemanticTokenType.EnumMember);
        tokens.ShouldContain(t => t.Length == "Active".Length && t.Type == SemanticTokenType.EnumMember);
    }

    [Fact]
    public void Operation_parameter_is_classified_as_a_parameter()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n"
                + "  service Calc {\n    operation total(base: Money): Money = base\n  }\n}\n";
        var tokens = Tokenize(src);

        // "base" is an operation parameter (declared) — must be a parameter token.
        tokens.ShouldContain(t => t.Length == "base".Length && t.Type == SemanticTokenType.Parameter);
    }

    [Fact]
    public void Tokens_are_sorted_by_position()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var tokens = Tokenize(src);

        for (var i = 1; i < tokens.Count; i++)
        {
            var prev = tokens[i - 1];
            var cur = tokens[i];
            var ordered = cur.Line > prev.Line || (cur.Line == prev.Line && cur.StartChar >= prev.StartChar);
            ordered.ShouldBeTrue("tokens must be ascending by (line, startChar)");
        }
    }

    [Fact]
    public void Encode_produces_five_relative_ints_per_token()
    {
        var tokens = new[]
        {
            new SemanticToken(1, 8, 5, SemanticTokenType.Type, 1 << (int)SemanticTokenModifier.Declaration),
            new SemanticToken(1, 15, 6, SemanticTokenType.Property, 0),
            new SemanticToken(3, 2, 4, SemanticTokenType.Type, 0),
        };
        var data = SemanticTokenProvider.Encode(tokens);

        data.Count.ShouldBe(tokens.Length * 5);

        // First token: absolute (deltaLine=1, deltaStart=8, len=5, type=0=Type, mod=1).
        data.Take(5).ShouldBe(new[] { 1, 8, 5, 0, 1 });
        // Second token on the same line: deltaLine=0, deltaStart relative (15-8=7), type=3=Property.
        data.Skip(5).Take(5).ShouldBe(new[] { 0, 7, 6, 3, 0 });
        // Third token on a new line: deltaLine=2, deltaStart absolute (2), type=0=Type.
        data.Skip(10).Take(5).ShouldBe(new[] { 2, 2, 4, 0, 0 });
    }
}
