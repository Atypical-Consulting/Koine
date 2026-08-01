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

    /// <summary>
    /// R19 (#1219): <c>@route</c>/<c>@get|@post|…</c>/<c>@auth</c> on a command replace the conventional
    /// verb and path verbatim and carry the required role through, while the operation id and the
    /// request/response shapes stay conventional — an annotation retargets the HTTP surface, not the model.
    /// </summary>
    [Fact]
    public void ForCommand_honors_route_verb_and_auth_overrides()
    {
        var entity = Order();
        var command = new CommandDecl(
            "Place",
            Parameters: [new Param("total", new TypeRef("Money"))],
            Body: [],
            ReturnType: new TypeRef("Order"),
            RouteOverride: "/orders/{id}",
            VerbOverride: "PUT",
            AuthRole: "admin");

        var info = RouteDerivation.ForCommand(entity, command);

        info.Verb.ShouldBe("PUT");
        info.Route.ShouldBe("/orders/{id}");
        info.AuthRole.ShouldBe("admin");
        info.OperationId.ShouldBe("Order_Place");
        info.RequestShape.ShouldBeSameAs(command.Parameters);
        info.ResponseShape.ShouldBe(command.ReturnType);
    }

    /// <summary>
    /// Non-regression for the overwhelming majority of models, which carry no annotation at all: an
    /// un-annotated command must derive exactly the pre-#1219 <c>POST /{entity}/{command}</c> shape, with
    /// no role.
    /// </summary>
    [Fact]
    public void ForCommand_without_annotations_keeps_the_conventional_shape()
    {
        var entity = Order();
        var command = new CommandDecl(
            "Place",
            Parameters: [new Param("total", new TypeRef("Money"))],
            Body: [],
            ReturnType: new TypeRef("Order"),
            RouteOverride: null,
            VerbOverride: null,
            AuthRole: null);

        var info = RouteDerivation.ForCommand(entity, command);

        info.Verb.ShouldBe("POST");
        info.Route.ShouldBe("/order/place");
        info.AuthRole.ShouldBeNull();
    }

    /// <summary>
    /// The three annotation axes are independent (#1219, assumption 1): overriding the route leaves the
    /// verb conventional, overriding the verb leaves the route conventional, and <c>@auth</c> alone
    /// touches neither.
    /// </summary>
    [Theory]
    [InlineData("/orders/{id}", null, null, "POST", "/orders/{id}", null)]
    [InlineData(null, "PUT", null, "PUT", "/order/place", null)]
    [InlineData(null, null, "admin", "POST", "/order/place", "admin")]
    [InlineData("/orders/{id}", "PUT", null, "PUT", "/orders/{id}", null)]
    public void ForCommand_applies_each_override_axis_independently(
        string? routeOverride,
        string? verbOverride,
        string? authRole,
        string expectedVerb,
        string expectedRoute,
        string? expectedAuthRole)
    {
        var command = new CommandDecl(
            "Place",
            Parameters: [],
            Body: [],
            ReturnType: null,
            RouteOverride: routeOverride,
            VerbOverride: verbOverride,
            AuthRole: authRole);

        var info = RouteDerivation.ForCommand(Order(), command);

        info.Verb.ShouldBe(expectedVerb);
        info.Route.ShouldBe(expectedRoute);
        info.AuthRole.ShouldBe(expectedAuthRole);
    }

    /// <summary>
    /// The query side mirrors the command side (#1219): the annotations replace the conventional
    /// <c>GET /{query}</c>, leaving the operation id and the criteria/result shapes alone.
    /// </summary>
    [Fact]
    public void ForQuery_honors_route_verb_and_auth_overrides()
    {
        var query = new QueryDecl(
            "OrderById",
            Criteria: [new Param("id", new TypeRef("String"))],
            ResultType: new TypeRef("Order"),
            RouteOverride: "/orders/{id}",
            VerbOverride: "POST",
            AuthRole: "support");

        var info = RouteDerivation.ForQuery(query);

        info.Verb.ShouldBe("POST");
        info.Route.ShouldBe("/orders/{id}");
        info.AuthRole.ShouldBe("support");
        info.OperationId.ShouldBe("OrderById");
        info.RequestShape.ShouldBeSameAs(query.Criteria);
        info.ResponseShape.ShouldBe(query.ResultType);
    }

    /// <summary>Non-regression: an un-annotated query keeps the pre-#1219 <c>GET /{query}</c> shape.</summary>
    [Fact]
    public void ForQuery_without_annotations_keeps_the_conventional_shape()
    {
        var query = new QueryDecl(
            "OrderById",
            Criteria: [new Param("id", new TypeRef("String"))],
            ResultType: new TypeRef("Order"),
            RouteOverride: null,
            VerbOverride: null,
            AuthRole: null);

        var info = RouteDerivation.ForQuery(query);

        info.Verb.ShouldBe("GET");
        info.Route.ShouldBe("/order-by-id");
        info.AuthRole.ShouldBeNull();
    }

    /// <summary>The three axes are independent on the query side too (#1219, assumption 1).</summary>
    [Theory]
    [InlineData("/orders/{id}", null, null, "GET", "/orders/{id}", null)]
    [InlineData(null, "POST", null, "POST", "/order-by-id", null)]
    [InlineData(null, null, "support", "GET", "/order-by-id", "support")]
    [InlineData("/orders/{id}", "POST", null, "POST", "/orders/{id}", null)]
    public void ForQuery_applies_each_override_axis_independently(
        string? routeOverride,
        string? verbOverride,
        string? authRole,
        string expectedVerb,
        string expectedRoute,
        string? expectedAuthRole)
    {
        var query = new QueryDecl(
            "OrderById",
            Criteria: [],
            ResultType: new TypeRef("Order"),
            RouteOverride: routeOverride,
            VerbOverride: verbOverride,
            AuthRole: authRole);

        var info = RouteDerivation.ForQuery(query);

        info.Verb.ShouldBe(expectedVerb);
        info.Route.ShouldBe(expectedRoute);
        info.AuthRole.ShouldBe(expectedAuthRole);
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
