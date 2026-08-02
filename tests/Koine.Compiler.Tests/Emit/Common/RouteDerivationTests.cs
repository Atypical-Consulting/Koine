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

    // ---- @route token resolution (#1748) -------------------------------------

    [Fact]
    public void ForCommand_binds_an_id_token_to_the_aggregate_identity_when_no_parameter_matches()
    {
        var entity = Order();
        var command = new CommandDecl(
            "Submit",
            Parameters: [new Param("note", new TypeRef("String"))],
            Body: [],
            ReturnType: null,
            RouteOverride: "/orders/{id}");

        RouteTokenBinding binding = RouteDerivation.ForCommand(entity, command).TokenBindings.ShouldHaveSingleItem();

        binding.Token.ShouldBe("id");
        binding.Target.ShouldBe(RouteTokenTarget.Identity);
        binding.Member.ShouldBeNull();
        binding.Type.ShouldNotBeNull().Name.ShouldBe("OrderId");
    }

    [Fact]
    public void ForCommand_binds_a_token_to_the_command_parameter_it_names()
    {
        var entity = Order();
        var note = new Param("note", new TypeRef("String"));
        var command = new CommandDecl(
            "Submit",
            Parameters: [note],
            Body: [],
            ReturnType: null,
            RouteOverride: "/orders/{note}");

        RouteTokenBinding binding = RouteDerivation.ForCommand(entity, command).TokenBindings.ShouldHaveSingleItem();

        binding.Token.ShouldBe("note");
        binding.Target.ShouldBe(RouteTokenTarget.Member);
        binding.Member.ShouldBe(note);
        binding.Type.ShouldBe(note.Type);
    }

    [Fact]
    public void ForCommand_leaves_a_token_matching_nothing_unbound()
    {
        var entity = Order();
        var command = new CommandDecl(
            "Submit",
            Parameters: [new Param("note", new TypeRef("String"))],
            Body: [],
            ReturnType: null,
            RouteOverride: "/orders/{ref}");

        RouteTokenBinding binding = RouteDerivation.ForCommand(entity, command).TokenBindings.ShouldHaveSingleItem();

        binding.Token.ShouldBe("ref");
        binding.Target.ShouldBe(RouteTokenTarget.Unbound);
        binding.Member.ShouldBeNull();
        binding.Type.ShouldBeNull();
    }

    /// <summary>A command parameter named <c>id</c> wins over the aggregate-identity fallback — name match comes first.</summary>
    [Fact]
    public void ForCommand_prefers_a_matching_parameter_named_id_over_the_identity_fallback()
    {
        var entity = Order();
        var id = new Param("id", new TypeRef("String"));
        var command = new CommandDecl(
            "Submit",
            Parameters: [id],
            Body: [],
            ReturnType: null,
            RouteOverride: "/orders/{id}");

        RouteTokenBinding binding = RouteDerivation.ForCommand(entity, command).TokenBindings.ShouldHaveSingleItem();

        binding.Target.ShouldBe(RouteTokenTarget.Member);
        binding.Member.ShouldBe(id);
    }

    /// <summary>Route tokens match a parameter name case-insensitively, mirroring ASP.NET's own route-value binding.</summary>
    [Fact]
    public void ForCommand_matches_a_token_to_a_parameter_ordinal_ignore_case()
    {
        var entity = Order();
        var note = new Param("note", new TypeRef("String"));
        var command = new CommandDecl(
            "Submit",
            Parameters: [note],
            Body: [],
            ReturnType: null,
            RouteOverride: "/orders/{NOTE}");

        RouteTokenBinding binding = RouteDerivation.ForCommand(entity, command).TokenBindings.ShouldHaveSingleItem();

        binding.Target.ShouldBe(RouteTokenTarget.Member);
        binding.Member.ShouldBe(note);
    }

    /// <summary>A query has no aggregate identity to fall back to: an <c>id</c> token with no matching criterion is unbound.</summary>
    [Fact]
    public void ForQuery_never_resolves_a_token_to_an_identity()
    {
        var query = new QueryDecl(
            "OrderById",
            Criteria: [],
            ResultType: new TypeRef("Order"),
            RouteOverride: "/orders/{id}");

        RouteTokenBinding binding = RouteDerivation.ForQuery(query).TokenBindings.ShouldHaveSingleItem();

        binding.Target.ShouldBe(RouteTokenTarget.Unbound);
    }

    [Fact]
    public void ForQuery_binds_a_token_to_the_criterion_it_names()
    {
        var id = new Param("id", new TypeRef("OrderId"));
        var query = new QueryDecl(
            "OrderById",
            Criteria: [id],
            ResultType: new TypeRef("Order"),
            RouteOverride: "/orders/{id}");

        RouteTokenBinding binding = RouteDerivation.ForQuery(query).TokenBindings.ShouldHaveSingleItem();

        binding.Target.ShouldBe(RouteTokenTarget.Member);
        binding.Member.ShouldBe(id);
    }

    /// <summary>A conventional (unannotated) route carries no <c>{token}</c>s, so it resolves no bindings at all.</summary>
    [Fact]
    public void A_conventional_route_has_no_token_bindings()
    {
        var entity = Order();
        var command = new CommandDecl("Place", Parameters: [new Param("total", new TypeRef("Money"))], Body: [], ReturnType: null);

        RouteDerivation.ForCommand(entity, command).TokenBindings.ShouldBeEmpty();

        var query = new QueryDecl("OrderById", Criteria: [new Param("id", new TypeRef("OrderId"))], ResultType: new TypeRef("Order"));
        RouteDerivation.ForQuery(query).TokenBindings.ShouldBeEmpty();
    }

    // ---- ForFactory (#1747) ---------------------------------------------------

    /// <summary>A factory → <c>POST /{entity}/{factory}</c>, its parameters the request body, the created
    /// aggregate the response — the conventional shape <c>WriteFactoryEndpoint</c> and the <c>openapi</c>
    /// emitter both read (#1747).</summary>
    [Fact]
    public void ForFactory_derives_verb_route_operationId_and_shapes()
    {
        var entity = Order();
        var factory = new FactoryDecl("Open", Parameters: [new Param("customer", new TypeRef("CustomerId"))], Body: []);

        var info = RouteDerivation.ForFactory(entity, factory);

        info.Verb.ShouldBe("POST");
        info.Route.ShouldBe("/order/open");
        info.OperationId.ShouldBe("Order_Open");
        info.RequestShape.ShouldBeSameAs(factory.Parameters);
        info.ResponseShape.ShouldBe(new TypeRef(entity.Name));
        info.AuthRole.ShouldBeNull();
    }

    /// <summary>Multi-word entity and factory names both kebab, exactly like a command's (#1042).</summary>
    [Fact]
    public void ForFactory_kebabs_multi_word_entity_and_factory_names()
    {
        var entity = new EntityDecl("OrderLine", "OrderLineId", [], [], [], [], []);
        var factory = new FactoryDecl("OpenDraft", Parameters: [], Body: []);

        var info = RouteDerivation.ForFactory(entity, factory);

        info.Route.ShouldBe("/order-line/open-draft");
        info.OperationId.ShouldBe("OrderLine_OpenDraft");
    }

    /// <summary>A no-argument factory still derives a valid (empty) request shape.</summary>
    [Fact]
    public void ForFactory_with_no_parameters_has_an_empty_request_shape()
    {
        var entity = Order();
        var factory = new FactoryDecl("Open", Parameters: [], Body: []);

        RouteDerivation.ForFactory(entity, factory).RequestShape.ShouldBeEmpty();
    }

    /// <summary>An unannotated factory's conventional route has no tokens, so nothing to resolve.</summary>
    [Fact]
    public void ForFactory_resolves_no_token_bindings()
    {
        var entity = Order();
        var factory = new FactoryDecl("Open", Parameters: [], Body: []);

        RouteDerivation.ForFactory(entity, factory).TokenBindings.ShouldBeEmpty();
    }

    // ---- ForFactory honors R19 annotations (#1846) ----------------------------

    /// <summary>All three override axes reach a factory's <see cref="RouteInfo"/> at once, exactly as
    /// <see cref="ForCommand_honors_route_verb_and_auth_overrides"/> pins for a command (#1846).</summary>
    [Fact]
    public void ForFactory_honors_route_verb_and_auth_overrides()
    {
        var entity = Order();
        var factory = new FactoryDecl(
            "Open",
            Parameters: [new Param("customer", new TypeRef("CustomerId"))],
            Body: [],
            RouteOverride: "/orders",
            VerbOverride: "PUT",
            AuthRole: "admin");

        var info = RouteDerivation.ForFactory(entity, factory);

        info.Verb.ShouldBe("PUT");
        info.Route.ShouldBe("/orders");
        info.AuthRole.ShouldBe("admin");
        info.OperationId.ShouldBe("Order_Open");
        info.RequestShape.ShouldBeSameAs(factory.Parameters);
        // The response is still the created aggregate — @route never redefines what a factory returns.
        info.ResponseShape.ShouldBe(new TypeRef(entity.Name));
    }

    /// <summary>
    /// Each axis falls back to the convention on its own — annotating the route leaves the verb at
    /// <c>POST</c>, annotating the verb leaves the conventional path, and <c>@auth</c> moves neither.
    /// </summary>
    [Theory]
    [InlineData(null, null, null, "POST", "/order/open", null)]
    [InlineData("/orders", null, null, "POST", "/orders", null)]
    [InlineData(null, "PUT", null, "PUT", "/order/open", null)]
    [InlineData(null, null, "admin", "POST", "/order/open", "admin")]
    [InlineData("/orders", "PATCH", "admin", "PATCH", "/orders", "admin")]
    public void ForFactory_applies_each_override_axis_independently(
        string? routeOverride,
        string? verbOverride,
        string? authRole,
        string expectedVerb,
        string expectedRoute,
        string? expectedAuthRole)
    {
        var factory = new FactoryDecl(
            "Open",
            Parameters: [],
            Body: [],
            RouteOverride: routeOverride,
            VerbOverride: verbOverride,
            AuthRole: authRole);

        var info = RouteDerivation.ForFactory(Order(), factory);

        info.Verb.ShouldBe(expectedVerb);
        info.Route.ShouldBe(expectedRoute);
        info.AuthRole.ShouldBe(expectedAuthRole);
    }

    /// <summary>An annotated factory's <c>{token}</c> binds to the parameter of that name, exactly as a
    /// command's does — the token machinery (#1748) needed no change to serve factories.</summary>
    [Fact]
    public void ForFactory_binds_a_route_token_to_a_matching_parameter()
    {
        var factory = new FactoryDecl(
            "Open",
            Parameters: [new Param("customer", new TypeRef("CustomerId"))],
            Body: [],
            RouteOverride: "/orders/{customer}");

        RouteTokenBinding binding = RouteDerivation.ForFactory(Order(), factory).TokenBindings.ShouldHaveSingleItem();

        binding.Token.ShouldBe("customer");
        binding.Target.ShouldBe(RouteTokenTarget.Member);
        binding.Member!.Name.ShouldBe("customer");
        binding.Type.ShouldBe(new TypeRef("CustomerId"));
    }

    /// <summary>
    /// The one place a factory deliberately DIVERGES from a command: an <c>{id}</c> token with no
    /// matching parameter is <see cref="RouteTokenTarget.Unbound"/>, not
    /// <see cref="RouteTokenTarget.Identity"/>. A factory mints its identity, so its emitted request
    /// record has no identity property to rebind — an <c>Identity</c> binding would emit uncompilable
    /// C#. <c>Semantics/</c> warns (KOI1215) on exactly this shape, so the two layers agree.
    /// </summary>
    [Fact]
    public void ForFactory_leaves_an_id_token_unbound_because_a_factory_mints_its_identity()
    {
        var factory = new FactoryDecl("Open", Parameters: [], Body: [], RouteOverride: "/orders/{id}");

        RouteTokenBinding binding = RouteDerivation.ForFactory(Order(), factory).TokenBindings.ShouldHaveSingleItem();

        binding.Target.ShouldBe(RouteTokenTarget.Unbound);
        binding.Member.ShouldBeNull();
        binding.Type.ShouldBeNull();

        // The very same route on a COMMAND does bind to the aggregate identity — the divergence is real,
        // not an accident of this fixture.
        var command = new CommandDecl("Place", Parameters: [], Body: [], RouteOverride: "/orders/{id}");
        RouteDerivation.ForCommand(Order(), command).TokenBindings.ShouldHaveSingleItem()
            .Target.ShouldBe(RouteTokenTarget.Identity);
    }

    /// <summary>A factory that DOES declare an <c>id</c> parameter (the explicit-id opt-in for a
    /// non-Guid identity, #324) binds <c>{id}</c> by ordinary name-match.</summary>
    [Fact]
    public void ForFactory_binds_an_id_token_to_an_explicit_id_parameter()
    {
        var factory = new FactoryDecl(
            "Open",
            Parameters: [new Param("id", new TypeRef("OrderId"))],
            Body: [],
            RouteOverride: "/orders/{id}");

        RouteTokenBinding binding = RouteDerivation.ForFactory(Order(), factory).TokenBindings.ShouldHaveSingleItem();

        binding.Target.ShouldBe(RouteTokenTarget.Member);
        binding.Type.ShouldBe(new TypeRef("OrderId"));
    }
}
