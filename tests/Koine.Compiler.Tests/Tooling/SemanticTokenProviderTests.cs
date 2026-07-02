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
        SemanticTokenProvider.TokenModifierNames.ShouldBe(new[]
        {
            "declaration", "aggregate", "entity", "valueObject", "enumeration", "domainEvent",
            "integrationEvent", "command", "query", "readModel", "service", "repository", "policy",
            "factory", "stateMachine", "specification",
        });
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

        // Concept-kind modifiers occupy bits 1–15 (append-only; indices 0–5 and bit 0 never shift).
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Aggregate].ShouldBe("aggregate");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Entity].ShouldBe("entity");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.ValueObject].ShouldBe("valueObject");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Enumeration].ShouldBe("enumeration");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.DomainEvent].ShouldBe("domainEvent");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.IntegrationEvent].ShouldBe("integrationEvent");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Command].ShouldBe("command");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Query].ShouldBe("query");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.ReadModel].ShouldBe("readModel");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Service].ShouldBe("service");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Repository].ShouldBe("repository");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Policy].ShouldBe("policy");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Factory].ShouldBe("factory");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.StateMachine].ShouldBe("stateMachine");
        SemanticTokenProvider.TokenModifierNames[(int)SemanticTokenModifier.Specification].ShouldBe("specification");
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
        // A value-object declaration carries the declaration bit AND its concept-kind bit.
        money.Modifiers.ShouldBe((1 << (int)SemanticTokenModifier.Declaration)
            | (1 << (int)SemanticTokenModifier.ValueObject));
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
        // A reference carries no declaration modifier, but still carries its concept-kind bit.
        (reference.Modifiers & (1 << (int)SemanticTokenModifier.Declaration)).ShouldBe(0);
        (reference.Modifiers & (1 << (int)SemanticTokenModifier.ValueObject)).ShouldNotBe(0);
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

    [Fact]
    public void Declarations_and_references_carry_their_concept_kind_modifier()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n  entity Customer identified by CustomerId {\n    balance: Money\n  }\n}\n";
        var tokens = Tokenize(src);

        var decl = tokens.Single(t => t.Line == 1 && t.StartChar == 8); // "Money" declaration
        decl.Modifiers.ShouldBe((1 << (int)SemanticTokenModifier.Declaration)
            | (1 << (int)SemanticTokenModifier.ValueObject));

        var reference = tokens.Single(t => t.Line == 3 && t.Length == "Money".Length
            && t.Type == SemanticTokenType.Type);
        reference.Modifiers.ShouldBe(1 << (int)SemanticTokenModifier.ValueObject);
    }

    [Fact]
    public void Enum_declaration_keeps_enum_type_and_gains_enumeration_modifier()
    {
        var src = "context C {\n  enum Status { Draft, Active }\n}\n";
        var decl = Tokenize(src).Single(t => t.Type == SemanticTokenType.Enum
            && (t.Modifiers & (1 << (int)SemanticTokenModifier.Declaration)) != 0);
        (decl.Modifiers & (1 << (int)SemanticTokenModifier.Enumeration)).ShouldNotBe(0);
    }

    [Fact]
    public void Aggregate_name_and_root_entity_carry_their_kinds()
    {
        var src = "context C {\n  entity Customer identified by CustomerId { name: String }\n"
                + "  aggregate Sales root Order {\n    entity Order identified by OrderId {\n"
                + "      customer: CustomerId\n    }\n  }\n}\n";
        var tokens = Tokenize(src);

        static bool IsDecl(SemanticToken t) =>
            (t.Modifiers & (1 << (int)SemanticTokenModifier.Declaration)) != 0;

        // The aggregate NAME (Sales, 0-based line 2) carries the aggregate kind; the nested root
        // entity (Order, line 3) and the plain Customer entity (line 1) carry entity.
        var aggregate = tokens.Single(t => t.Line == 2 && t.Type == SemanticTokenType.Type && IsDecl(t));
        aggregate.Length.ShouldBe("Sales".Length);
        (aggregate.Modifiers & (1 << (int)SemanticTokenModifier.Aggregate)).ShouldNotBe(0);

        var rootEntityDecl = tokens.Single(t => t.Line == 3 && t.Type == SemanticTokenType.Type && IsDecl(t));
        rootEntityDecl.Length.ShouldBe("Order".Length);
        (rootEntityDecl.Modifiers & (1 << (int)SemanticTokenModifier.Entity)).ShouldNotBe(0);

        var customer = tokens.Single(t => t.Line == 1 && t.Type == SemanticTokenType.Type && IsDecl(t));
        customer.Length.ShouldBe("Customer".Length);
        (customer.Modifiers & (1 << (int)SemanticTokenModifier.Entity)).ShouldNotBe(0);
    }

    [Fact]
    public void Domain_event_declaration_carries_the_domain_event_modifier()
    {
        var src = "context C {\n  aggregate Sales root Order {\n"
                + "    entity Order identified by OrderId { name: String }\n"
                + "    event Placed { amount: Decimal }\n  }\n}\n";
        var placed = Tokenize(src).Single(t => t.Length == "Placed".Length && t.Type == SemanticTokenType.Type
            && (t.Modifiers & (1 << (int)SemanticTokenModifier.Declaration)) != 0);
        (placed.Modifiers & (1 << (int)SemanticTokenModifier.DomainEvent)).ShouldNotBe(0);
    }

    [Fact]
    public void Integration_event_declaration_carries_the_integration_event_modifier()
    {
        var src = "context C {\n  entity Customer identified by CustomerId { name: String }\n"
                + "  integration event Published { who: CustomerId }\n}\n";
        var published = Tokenize(src).Single(t => t.Length == "Published".Length && t.Type == SemanticTokenType.Type
            && (t.Modifiers & (1 << (int)SemanticTokenModifier.Declaration)) != 0);
        (published.Modifiers & (1 << (int)SemanticTokenModifier.IntegrationEvent)).ShouldNotBe(0);
    }

    [Fact]
    public void Primitive_reference_carries_no_concept_kind_modifier()
    {
        var src = "context C {\n  value Money { amount: Decimal }\n}\n";
        var decimalRef = Tokenize(src).Single(t => t.Length == "Decimal".Length && t.Type == SemanticTokenType.Type);
        decimalRef.Modifiers.ShouldBe(0); // a primitive is not a DDD concept — no kind bit, no declaration bit
    }
}
