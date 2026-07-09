using Koine.Compiler.Ast;

namespace Koine.Compiler.Tests;

/// <summary>
/// The shared, target-agnostic <c>(entity, command|query) -&gt; { verb, route, operationId,
/// requestShape, responseShape }</c> derivation (#1042 / W2.0): both the <c>openapi</c> emitter and the
/// C# <c>api</c> layer must agree on these shapes, so this is the single place the logic is tested,
/// against literal expected strings mirroring <c>OpenApiEmitter.Paths.cs</c>'s pre-refactor behavior.
/// </summary>
public class RouteDerivationTests
{
    private static EntityDecl Order() =>
        new("Order", "OrderId", [], [], [], [], []);

    [Fact]
    public void ForCommand_derives_verb_route_operationId_and_shapes()
    {
        var entity = Order();
        var command = new CommandDecl(
            "Place",
            Parameters: [new Param("total", new TypeRef("Money"))],
            Body: [],
            ReturnType: new TypeRef("Order"));

        var info = RouteDerivation.ForCommand(entity, command);

        info.Verb.ShouldBe("POST");
        info.Route.ShouldBe("/order/place");
        info.OperationId.ShouldBe("Order_Place");
        info.RequestShape.ShouldBeSameAs(command.Parameters);
        info.ResponseShape.ShouldBe(command.ReturnType);
    }

    [Fact]
    public void ForQuery_derives_verb_route_operationId_and_shapes()
    {
        var query = new QueryDecl(
            "OrderById",
            Criteria: [new Param("id", new TypeRef("String"))],
            ResultType: new TypeRef("Order"));

        var info = RouteDerivation.ForQuery(query);

        info.Verb.ShouldBe("GET");
        info.Route.ShouldBe("/order-by-id");
        info.OperationId.ShouldBe("OrderById");
        info.RequestShape.ShouldBeSameAs(query.Criteria);
        info.ResponseShape.ShouldBe(query.ResultType);
    }

    [Theory]
    [InlineData("XMLImport", "xml-import")]
    [InlineData("OrderById", "order-by-id")]
    public void Kebab_splits_on_word_and_acronym_boundaries(string name, string expected) =>
        RouteDerivation.Kebab(name).ShouldBe(expected);

    /// <summary>
    /// A digit immediately before an uppercase letter always started a new word here (pre-#1239), unlike
    /// the per-language <c>ToSnakeCase</c> helpers, which never split there — #1239's extraction preserves
    /// this method's own pre-extraction behavior via <c>IdentifierWords.Split(name, splitAfterDigit:
    /// true)</c> rather than silently converging on the other helpers' behavior.
    /// </summary>
    [Theory]
    [InlineData("Order2Ship", "order2-ship")]
    [InlineData("V2Import", "v2-import")]
    public void Kebab_splits_after_a_digit(string name, string expected) =>
        RouteDerivation.Kebab(name).ShouldBe(expected);
}
