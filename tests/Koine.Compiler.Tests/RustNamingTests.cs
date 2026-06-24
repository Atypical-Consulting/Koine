using Koine.Compiler.Emit.Rust;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for <see cref="RustNaming"/> — the identifier casing and Rust-keyword raw-identifier
/// escaping the Rust backend relies on (PascalCase types/variants, snake_case fields/methods/modules,
/// SCREAMING_SNAKE constants, <c>r#kw</c> escaping).
/// </summary>
public class RustNamingTests
{
    [Theory]
    [InlineData("order_line", "OrderLine")]
    [InlineData("unitPrice", "UnitPrice")]
    [InlineData("OrderLine", "OrderLine")]
    [InlineData("money", "Money")]
    public void ToPascalCase_handles_each_input_shape(string input, string expected)
    {
        RustNaming.ToPascalCase(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("UnitPrice", "unit_price")]
    [InlineData("unitPrice", "unit_price")]
    [InlineData("URLPath", "url_path")]
    [InlineData("subtotal", "subtotal")]
    [InlineData("order_line", "order_line")]
    public void ToSnakeCase_handles_each_input_shape(string input, string expected)
    {
        RustNaming.ToSnakeCase(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("OrderStatus", "ORDER_STATUS")]
    [InlineData("EUR", "EUR")]
    public void ToScreamingSnake_uppercases_the_snake_form(string input, string expected)
    {
        RustNaming.ToScreamingSnake(input).ShouldBe(expected);
    }

    [Theory]
    [InlineData("type", "r#type")]   // a keyword that IS a valid raw identifier
    [InlineData("match", "r#match")]
    [InlineData("fn", "r#fn")]
    [InlineData("amount", "amount")] // not a keyword: unchanged
    public void EscapeMember_raw_escapes_keywords(string snake, string expected)
    {
        RustNaming.EscapeMember(snake).ShouldBe(expected);
    }

    [Theory]
    [InlineData("self", "self_")]   // keywords that cannot be raw identifiers fall back to a suffix
    [InlineData("crate", "crate_")]
    [InlineData("super", "super_")]
    public void EscapeMember_suffix_escapes_non_raw_keywords(string snake, string expected)
    {
        RustNaming.EscapeMember(snake).ShouldBe(expected);
    }

    [Fact]
    public void Field_snake_cases_then_escapes()
    {
        RustNaming.Field("unitPrice").ShouldBe("unit_price");
        RustNaming.Field("Type").ShouldBe("r#type");
    }

    // The synthetic domain-event collector field name resolution (issue #314).

    [Fact]
    public void SyntheticEventsField_prefers_events_when_free()
    {
        RustNaming.SyntheticEventsField(["id", "amount", "status"]).ShouldBe("events");
    }

    [Fact]
    public void SyntheticEventsField_falls_back_to_domain_events_when_events_is_taken()
    {
        RustNaming.SyntheticEventsField(["id", "events"]).ShouldBe("domain_events");
    }

    [Fact]
    public void SyntheticEventsField_numbers_the_suffix_when_both_events_and_domain_events_are_taken()
    {
        RustNaming.SyntheticEventsField(["id", "events", "domain_events"]).ShouldBe("domain_events_2");
    }

    [Fact]
    public void SyntheticEventsField_keeps_the_drain_accessor_collision_free()
    {
        // A user member `drain_events` would collide with the `events` collector's `drain_events()`
        // accessor, so `events` must be skipped even though the bare field name is itself free.
        RustNaming.SyntheticEventsField(["id", "drain_events"]).ShouldBe("domain_events");
    }

    // Smart-enum match-arm binding de-duplication (issue #315).

    [Fact]
    public void UniqueBindings_leaves_non_colliding_members_unchanged()
    {
        RustNaming.UniqueBindings(["Draft", "Submitted", "Paid"])
            .ShouldBe(["draft", "submitted", "paid"]);
    }

    [Fact]
    public void UniqueBindings_suffixes_members_that_snake_case_collapse()
    {
        // `userID` and `userId` both snake_case to `user_id`; the second is disambiguated (#315).
        RustNaming.UniqueBindings(["userID", "userId", "System"])
            .ShouldBe(["user_id", "user_id_2", "system"]);
    }

    [Fact]
    public void UniqueBindings_suffixes_three_plus_collapsing_members_in_order()
    {
        RustNaming.UniqueBindings(["userID", "userId", "UserId"])
            .ShouldBe(["user_id", "user_id_2", "user_id_3"]);
    }

    [Fact]
    public void UniqueBindings_keeps_incrementing_past_a_natural_collision_with_a_suffix()
    {
        // A member literally named `userId2` snake_cases to `user_id2`, which does not collide; but a
        // member named `user_id_2` would naturally take the name the disambiguator wants, so the loop
        // must keep incrementing until genuinely unique.
        RustNaming.UniqueBindings(["userID", "userId", "user_id_2"])
            .ShouldBe(["user_id", "user_id_2", "user_id_2_2"]);
    }

    [Fact]
    public void UniqueBindings_stays_keyword_safe_after_suffixing()
    {
        // `match` and `Match` both snake_case to the keyword `match`: the first escapes to `r#match`,
        // the disambiguated second (`match_2`) is no longer a keyword and needs no raw-identifier escape.
        RustNaming.UniqueBindings(["match", "Match"])
            .ShouldBe(["r#match", "match_2"]);
    }
}
