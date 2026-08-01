using Koine.Compiler.Ast;

namespace Koine.Compiler.Tests;

/// <summary>
/// The shared <c>@route</c> template tokenizer (#1748) — extracted from
/// <c>OpenApiEmitter.PathParameters</c> so both <c>Semantics/CqrsValidator</c> and
/// <c>Koine.Emit.Common/RouteDerivation</c> can walk a route template the same way.
/// </summary>
public class RouteTemplateTests
{
    [Fact]
    public void Tokens_extracts_a_single_token() =>
        RouteTemplate.Tokens("/orders/{id}").ShouldBe(["id"]);

    [Fact]
    public void Tokens_preserves_declaration_order() =>
        RouteTemplate.Tokens("/orders/{id}/lines/{lineId}").ShouldBe(["id", "lineId"]);

    [Fact]
    public void Tokens_skips_escaped_literal_braces() =>
        RouteTemplate.Tokens("{{literal}}").ShouldBeEmpty();

    [Fact]
    public void Tokens_returns_none_for_an_unterminated_token() =>
        RouteTemplate.Tokens("/orders/{id").ShouldBeEmpty();

    [Theory]
    [InlineData("/{id:int}", "id")]
    [InlineData("/{id?}", "id")]
    [InlineData("/{*rest}", "rest")]
    [InlineData("/{**rest}", "rest")]
    public void Tokens_strips_AspNetCore_template_syntax_down_to_the_bare_name(string route, string expected) =>
        RouteTemplate.Tokens(route).ShouldBe([expected]);

    [Fact]
    public void Tokens_deduplicates_a_repeated_token_ordinally() =>
        RouteTemplate.Tokens("/orders/{id}/items/{id}").ShouldBe(["id"]);

    [Fact]
    public void Tokens_skips_an_empty_token() =>
        RouteTemplate.Tokens("/orders/{}").ShouldBeEmpty();

    [Theory]
    [InlineData("id", "id")]
    [InlineData("id:int", "id")]
    [InlineData("id?", "id")]
    [InlineData("*rest", "rest")]
    [InlineData("**rest", "rest")]
    public void ParameterName_reduces_a_raw_token_to_its_bare_name(string token, string expected) =>
        RouteTemplate.ParameterName(token).ShouldBe(expected);
}
