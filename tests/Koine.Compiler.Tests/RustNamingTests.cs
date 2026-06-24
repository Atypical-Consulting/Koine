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
}
