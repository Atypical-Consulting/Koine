using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>Epic R19 — API annotations (@route / @get / @put / @auth) on commands and queries.</summary>
public class R19ApiAnnotationsTests
{
    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

    private static ContextNode Context(string source)
    {
        (KoineModel? model, IReadOnlyList<Diagnostic> diagnostics) = new KoineCompiler().Parse(source);
        model.ShouldNotBeNull(string.Join("\n", diagnostics.Select(d => d.ToString())));
        return model!.Contexts.Single();
    }

    private static CommandDecl CommandOf(string source, string entity, string command) =>
        Context(source).AllEntities().Single(e => e.Name == entity).Commands.Single(c => c.Name == command);

    private static QueryDecl QueryOf(string source, string query) =>
        Context(source).AllTypeDecls().OfType<QueryDecl>().Single(q => q.Name == query);

    private static FactoryDecl FactoryOf(string source, string entity, string factory) =>
        Context(source).AllEntities().Single(e => e.Name == entity).Factories.Single(f => f.Name == factory);

    private static IReadOnlyList<Emit.EmittedFile> Build(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return result.Files;
    }

    // ---- parsing ------------------------------------------------------------

    [Fact]
    public void Annotations_on_a_command_parse_and_compile()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{id}/place")
                  @put
                  command place {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }
                }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        Build(src);
    }

    [Fact]
    public void Annotations_on_a_query_parse_and_compile()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              @auth("admin")
              @get
              query OrderById(id: OrderId): OrderSummary
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        Build(src);
    }

    /// <summary>
    /// A <c>create</c> factory carries the very same annotation vocabulary (#1846) — the grammar's
    /// <c>annotation*</c> prefix now sits on <c>factoryDecl</c> too, so this parses clean and the emitted
    /// C# still compiles.
    /// </summary>
    [Fact]
    public void Annotations_on_a_factory_parse_and_compile()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders")
                  @post
                  @auth("admin")
                  create open {
                  }
                }
              }
            }
            """;
        Diagnose(src).ShouldBeEmpty();
        Build(src);
    }

    // ---- the annotations reach the semantic model ---------------------------

    /// <summary>
    /// A command source carrying <paramref name="annotations"/> (one per line, from line 7) ahead of
    /// <c>command place</c> on line 7 + <c>annotations.Length</c>.
    /// </summary>
    private static string CommandSource(params string[] annotations)
    {
        var block = string.Join("\n      ", annotations);
        return $$"""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  {{block}}
                  command place {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }
                }
              }
            }
            """;
    }

    /// <summary>A query source carrying <paramref name="annotations"/> (one per line) ahead of <c>query OrderById</c>.</summary>
    private static string QuerySource(params string[] annotations)
    {
        var block = string.Join("\n  ", annotations);
        return $$"""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              {{block}}
              query OrderById(id: OrderId): OrderSummary
            }
            """;
    }

    /// <summary>
    /// A factory source carrying <paramref name="annotations"/> ahead of <c>create open</c> (#1846).
    /// Deliberately line-for-line congruent with <see cref="CommandSource"/> — same six-line preamble, so
    /// the first annotation always sits on line 7 and a factory diagnostic's line assertion reads exactly
    /// like its command counterpart's.
    /// </summary>
    private static string FactorySource(params string[] annotations)
    {
        var block = string.Join("\n      ", annotations);
        return $$"""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  {{block}}
                  create open {
                  }
                }
              }
            }
            """;
    }

    [Fact]
    public void Route_and_verb_annotations_land_on_the_command()
    {
        CommandDecl place = CommandOf(
            CommandSource("""@route("/orders/{id}")""", "@put"), "Order", "place");

        place.RouteOverride.ShouldBe("/orders/{id}");
        place.VerbOverride.ShouldBe("PUT");
        place.AuthRole.ShouldBeNull();
    }

    [Fact]
    public void Auth_annotation_lands_on_the_query()
    {
        QueryDecl byId = QueryOf(QuerySource("""@auth("admin")"""), "OrderById");

        byId.AuthRole.ShouldBe("admin");
        byId.RouteOverride.ShouldBeNull();
        byId.VerbOverride.ShouldBeNull();
    }

    [Fact]
    public void Route_and_auth_annotations_land_on_the_query()
    {
        QueryDecl byId = QueryOf(
            QuerySource("""@route("/orders/summary")""", "@get", """@auth("reader")"""), "OrderById");

        byId.RouteOverride.ShouldBe("/orders/summary");
        byId.VerbOverride.ShouldBe("GET");
        byId.AuthRole.ShouldBe("reader");
    }

    /// <summary>Each verb annotation is stored as its uppercased HTTP method — a plain string, no framework type.</summary>
    [Theory]
    [InlineData("get", "GET")]
    [InlineData("post", "POST")]
    [InlineData("put", "PUT")]
    [InlineData("delete", "DELETE")]
    [InlineData("patch", "PATCH")]
    public void Every_verb_annotation_is_uppercased(string annotation, string expected) =>
        CommandOf(CommandSource($"@{annotation}"), "Order", "place").VerbOverride.ShouldBe(expected);

    [Fact]
    public void An_unannotated_command_and_query_carry_no_api_overrides()
    {
        CommandDecl place = CommandOf(CommandSource(), "Order", "place");
        place.RouteOverride.ShouldBeNull();
        place.VerbOverride.ShouldBeNull();
        place.AuthRole.ShouldBeNull();
        place.ApiAnnotations.ShouldBeNull();

        QueryDecl byId = QueryOf(QuerySource(), "OrderById");
        byId.RouteOverride.ShouldBeNull();
        byId.VerbOverride.ShouldBeNull();
        byId.AuthRole.ShouldBeNull();
        byId.ApiAnnotations.ShouldBeNull();

        FactoryDecl open = FactoryOf(FactorySource(), "Order", "open");
        open.RouteOverride.ShouldBeNull();
        open.VerbOverride.ShouldBeNull();
        open.AuthRole.ShouldBeNull();
        open.ApiAnnotations.ShouldBeNull();
    }

    /// <summary>
    /// All three axes reach a <c>FactoryDecl</c> (#1846) exactly as they reach a
    /// <see cref="CommandDecl"/> — same field names, same uppercased verb, same raw route string.
    /// </summary>
    [Fact]
    public void Route_verb_and_auth_annotations_land_on_the_factory()
    {
        FactoryDecl open = FactoryOf(
            FactorySource("""@route("/orders")""", "@put", """@auth("admin")"""), "Order", "open");

        open.RouteOverride.ShouldBe("/orders");
        open.VerbOverride.ShouldBe("PUT");
        open.AuthRole.ShouldBe("admin");
    }

    /// <summary>The three axes are independent on a factory too — annotating one leaves the others null.</summary>
    [Theory]
    [InlineData("""@route("/orders")""", "/orders", null, null)]
    [InlineData("@delete", null, "DELETE", null)]
    [InlineData("""@auth("admin")""", null, null, "admin")]
    public void Each_factory_annotation_axis_lands_independently(
        string annotation, string? route, string? verb, string? auth)
    {
        FactoryDecl open = FactoryOf(FactorySource(annotation), "Order", "open");

        open.RouteOverride.ShouldBe(route);
        open.VerbOverride.ShouldBe(verb);
        open.AuthRole.ShouldBe(auth);
    }

    /// <summary>An unknown annotation name is ignored, exactly as <c>@since</c>/<c>@deprecated</c> reading does.</summary>
    [Fact]
    public void An_unknown_annotation_is_ignored()
    {
        CommandDecl place = CommandOf(CommandSource("""@nonsense("x")"""), "Order", "place");

        place.RouteOverride.ShouldBeNull();
        place.VerbOverride.ShouldBeNull();
        place.AuthRole.ShouldBeNull();
        place.ApiAnnotations.ShouldBeNull();
    }

    // ---- what Semantics/ needs to validate these (the parser never rejects) --

    /// <summary>
    /// Two verb annotations parse cleanly — rejecting them is <c>Semantics/</c>'s job — but the
    /// multiplicity must survive into the model, so <see cref="ApiAnnotationInfo.VerbCount"/>
    /// records it rather than the reader silently collapsing to "last one wins".
    /// </summary>
    [Fact]
    public void Multiple_verb_annotations_are_counted_for_the_validator()
    {
        CommandDecl place = CommandOf(CommandSource("@get", "@post"), "Order", "place");

        place.VerbOverride.ShouldBe("POST");
        place.ApiAnnotations.ShouldNotBeNull().VerbCount.ShouldBe(2);
    }

    /// <summary>Each annotation carries its own span so a diagnostic points at it, not at the whole declaration.</summary>
    [Fact]
    public void Each_api_annotation_carries_its_own_span()
    {
        CommandDecl place = CommandOf(
            CommandSource("""@route("/orders/{id}")""", "@put", """@auth("admin")"""), "Order", "place");

        ApiAnnotationInfo api = place.ApiAnnotations.ShouldNotBeNull();
        api.VerbCount.ShouldBe(1);
        api.RouteSpan.Line.ShouldBe(7);
        api.VerbSpan.Line.ShouldBe(8);
        api.AuthSpan.Line.ShouldBe(9);
        api.RouteSpan.Column.ShouldBeGreaterThan(0);
        api.RouteSpan.Length.ShouldBe(@"@route(""/orders/{id}"")".Length);

        // The declaration's own span still covers the annotations plus the command (grammar: `annotation* COMMAND …`).
        place.Span.Line.ShouldBe(7);
    }

    /// <summary>A query's annotation spans are populated the same way a command's are.</summary>
    [Fact]
    public void A_querys_api_annotations_carry_spans_too()
    {
        QueryDecl byId = QueryOf(QuerySource("""@auth("admin")"""), "OrderById");

        ApiAnnotationInfo api = byId.ApiAnnotations.ShouldNotBeNull();
        api.VerbCount.ShouldBe(0);
        api.RouteSpan.IsNone.ShouldBeTrue();
        api.VerbSpan.IsNone.ShouldBeTrue();
        api.AuthSpan.IsNone.ShouldBeFalse();
    }

    // ---- validation ---------------------------------------------------------

    /// <summary>A route override is a path template: it must be absolute, so a relative one is rejected.</summary>
    [Fact]
    public void A_route_override_without_a_leading_slash_is_rejected_on_a_command() =>
        Diagnose(CommandSource("""@route("orders")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);

    [Fact]
    public void A_route_override_without_a_leading_slash_is_rejected_on_a_query() =>
        Diagnose(QuerySource("""@route("orders")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);

    /// <summary>An empty path is no more absolute than a relative one.</summary>
    [Fact]
    public void An_empty_route_override_is_rejected() =>
        Diagnose(CommandSource("""@route("")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);

    /// <summary>
    /// A bare <c>@route</c> names no path at all, so it can only be a mistake — the parser keeps its
    /// span precisely so this is diagnosable rather than silently ignored.
    /// </summary>
    [Fact]
    public void An_argument_less_route_annotation_is_rejected() =>
        Diagnose(CommandSource("@route"))
            .ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);

    /// <summary>One declaration maps to one endpoint, so it may carry at most one verb.</summary>
    [Fact]
    public void Two_verb_annotations_are_rejected_on_a_command() =>
        Diagnose(CommandSource("@get", "@post"))
            .ShouldContain(d => d.Code == DiagnosticCodes.MultipleVerbAnnotations);

    [Fact]
    public void Two_verb_annotations_are_rejected_on_a_query() =>
        Diagnose(QuerySource("@get", "@post"))
            .ShouldContain(d => d.Code == DiagnosticCodes.MultipleVerbAnnotations);

    /// <summary>Repeating the same verb is still two annotations, and still a mistake.</summary>
    [Fact]
    public void The_same_verb_annotated_twice_is_rejected() =>
        Diagnose(CommandSource("@put", "@put"))
            .ShouldContain(d => d.Code == DiagnosticCodes.MultipleVerbAnnotations);

    /// <summary>A role that is blank guards nothing, so it is rejected rather than emitted as-is.</summary>
    [Fact]
    public void A_whitespace_only_auth_role_is_rejected_on_a_command() =>
        Diagnose(CommandSource("""@auth("   ")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.EmptyAuthRole);

    [Fact]
    public void A_whitespace_only_auth_role_is_rejected_on_a_query() =>
        Diagnose(QuerySource("""@auth("   ")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.EmptyAuthRole);

    /// <summary>A bare <c>@auth</c> names no role — same reasoning as a bare <c>@route</c>.</summary>
    [Fact]
    public void An_argument_less_auth_annotation_is_rejected() =>
        Diagnose(QuerySource("@auth"))
            .ShouldContain(d => d.Code == DiagnosticCodes.EmptyAuthRole);

    /// <summary>The diagnostic points at the offending annotation, not at the whole declaration.</summary>
    [Fact]
    public void Each_api_diagnostic_points_at_its_own_annotation()
    {
        // Annotations start on line 7 (see CommandSource): @route, then @get, @post, then @auth.
        IReadOnlyList<Diagnostic> diagnostics =
            Diagnose(CommandSource("""@route("orders")""", "@get", "@post", """@auth(" ")"""));

        diagnostics.Single(d => d.Code == DiagnosticCodes.InvalidRouteOverride).Line.ShouldBe(7);
        diagnostics.Single(d => d.Code == DiagnosticCodes.MultipleVerbAnnotations).Line.ShouldBe(9);
        diagnostics.Single(d => d.Code == DiagnosticCodes.EmptyAuthRole).Line.ShouldBe(10);
    }

    /// <summary>Non-regression: a well-formed annotation set is silent on both a command and a query.</summary>
    [Fact]
    public void A_valid_route_verb_and_auth_produce_no_diagnostics()
    {
        Diagnose(CommandSource("""@route("/orders/{id}")""", "@put", """@auth("admin")"""))
            .ShouldBeEmpty();
        Diagnose(QuerySource("""@route("/orders/{id}")""", "@get", """@auth("admin")"""))
            .ShouldBeEmpty();
    }

    /// <summary>Non-regression: an unannotated command/query is never touched by the API checks.</summary>
    [Fact]
    public void An_unannotated_command_and_query_produce_no_api_diagnostics()
    {
        Diagnose(CommandSource()).ShouldBeEmpty();
        Diagnose(QuerySource()).ShouldBeEmpty();
    }

    // ---- route templates beyond the leading slash (#1219 review) ------------

    /// <summary>
    /// A route override is pasted verbatim into the host's route table, so a malformed template is not
    /// a cosmetic problem: it compiles (a bad template is still a valid string literal) and then throws
    /// <c>RoutePatternException</c> when the host builds its routes. Every shape ASP.NET's route parser
    /// rejects has to be rejected here instead, at compile time.
    /// </summary>
    [Theory]
    [InlineData("/orders/{id", "unclosed")]
    [InlineData("/orders/id}", "unopened")]
    [InlineData("/orders/{a{b}}", "nested")]
    [InlineData("/orders/{}", "empty parameter")]
    [InlineData("/orders/{id}/{", "unclosed after a valid parameter")]
    public void A_malformed_route_template_is_rejected(string route, string why) =>
        Diagnose(CommandSource($"""@route("{route}")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride, $"expected a KOI1208 for the {why} route '{route}'");

    /// <summary>A path with a space or a tab cannot be typed into a URL as written, so it is a mistake.</summary>
    [Theory]
    [InlineData("/orders/place order")]
    [InlineData("/orders/\\tplace")]
    public void A_route_template_containing_whitespace_is_rejected(string route) =>
        Diagnose(CommandSource($"""@route("{route}")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);

    /// <summary>The message names the rule that failed, not just "invalid" — the author has to know why.</summary>
    [Fact]
    public void A_malformed_route_diagnostic_names_the_rule_that_failed()
    {
        Diagnose(CommandSource("""@route("/orders/{id")"""))
            .Single(d => d.Code == DiagnosticCodes.InvalidRouteOverride)
            .Message.ShouldContain("unclosed");

        Diagnose(CommandSource("""@route("/orders/{}")"""))
            .Single(d => d.Code == DiagnosticCodes.InvalidRouteOverride)
            .Message.ShouldContain("empty route parameter");
    }

    /// <summary>
    /// Non-regression, and the reason the check cannot be a naive brace count: constraints, optional and
    /// catch-all parameters, and the <c>{{</c>/<c>}}</c> escape for a literal brace are all legal
    /// templates that the routing stack accepts, so none of them may be diagnosed as KOI1208. Some of
    /// these ARE unbound tokens under KOI1215 (#1748 — <c>rest</c>/<c>lineId</c> name nothing on
    /// <see cref="CommandSource"/>'s parameter-less <c>place</c> command); this test only pins the
    /// well-formedness check, so it filters to that one code.
    /// </summary>
    [Theory]
    [InlineData("/orders/{id}")]
    [InlineData("/orders/{id:int}")]
    [InlineData("/orders/{id?}")]
    [InlineData("/orders/{*rest}")]
    [InlineData("/orders/{{id}}")]
    [InlineData("/orders/{id}/lines/{lineId}")]
    [InlineData("/")]
    public void A_well_formed_route_template_is_accepted(string route) =>
        Diagnose(CommandSource($"""@route("{route}")"""))
            .ShouldNotContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);

    // ---- KOI1215: an unbound route token (#1748) -----------------------------

    /// <summary>A token naming neither a parameter nor (via the <c>id</c> fallback) the aggregate
    /// identity is decorative — KOI1215 warns exactly once, on the <c>@route</c> annotation's span.</summary>
    [Fact]
    public void A_token_naming_nothing_on_a_command_is_a_KOI1215_warning()
    {
        Diagnostic warning = Diagnose(CommandSource("""@route("/orders/{ref}")"""))
            .ShouldHaveSingleItem();

        warning.Code.ShouldBe(DiagnosticCodes.UnboundRouteToken);
        warning.Severity.ShouldBe(DiagnosticSeverity.Warning);
        warning.Line.ShouldBe(7);
        warning.Message.ShouldContain("{ref}");
    }

    /// <summary>Non-regression: <c>id</c> resolves via the aggregate-identity fallback, so it is never flagged.</summary>
    [Fact]
    public void An_id_token_on_a_command_is_not_flagged() =>
        Diagnose(CommandSource("""@route("/orders/{id}")""")).ShouldBeEmpty();

    /// <summary>Non-regression: a token that names a real command parameter is never flagged.</summary>
    [Fact]
    public void A_token_naming_a_real_parameter_is_not_flagged()
    {
        const string src = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{note}")
                  command place(note: String) {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }
                }
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();
    }

    /// <summary>A query has no identity fallback: a token naming no criterion is always unbound.</summary>
    [Fact]
    public void A_token_naming_no_criterion_on_a_query_is_a_KOI1215_warning() =>
        Diagnose(QuerySource("""@route("/orders/{ref}")"""))
            .ShouldHaveSingleItem().Code.ShouldBe(DiagnosticCodes.UnboundRouteToken);

    /// <summary>A two-token route reports only the token that actually fails to bind.</summary>
    [Fact]
    public void A_two_token_route_with_one_bad_token_reports_exactly_one_warning()
    {
        Diagnostic warning = Diagnose(CommandSource("""@route("/orders/{id}/lines/{lineId}")"""))
            .ShouldHaveSingleItem();

        warning.Code.ShouldBe(DiagnosticCodes.UnboundRouteToken);
        warning.Message.ShouldContain("{lineId}");
    }

    // ---- each annotation is single-valued (#1219 review) --------------------

    /// <summary>
    /// <c>@route</c> is single-valued: repeating it kept the last silently, which is exactly the
    /// "silently dropped" outcome the reader's contract promises not to allow.
    /// </summary>
    [Fact]
    public void Two_route_annotations_are_rejected()
    {
        CommandDecl place = CommandOf(CommandSource("""@route("/first")""", """@route("/second")"""), "Order", "place");
        place.RouteOverride.ShouldBe("/second");
        place.ApiAnnotations.ShouldNotBeNull().RouteCount.ShouldBe(2);

        Diagnose(CommandSource("""@route("/first")""", """@route("/second")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation);
    }

    /// <summary>
    /// A bare <c>@route</c> alone is a KOI1208 error, so a bare one followed by a valid one must not
    /// compile clean — that would make the malformed annotation disappear precisely because a second
    /// one happened to follow it.
    /// </summary>
    [Fact]
    public void A_bare_route_annotation_followed_by_a_valid_one_is_still_rejected() =>
        Diagnose(CommandSource("@route", """@route("/first")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation);

    [Fact]
    public void Two_auth_annotations_are_rejected_on_a_command()
    {
        CommandDecl place = CommandOf(CommandSource("""@auth("a")""", """@auth("b")"""), "Order", "place");
        place.AuthRole.ShouldBe("b");
        place.ApiAnnotations.ShouldNotBeNull().AuthCount.ShouldBe(2);

        Diagnose(CommandSource("""@auth("a")""", """@auth("b")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation);
    }

    [Fact]
    public void Two_auth_annotations_are_rejected_on_a_query() =>
        Diagnose(QuerySource("""@auth("a")""", """@auth("b")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation);

    /// <summary>Non-regression: one of each is the normal case and stays silent.</summary>
    [Fact]
    public void One_route_and_one_auth_annotation_are_not_reported_as_duplicates()
    {
        Diagnose(CommandSource("""@route("/orders")""", """@auth("admin")"""))
            .ShouldNotContain(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation);

        CommandDecl place = CommandOf(CommandSource("""@route("/orders")""", """@auth("admin")"""), "Order", "place");
        ApiAnnotationInfo api = place.ApiAnnotations.ShouldNotBeNull();
        api.RouteCount.ShouldBe(1);
        api.AuthCount.ShouldBe(1);
    }

    /// <summary>A duplicate is reported on its own annotation, and repeating a verb still reports KOI1209.</summary>
    [Fact]
    public void A_duplicate_annotation_is_reported_at_the_repeated_annotation()
    {
        // Annotations start on line 7 (see CommandSource): @route, @route, @auth, @auth.
        IReadOnlyList<Diagnostic> diagnostics = Diagnose(CommandSource(
            """@route("/a")""", """@route("/b")""", """@auth("x")""", """@auth("y")"""));

        diagnostics.Count(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation).ShouldBe(2);
        diagnostics.First(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation).Line.ShouldBe(8);
        diagnostics.Last(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation).Line.ShouldBe(10);
    }

    // ---- a verb annotation takes no argument (#1219 review) -----------------

    /// <summary>
    /// A verb is a bare marker. An argument on one configures nothing — <c>@get("/orders")</c> reads as
    /// a route that would never be applied — so it is rejected rather than discarded without a word.
    /// </summary>
    [Theory]
    [InlineData("""@get("anything")""")]
    [InlineData("@put(3)")]
    [InlineData("""@delete("/orders")""")]
    public void A_verb_annotation_with_an_argument_is_rejected(string annotation) =>
        Diagnose(CommandSource(annotation))
            .ShouldContain(d => d.Code == DiagnosticCodes.VerbAnnotationArgument);

    [Fact]
    public void A_verb_annotation_with_an_argument_is_rejected_on_a_query() =>
        Diagnose(QuerySource("""@get("anything")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.VerbAnnotationArgument);

    /// <summary>The argument's presence is recorded on the annotation info, at the offending verb.</summary>
    [Fact]
    public void A_verb_annotations_argument_is_recorded_for_the_validator()
    {
        CommandDecl place = CommandOf(CommandSource("@put", """@get("x")"""), "Order", "place");

        ApiAnnotationInfo api = place.ApiAnnotations.ShouldNotBeNull();
        api.VerbArgumentSpan.IsNone.ShouldBeFalse();
        api.VerbArgumentSpan.Line.ShouldBe(8); // the @get, not the bare @put on line 7
    }

    /// <summary>Non-regression: a bare verb records no argument and is not reported.</summary>
    [Fact]
    public void A_bare_verb_annotation_records_no_argument()
    {
        CommandOf(CommandSource("@put"), "Order", "place")
            .ApiAnnotations.ShouldNotBeNull().VerbArgumentSpan.IsNone.ShouldBeTrue();

        Diagnose(CommandSource("@put")).ShouldNotContain(d => d.Code == DiagnosticCodes.VerbAnnotationArgument);
    }

    // ---- evolution annotations on the new annotation lists (#1219 review) ---

    /// <summary>
    /// <c>queryDecl</c> gained a leading <c>annotation*</c> for the API annotations, which also made the
    /// R15.1 evolution annotations parse there. A query IS a type declaration, so they must land on it
    /// rather than be read and thrown away.
    /// </summary>
    [Fact]
    public void Since_and_deprecated_land_on_a_query()
    {
        QueryDecl byId = QueryOf(QuerySource("@since(2)", """@deprecated("use OrderSummaryById")"""), "OrderById");

        byId.Since.ShouldBe(2);
        byId.Deprecated.ShouldBe("use OrderSummaryById");
    }

    /// <summary>The deprecation reaches the emitted C#, exactly as it does for any other type declaration.</summary>
    [Fact]
    public void A_deprecated_query_emits_Obsolete_on_the_record()
    {
        var query = FileEndingWith(Build(QuerySource("""@deprecated("use OrderSummaryById")""")), "OrderById.cs");

        query.ShouldContain("[Obsolete(\"use OrderSummaryById\")]\npublic sealed record OrderById(");
        query.ShouldContain("using System;");
    }

    /// <summary>Non-regression: an un-annotated query gains no attribute.</summary>
    [Fact]
    public void An_unannotated_query_does_not_gain_Obsolete() =>
        FileEndingWith(Build(QuerySource()), "OrderById.cs").ShouldNotContain("[Obsolete");

    /// <summary>
    /// A query's <c>@since</c> now reaches the R15.1 version-ceiling check (KOI1501) like every other
    /// type declaration's — the clearest proof it is honored downstream rather than merely stored.
    /// </summary>
    [Fact]
    public void A_querys_since_above_the_context_version_is_warned()
    {
        IReadOnlyList<Diagnostic> diagnostics = Diagnose("""
            context Sales version 1 {
              enum OrderStatus { Draft, Placed }
              aggregate Sales root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              @since(7)
              query OrderById(id: OrderId): OrderSummary
            }
            """);

        Diagnostic warning = diagnostics.ShouldHaveSingleItem();
        warning.Code.ShouldBe(DiagnosticCodes.AnnotationVersionAboveContext);
        warning.Message.ShouldContain("OrderById");
    }

    /// <summary>
    /// <c>commandDecl</c> gained the same leading <c>annotation*</c>, but a command is NOT a type
    /// declaration — it has no <c>Since</c>/<c>Deprecated</c> to hold an evolution annotation. Rather
    /// than read one and drop it (before R19 it was a syntax error, so it never used to vanish), the
    /// compiler rejects it.
    /// </summary>
    [Theory]
    [InlineData("""@deprecated("use cancel")""")]
    [InlineData("@since(2)")]
    public void An_evolution_annotation_on_a_command_is_rejected(string annotation) =>
        Diagnose(CommandSource(annotation))
            .ShouldContain(d => d.Code == DiagnosticCodes.VersionAnnotationOnCommand);

    /// <summary>It is reported at the annotation, and alongside — not instead of — the API checks.</summary>
    [Fact]
    public void An_evolution_annotation_on_a_command_is_reported_at_its_own_annotation()
    {
        // Annotations start on line 7 (see CommandSource): @route, then @deprecated.
        IReadOnlyList<Diagnostic> diagnostics =
            Diagnose(CommandSource("""@route("orders")""", """@deprecated("gone")"""));

        diagnostics.Single(d => d.Code == DiagnosticCodes.VersionAnnotationOnCommand).Line.ShouldBe(8);
        diagnostics.ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);
    }

    /// <summary>Non-regression: a command carrying only API annotations is never flagged for versioning.</summary>
    [Fact]
    public void An_api_annotated_command_is_not_flagged_as_carrying_an_evolution_annotation() =>
        Diagnose(CommandSource("""@route("/orders/{id}")""", "@put", """@auth("admin")"""))
            .ShouldNotContain(d => d.Code == DiagnosticCodes.VersionAnnotationOnCommand);

    // ---- the per-declaration checks run over a factory too (#1846) ----------

    /// <summary>
    /// A factory reaches the very same <c>CqrsValidator.ValidateApiAnnotations</c> a command does
    /// (#1846), so KOI1208 catches the same shapes there: a bare <c>@route</c> (which names no path and
    /// configures nothing), a relative or empty one, and a template the routing stack would reject at
    /// startup.
    /// </summary>
    [Theory]
    [InlineData("@route")]
    [InlineData("""@route("orders")""")]
    [InlineData("""@route("")""")]
    [InlineData("""@route("/orders/{id")""")]
    public void An_invalid_route_override_is_rejected_on_a_factory(string annotation) =>
        Diagnose(FactorySource(annotation))
            .ShouldContain(d => d.Code == DiagnosticCodes.InvalidRouteOverride);

    /// <summary>A factory is one endpoint too, so it may carry at most one verb annotation.</summary>
    [Fact]
    public void Two_verb_annotations_are_rejected_on_a_factory() =>
        Diagnose(FactorySource("@get", "@post"))
            .ShouldContain(d => d.Code == DiagnosticCodes.MultipleVerbAnnotations);

    /// <summary>A role that is blank — or absent entirely — guards nothing on a factory either.</summary>
    [Theory]
    [InlineData("""@auth("")""")]
    [InlineData("""@auth("   ")""")]
    [InlineData("@auth")]
    public void A_blank_auth_role_is_rejected_on_a_factory(string annotation) =>
        Diagnose(FactorySource(annotation))
            .ShouldContain(d => d.Code == DiagnosticCodes.EmptyAuthRole);

    /// <summary><c>@route</c>/<c>@auth</c> are single-valued on a factory as well: repeating one kept the
    /// last and dropped the rest, which is exactly what the reader promises never to do silently.</summary>
    [Fact]
    public void A_repeated_route_or_auth_annotation_is_rejected_on_a_factory()
    {
        Diagnose(FactorySource("""@route("/a")""", """@route("/b")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation);

        Diagnose(FactorySource("""@auth("a")""", """@auth("b")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.DuplicateApiAnnotation);
    }

    /// <summary>A verb annotation is a bare marker on a factory too — <c>@get("/x")</c> reads as a route
    /// that would never be applied, so it is rejected rather than discarded.</summary>
    [Fact]
    public void A_verb_annotation_with_an_argument_is_rejected_on_a_factory() =>
        Diagnose(FactorySource("""@get("/x")"""))
            .ShouldContain(d => d.Code == DiagnosticCodes.VerbAnnotationArgument);

    /// <summary>
    /// A factory is no more a type declaration than a command is: the new <c>annotation*</c> prefix on
    /// <c>factoryDecl</c> (#1846) makes <c>@since</c>/<c>@deprecated</c> parse there, but a
    /// <see cref="FactoryDecl"/> has no <c>Since</c>/<c>Deprecated</c> to hold them — so they are
    /// rejected (KOI1214) rather than read and dropped, exactly as on a command.
    /// </summary>
    [Theory]
    [InlineData("""@deprecated("use openDraft")""")]
    [InlineData("@since(2)")]
    public void An_evolution_annotation_on_a_factory_is_rejected(string annotation) =>
        Diagnose(FactorySource(annotation))
            .ShouldContain(d => d.Code == DiagnosticCodes.VersionAnnotationOnCommand);

    /// <summary>
    /// Each factory diagnostic lands on its own annotation. <see cref="FactorySource"/> is line-for-line
    /// congruent with <see cref="CommandSource"/>, so the expected lines are literally
    /// <see cref="Each_api_diagnostic_points_at_its_own_annotation"/>'s — the pin that a factory's span
    /// positioning matches a command's rather than drifting by a line.
    /// </summary>
    [Fact]
    public void Each_factory_api_diagnostic_points_at_its_own_annotation()
    {
        // Annotations start on line 7 (see FactorySource): @route, then @get, @post, then @auth.
        IReadOnlyList<Diagnostic> diagnostics =
            Diagnose(FactorySource("""@route("orders")""", "@get", "@post", """@auth(" ")"""));

        diagnostics.Single(d => d.Code == DiagnosticCodes.InvalidRouteOverride).Line.ShouldBe(7);
        diagnostics.Single(d => d.Code == DiagnosticCodes.MultipleVerbAnnotations).Line.ShouldBe(9);
        diagnostics.Single(d => d.Code == DiagnosticCodes.EmptyAuthRole).Line.ShouldBe(10);
    }

    // ---- KOI1215 on a factory, and the {id} divergence (#1846) --------------

    /// <summary>A factory route token naming no parameter binds to nothing — KOI1215 warns once, on the
    /// <c>@route</c> annotation's own line (7, exactly where its command counterpart lands).</summary>
    [Fact]
    public void A_token_naming_nothing_on_a_factory_is_a_KOI1215_warning()
    {
        Diagnostic warning = Diagnose(FactorySource("""@route("/orders/{ref}")"""))
            .ShouldHaveSingleItem();

        warning.Code.ShouldBe(DiagnosticCodes.UnboundRouteToken);
        warning.Severity.ShouldBe(DiagnosticSeverity.Warning);
        warning.Line.ShouldBe(7);
        warning.Message.ShouldContain("{ref}");
    }

    /// <summary>
    /// The one place a factory's rules deliberately DIVERGE from a command's (#1846): <c>{id}</c> gets no
    /// aggregate-identity fallback, so it warns here where
    /// <see cref="An_id_token_on_a_command_is_not_flagged"/> stays silent. A command loads an existing
    /// aggregate, so its emitted request record carries an identity property for <c>{id}</c> to bind to;
    /// a factory <b>creates</b> one — <c>CSharpEmitter.Application.cs</c>'s <c>EmitFactoryHandler</c>
    /// builds the request record from the factory's parameters alone, and
    /// <c>CSharpEmitter.Api.cs</c>'s <c>WriteFactoryEndpoint</c> passes an empty identity property — so
    /// there is nothing to bind, and letting <c>{id}</c> resolve would emit
    /// <c>request with {  = id }</c>, which is not valid C#. Hence <c>identityTypeName: null</c> at the
    /// call site, and hence a warning here.
    ///
    /// <para>On this fixture's <b>Guid</b> identity the warning is moreover <b>permanent</b>: the factory
    /// cannot silence it by declaring an <c>id</c> parameter, because KOI0807
    /// <c>ReservedFactoryParameter</c> reserves that name for the synthetic <c>var id = OrderId.New();</c>
    /// local. So the remedy the message offers must NOT name the aggregate identity — that would be the
    /// one fix the author has no way to apply (#1846 code review).</para>
    /// </summary>
    [Fact]
    public void An_id_token_on_a_factory_is_a_KOI1215_warning_because_a_factory_mints_its_identity()
    {
        Diagnostic warning = Diagnose(FactorySource("""@route("/orders/{id}")"""))
            .ShouldHaveSingleItem();

        warning.Code.ShouldBe(DiagnosticCodes.UnboundRouteToken);
        warning.Severity.ShouldBe(DiagnosticSeverity.Warning);
        warning.Message.ShouldContain("{id}");
        warning.Message.ShouldNotContain("or 'id' for the aggregate identity");
    }

    /// <summary>
    /// The positive half of the rule above: on a factory a token binds by ORDINARY NAME MATCH against the
    /// declaration's parameters, so a factory that really declares one is silent. Two shapes are pinned —
    /// an everyday parameter (<c>{title}</c>), and <c>id</c> itself, which needs the #324 explicit-identity
    /// opt-in to be declarable at all: on a Guid identity the factory mints <c>var id = …</c>, so a
    /// parameter of that name is rejected outright (KOI0807 <c>ReservedFactoryParameter</c>), and only a
    /// non-Guid key lets one through (see <c>MemberAnalysis.IdentityParameters</c>). Hence the
    /// <c>natural(String)</c> fixture.
    /// </summary>
    [Fact]
    public void A_factory_token_naming_a_real_parameter_is_not_flagged()
    {
        Diagnose("""
            context Catalog {
              entity Book identified by BookId as natural(String) {
                title: String

                @route("/books/{title}")
                create register(id: BookId, title: String) {
                }
              }
            }
            """).ShouldBeEmpty();

        Diagnose("""
            context Catalog {
              entity Book identified by BookId as natural(String) {
                title: String

                @route("/books/{id}")
                create register(id: BookId, title: String) {
                }
              }
            }
            """).ShouldBeEmpty();
    }

    // ---- KOI1211: route + verb collisions across a context (#1219 review) ---

    /// <summary>
    /// A context whose <c>Order</c> entity carries a <c>place</c> then a <c>cancel</c> command, preceded
    /// by the <paramref name="onPlace"/> / <paramref name="onCancel"/> annotation lines respectively.
    /// </summary>
    private static string TwoCommandSource(string[] onPlace, string[] onCancel) => $$"""
        context Sales {
          enum OrderStatus { Draft, Placed, Cancelled }
          aggregate Fulfilment root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft

              {{string.Join("\n      ", onPlace)}}
              command place {
                requires status == Draft "order already placed"
                status -> Placed
              }

              {{string.Join("\n      ", onCancel)}}
              command cancel {
                requires status == Placed "order not placed"
                status -> Cancelled
              }
            }
          }
        }
        """;

    private static readonly string[] PutOrdersId = ["""@route("/orders/{id}")""", "@put"];

    /// <summary>
    /// Two declarations resolving to the same route AND verb is the one API-annotation mistake that no
    /// per-declaration check can see. Left unreported it produced an <b>unparseable</b> openapi document
    /// (the same verb key twice under one path) and, in C#, two identical <c>MapPut</c> calls that ASP.NET
    /// rejects with <c>AmbiguousMatchException</c> at request time.
    /// </summary>
    [Fact]
    public void Two_declarations_sharing_a_route_and_verb_are_rejected()
    {
        Diagnostic collision = Diagnose(TwoCommandSource(PutOrdersId, PutOrdersId)).ShouldHaveSingleItem();

        collision.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        collision.Message.ShouldContain("PUT /orders/{id}");
        // Named both ways round: the offender, and the declaration already holding the route.
        collision.Message.ShouldContain("command 'cancel' on 'Order'");
        collision.Message.ShouldContain("command 'place' on 'Order'");
    }

    /// <summary>
    /// It lands on the SECOND declaration — the first one is not the mistake. A command's span opens at
    /// its annotation prefix (the grammar's <c>annotation*</c> is part of <c>commandDecl</c>), so the
    /// expected line is <c>cancel</c>'s first annotation, not its <c>command</c> keyword.
    /// </summary>
    [Fact]
    public void The_route_collision_is_reported_on_the_later_declaration()
    {
        var lines = TwoCommandSource(PutOrdersId, PutOrdersId).Split('\n');
        var placeLine = Array.FindIndex(lines, l => l.Contains("command place", StringComparison.Ordinal)) + 1;
        var cancelSpanLine = Array.FindIndex(
            lines, placeLine, l => l.Contains("@route(", StringComparison.Ordinal)) + 1;

        Diagnostic collision = Diagnose(TwoCommandSource(PutOrdersId, PutOrdersId)).ShouldHaveSingleItem();

        collision.Line.ShouldBeGreaterThan(placeLine);
        collision.Line.ShouldBe(cancelSpanLine);
    }

    /// <summary>Sharing a route under DIFFERENT verbs is the whole point of <c>@route</c> — never reported.</summary>
    [Fact]
    public void Two_declarations_sharing_a_route_under_different_verbs_are_accepted() =>
        Diagnose(TwoCommandSource(PutOrdersId, ["""@route("/orders/{id}")""", "@delete"]))
            .ShouldBeEmpty();

    /// <summary>And the same verb at different routes is likewise fine — both axes have to match.</summary>
    [Fact]
    public void Two_declarations_sharing_a_verb_at_different_routes_are_accepted() =>
        Diagnose(TwoCommandSource(
                ["""@route("/orders/{id}/place")""", "@put"],
                ["""@route("/orders/{id}/cancel")""", "@put"]))
            .ShouldBeEmpty();

    /// <summary>
    /// The validator sees CONVENTIONAL routes too, not just overridden ones: an <c>@route</c> aimed at the
    /// path another, un-annotated declaration already derives collides just as hard. The expected path is
    /// computed through <see cref="RouteDerivation"/> itself rather than hard-coded, so this doubles as the
    /// pin that keeps <c>CqrsValidator</c>'s restated convention and the emit-side one from drifting — the
    /// two live in different assemblies and only the test project can see both.
    /// </summary>
    [Theory]
    [InlineData("place")]
    [InlineData("placeOrder")]
    [InlineData("place2Ship")]
    [InlineData("placeXMLOrder")]
    public void An_override_colliding_with_a_conventional_route_is_rejected(string commandName)
    {
        var source = $$"""
            context Sales {
              enum OrderStatus { Draft, Placed, Cancelled }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  command {{commandName}} {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }

                  @route("{{ConventionalCommandRoute("Order", commandName)}}")
                  command cancel {
                    requires status == Placed "order not placed"
                    status -> Cancelled
                  }
                }
              }
            }
            """;

        Diagnose(source).ShouldHaveSingleItem().Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
    }

    /// <summary>A query's conventional <c>GET /{query}</c> is in the same namespace as the commands'.</summary>
    [Fact]
    public void An_override_colliding_with_a_conventional_query_route_is_rejected()
    {
        var source = $$"""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("{{ConventionalQueryRoute("OrderById")}}")
                  @get
                  command place {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              query OrderById(id: OrderId): OrderSummary
            }
            """;

        Diagnose(source).ShouldHaveSingleItem().Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
    }

    /// <summary>
    /// The check is per bounded context — two contexts each emit their own openapi document and their own
    /// endpoint class, so the same route in both is not a collision.
    /// </summary>
    [Fact]
    public void The_same_route_in_two_contexts_is_not_a_collision() =>
        Diagnose("""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{id}")
                  @put
                  command place {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }
                }
              }
            }

            context Shipping {
              enum ParcelStatus { Ready, Sent }
              aggregate Dispatch root Parcel {
                entity Parcel identified by ParcelId {
                  status: ParcelStatus = Ready

                  @route("/orders/{id}")
                  @put
                  command send {
                    requires status == Ready "parcel already sent"
                    status -> Sent
                  }
                }
              }
            }
            """).ShouldBeEmpty();

    /// <summary>Non-regression: a wholly conventional context never trips the check.</summary>
    [Fact]
    public void A_conventional_context_reports_no_route_collision() =>
        Diagnose(TwoCommandSource([], [])).ShouldBeEmpty();

    // ---- KOI1211: factory routes (#1747) -------------------------------------

    /// <summary>
    /// The headline case from the issue: a factory's conventional route collides with a command
    /// annotated onto the very same <c>(route, verb)</c> pair. #1734 already catches every other shape
    /// of this mistake — a factory was the one construct left outside KOI1211's collision namespace.
    /// The grammar requires every <c>commandDecl</c> before any <c>factoryDecl</c> in one entity body, so
    /// the factory is necessarily the SECOND (reported) declaration here — exactly the case the
    /// conventional-route hint exists for. Since #1846 the hint points the author at the annotation the
    /// factory can NOW carry itself, rather than claiming it can never carry one.
    /// </summary>
    [Fact]
    public void A_factorys_conventional_route_colliding_with_an_annotated_command_is_rejected()
    {
        const string source = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/order/open")
                  @post
                  command reopen {
                    requires status == Placed "order is not placed"
                    status -> Draft
                  }

                  create open {
                  }
                }
              }
            }
            """;

        Diagnostic collision = Diagnose(source).ShouldHaveSingleItem();

        collision.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        collision.Message.ShouldContain("factory 'open' on 'Order'");
        collision.Message.ShouldContain("command 'reopen' on 'Order'");
        collision.Message.ShouldContain(
            "this factory derives both its route and its verb by convention — give it a @route or a " +
            "verb annotation of its own to move it off this path");
    }

    /// <summary>
    /// The validator sees a factory's CONVENTIONAL route too: an <c>@route</c> aimed at the path a
    /// factory already derives collides just as hard. The expected path is computed through
    /// <see cref="RouteDerivation.ForFactory"/> itself rather than hard-coded, so this doubles as the pin
    /// that keeps <c>CqrsValidator</c>'s restated convention and the emit-side one from drifting for
    /// factories, mirroring <see cref="An_override_colliding_with_a_conventional_route_is_rejected"/>.
    /// </summary>
    [Theory]
    [InlineData("open")]
    [InlineData("openDraft")]
    [InlineData("XMLImport")]
    [InlineData("order2Ship")]
    public void An_override_colliding_with_a_conventional_factory_route_is_rejected(string factoryName)
    {
        var source = $$"""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("{{ConventionalFactoryRoute("Order", factoryName)}}")
                  @post
                  command cancel {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }

                  create {{factoryName}} {
                  }
                }
              }
            }
            """;

        Diagnose(source).ShouldHaveSingleItem().Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
    }

    /// <summary>Two factories on different entities never collide — different entity segments.</summary>
    [Fact]
    public void Two_factories_on_different_entities_do_not_collide() =>
        Diagnose("""
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  create open {
                  }
                }
              }

              aggregate Invoices root Invoice {
                entity Invoice identified by InvoiceId {
                  create open {
                  }
                }
              }
            }
            """).ShouldBeEmpty();

    /// <summary>A factory alone — no colliding command or query — produces no diagnostic.</summary>
    [Fact]
    public void A_lone_factory_produces_no_diagnostic() =>
        Diagnose("""
            context Sales {
              aggregate Orders root Order {
                entity Order identified by OrderId {
                  create open {
                  }
                }
              }
            }
            """).ShouldBeEmpty();

    /// <summary>A command whose route does not match any factory's still produces no diagnostic.</summary>
    [Fact]
    public void A_command_not_colliding_with_a_factory_produces_no_diagnostic() =>
        Diagnose("""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  command place {
                    requires status == Draft "order already placed"
                    status -> Placed
                  }

                  create open {
                  }
                }
              }
            }
            """).ShouldBeEmpty();

    /// <summary>
    /// Non-regression (#1747): a command-vs-command collision message is exactly what it was before this
    /// issue — the factory-specific hint is appended only when the reported claimant IS a factory.
    /// </summary>
    [Fact]
    public void Command_vs_command_collision_message_carries_no_factory_hint()
    {
        Diagnostic collision = Diagnose(TwoCommandSource(PutOrdersId, PutOrdersId)).ShouldHaveSingleItem();

        collision.Message.ShouldBe(
            "command 'cancel' on 'Order' maps 'PUT /orders/{id}', which command 'place' on 'Order' " +
            "already maps; two declarations may share a route only when their verbs differ");
    }

    /// <summary>
    /// Two factories can collide with EACH OTHER too — not just with a command/query. Type names are
    /// unique case-<b>sensitively</b>, so <c>Order</c>/<c>ORDER</c> are distinct entities whose factories
    /// (<c>open</c>/<c>OPEN</c>) both kebab to the same conventional route. With NEITHER side annotated,
    /// pointing the reported factory at the other one is not actionable — the other is equally
    /// un-annotated — so this pair keeps its own hint (code-review catch on #1747: the hint must branch
    /// on BOTH claimants' shape, not just the reported one's). Since #1846 the wording offers the
    /// annotation as the first fix and renaming as the fallback, because a factory now HAS an
    /// annotation axis.
    /// </summary>
    [Fact]
    public void Two_factories_colliding_on_their_conventional_route_get_a_two_factory_hint()
    {
        const string source = """
            context Sales {
              entity Order identified by OrderId {
                create open {
                }
              }

              entity ORDER identified by OrderTwoId {
                create OPEN {
                }
              }
            }
            """;

        Diagnostic collision = Diagnose(source).ShouldHaveSingleItem();

        collision.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        collision.Message.ShouldContain(
            "neither factory annotates a route or a verb, so both fall on the same conventional path — " +
            "give one a @route (or a different verb), or rename one factory or one entity so their " +
            "conventional paths differ");
        collision.Message.ShouldNotContain("cannot be annotated");
    }

    /// <summary>
    /// An annotated factory claims its OVERRIDDEN pair, not its conventional one (#1846) — so an
    /// <c>@route</c> aimed at a command's route+verb collides just as a command's would. And because the
    /// reported claimant IS the annotated side here, <c>conventionalOnly</c> is false and NO factory hint
    /// is appended: the message is the plain two-declarations one, asserted whole.
    /// </summary>
    [Fact]
    public void An_annotated_factorys_overridden_route_collides_with_a_command()
    {
        const string source = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/open")
                  @post
                  command reopen {
                    requires status == Placed "order is not placed"
                    status -> Draft
                  }

                  @route("/orders/open")
                  create open {
                  }
                }
              }
            }
            """;

        Diagnostic collision = Diagnose(source).ShouldHaveSingleItem();

        collision.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        collision.Message.ShouldBe(
            "factory 'open' on 'Order' maps 'POST /orders/open', which command 'reopen' on 'Order' " +
            "already maps; two declarations may share a route only when their verbs differ");
    }

    /// <summary>
    /// Factory vs factory with exactly ONE side annotated: the hint follows the REPORTED (second)
    /// claimant's shape, not the pair's. Declared annotated-first, the un-annotated factory is the one
    /// reported, and — now that #1846 gives it an annotation axis — it is told to add one of its own;
    /// declared the other way round, the annotated factory is reported and gets no hint, because it
    /// already carries the axis the hint would point at. This is the regression guard for the pre-#1846
    /// wording, which told the author a factory "cannot be annotated".
    /// </summary>
    [Fact]
    public void A_factory_vs_factory_collision_hints_at_the_reported_sides_own_annotation()
    {
        const string annotatedFirst = """
            context Sales {
              entity Invoice identified by InvoiceId {
                @route("/order/open")
                create draft {
                }
              }

              entity Order identified by OrderId {
                create open {
                }
              }
            }
            """;

        Diagnostic conventionalReported = Diagnose(annotatedFirst).ShouldHaveSingleItem();

        conventionalReported.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        conventionalReported.Message.ShouldBe(
            "factory 'open' on 'Order' maps 'POST /order/open', which factory 'draft' on 'Invoice' " +
            "already maps; two declarations may share a route only when their verbs differ" +
            "; this factory derives both its route and its verb by convention — give it a @route or a " +
            "verb annotation of its own to move it off this path");

        const string conventionalFirst = """
            context Sales {
              entity Order identified by OrderId {
                create open {
                }
              }

              entity Invoice identified by InvoiceId {
                @route("/order/open")
                create draft {
                }
              }
            }
            """;

        Diagnostic annotatedReported = Diagnose(conventionalFirst).ShouldHaveSingleItem();

        annotatedReported.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        annotatedReported.Message.ShouldBe(
            "factory 'draft' on 'Invoice' maps 'POST /order/open', which factory 'open' on 'Order' " +
            "already maps; two declarations may share a route only when their verbs differ");
    }

    /// <summary>
    /// The shape that forced the <c>(true, false)</c> hint to stop mentioning the OTHER declaration
    /// (#1846 code review). <c>conventionalOnly</c> is <c>RouteOverride is null &amp;&amp; VerbOverride is
    /// null</c>, so a <b>redundant</b> <c>@post</c> — one that merely restates the verb the convention
    /// would have derived anyway — already takes its factory out of <c>conventionalOnly</c> without moving
    /// it off the colliding pair by one inch. Declared first, that factory is the un-reported side, and
    /// the fully conventional factory reported against it therefore lands in <c>(true, false)</c>. The old
    /// wording told the author to "move the one on the other declaration" — here that is a dead end
    /// (removing or re-adding <c>@post</c> changes nothing, since POST is the convention), which is why
    /// both hints now advise the REPORTED declaration alone. Asserted whole, and guarded against the
    /// other-declaration advice creeping back.
    /// </summary>
    [Fact]
    public void A_redundant_verb_on_the_other_factory_still_hints_only_at_the_reported_one()
    {
        const string source = """
            context Sales {
              entity Order identified by OrderId {
                @post
                create open {
                }
              }

              entity ORDER identified by OrderTwoId {
                create open {
                }
              }
            }
            """;

        Diagnostic collision = Diagnose(source).ShouldHaveSingleItem();

        collision.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        collision.Message.ShouldBe(
            "factory 'open' on 'ORDER' maps 'POST /order/open', which factory 'open' on 'Order' " +
            "already maps; two declarations may share a route only when their verbs differ" +
            "; this factory derives both its route and its verb by convention — give it a @route or a " +
            "verb annotation of its own to move it off this path");
        collision.Message.ShouldNotContain("the other declaration");
        collision.Message.ShouldNotContain("cannot be annotated");
    }

    /// <summary>
    /// An override MOVES a factory out of a collision (#1846): the very entity that trips KOI1211 in
    /// <see cref="A_factorys_conventional_route_colliding_with_an_annotated_command_is_rejected"/> is
    /// silent once the factory carries a <c>@route</c> of its own — proof the collision check reads the
    /// override rather than always deriving the conventional pair.
    /// </summary>
    [Fact]
    public void An_annotated_factory_moved_off_the_colliding_route_is_accepted() =>
        Diagnose("""
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/order/open")
                  @post
                  command reopen {
                    requires status == Placed "order is not placed"
                    status -> Draft
                  }

                  @route("/orders")
                  create open {
                  }
                }
              }
            }
            """).ShouldBeEmpty();

    /// <summary>
    /// <c>conventionalOnly</c> keys off route/verb, NOT off "carries any annotation at all": a factory
    /// with only <c>@auth</c> still derives both HTTP axes by convention, so it still claims the
    /// conventional pair and still gets the conventional-side hint. Pins the predicate against silently
    /// drifting to <c>ApiAnnotations is null</c>.
    /// </summary>
    [Fact]
    public void An_auth_only_factory_still_claims_its_conventional_route()
    {
        const string source = """
            context Sales {
              enum OrderStatus { Draft, Placed }
              aggregate Fulfilment root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/order/open")
                  @post
                  command reopen {
                    requires status == Placed "order is not placed"
                    status -> Draft
                  }

                  @auth("admin")
                  create open {
                  }
                }
              }
            }
            """;

        Diagnostic collision = Diagnose(source).ShouldHaveSingleItem();

        collision.Code.ShouldBe(DiagnosticCodes.DuplicateApiRoute);
        collision.Message.ShouldContain("factory 'open' on 'Order'");
        collision.Message.ShouldEndWith(
            "; this factory derives both its route and its verb by convention — give it a @route or a " +
            "verb annotation of its own to move it off this path");
    }

    /// <summary>The conventional route the emit side derives for <c>entity.command</c>.</summary>
    private static string ConventionalCommandRoute(string entity, string command) =>
        RouteDerivation.ForCommand(
            new EntityDecl(entity, entity + "Id", [], [], [], [], []),
            new CommandDecl(command, [], [])).Route;

    /// <summary>The conventional route the emit side derives for a query.</summary>
    private static string ConventionalQueryRoute(string query) =>
        RouteDerivation.ForQuery(new QueryDecl(query, [], new TypeRef("Unused"))).Route;

    /// <summary>The conventional route the emit side derives for <c>entity.factory</c> (#1747).</summary>
    private static string ConventionalFactoryRoute(string entity, string factory) =>
        RouteDerivation.ForFactory(
            new EntityDecl(entity, entity + "Id", [], [], [], [], []),
            new FactoryDecl(factory, [], [])).Route;

    private static string FileEndingWith(IEnumerable<Emit.EmittedFile> files, string suffix) =>
        files.Single(f => f.RelativePath.EndsWith(suffix, StringComparison.Ordinal)).Contents;

    // ---- @route token binding into the C# api layer (#1748) -----------------

    /// <summary>Emits <paramref name="source"/> with the Application + api layers on and asserts a clean compile.</summary>
    private static IReadOnlyList<Emit.EmittedFile> BuildApi(string source)
    {
        var options = CSharpEmitterOptions.Empty with
        {
            Layers = new HashSet<CSharpLayer> { CSharpLayer.Domain, CSharpLayer.Application, CSharpLayer.Api },
        };
        var result = new KoineCompiler().Compile(source, new CSharpEmitter(options));
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return result.Files;
    }

    /// <summary>The §15.9 reference-docs example: a route token with no matching command parameter binds
    /// to the aggregate identity (#1748) — an explicit <c>[FromRoute]</c> parameter ahead of the request,
    /// re-bound into it via <c>with { Id = id }</c>, so the URL and the loaded aggregate can never
    /// disagree about which order is being submitted.</summary>
    [Fact]
    public void A_route_token_with_no_matching_parameter_binds_to_the_aggregate_identity()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{id}")
                  @put
                  @auth("admin")
                  command submit(note: String) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var endpoints = FileEndingWith(BuildApi(src), "OrderingEndpoints.cs");

        endpoints.ShouldContain("[Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] OrderId id");
        endpoints.ShouldContain("request with { Id = id }");
    }

    /// <summary>
    /// Collision case: a command parameter named <c>id</c> wins the name match over the identity
    /// fallback (#1748) — the token binds to the <b>parameter</b>, and the identity property is pushed to
    /// <c>AggregateId</c>, the same collision rule <c>CSharpEmitter.Application.cs</c>'s handler already
    /// applies via the shared <see cref="CSharpNaming.CommandIdProperty"/> — the two can never disagree.
    /// </summary>
    [Fact]
    public void A_command_parameter_named_id_wins_the_token_over_the_identity_fallback()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{id}")
                  @put
                  command submit(id: String) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var files = BuildApi(src);
        var endpoints = FileEndingWith(files, "OrderingEndpoints.cs");

        endpoints.ShouldContain("[Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] string id");
        endpoints.ShouldContain("request with { Id = id }");

        // The identity property collided with the parameter's own "Id" and was pushed to "AggregateId"
        // (CSharpNaming.CommandIdProperty) — the handler, not the endpoint, is where it loads by it.
        FileEndingWith(files, "OrderSubmitHandler.cs").ShouldContain("request.AggregateId");
    }

    /// <summary>Non-regression: an unannotated command, and a <c>@route</c> whose template carries no
    /// <c>{token}</c> at all, both emit an endpoint with no <c>[FromRoute]</c> parameter and an untouched
    /// <c>request</c> call — byte-identical to pre-#1748 (#1748).</summary>
    [Fact]
    public void No_route_tokens_leaves_the_endpoint_untouched()
    {
        const string unannotated = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  command submit(note: String) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var endpoints = FileEndingWith(BuildApi(unannotated), "OrderingEndpoints.cs");
        endpoints.ShouldContain(
            "endpoints.MapPost(\"/order/submit\", async (OrderSubmitRequest request, OrderSubmitHandler handler, CancellationToken ct) =>");
        endpoints.ShouldContain("handler.HandleAsync(request, ct)");
        endpoints.ShouldNotContain("FromRoute");

        const string tokenless = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/submit")
                  @put
                  command submit(note: String) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var tokenlessEndpoints = FileEndingWith(BuildApi(tokenless), "OrderingEndpoints.cs");
        tokenlessEndpoints.ShouldContain(
            "endpoints.MapPut(\"/orders/submit\", async (OrderSubmitRequest request, OrderSubmitHandler handler, CancellationToken ct) =>");
        tokenlessEndpoints.ShouldNotContain("FromRoute");
    }

    /// <summary>
    /// A route token spelled exactly like a C# reserved keyword still has to compile: the
    /// <c>[FromRoute(Name = "…")]</c> argument stays the token's literal text (it must match the route
    /// template), but the identifier it binds to — the lambda parameter and every place the rebind
    /// references it — needs the <c>@</c> escape (#1748 code review).
    /// </summary>
    [Fact]
    public void A_route_token_spelled_like_a_csharp_keyword_still_compiles()
    {
        const string src = """
            context Ordering {
              enum OrderStatus { Draft, Submitted }

              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: OrderStatus = Draft

                  @route("/orders/{class}")
                  @put
                  command submit(class: String) {
                    requires status == Draft "order must be a draft to submit"
                    status -> Submitted
                  }
                }
              }
            }
            """;

        var endpoints = FileEndingWith(BuildApi(src), "OrderingEndpoints.cs");

        endpoints.ShouldContain("[Microsoft.AspNetCore.Mvc.FromRoute(Name = \"class\")] string @class");
        endpoints.ShouldContain("request with { Class = @class }");
    }

    /// <summary>
    /// The regression guard #1846 makes mandatory: giving a <b>factory</b> the <c>@route</c> axis put a
    /// second declaration kind on the keyword-collision path #1748's code review found, so it gets its own
    /// lock. The <c>[FromRoute(Name = "…")]</c> argument must stay the token's literal text — it has to
    /// match the route template ASP.NET registers — while the identifier it binds takes the <c>@</c>
    /// escape; getting either wrong emits C# that does not compile, which is why this asserts through
    /// <see cref="BuildApi"/> (a real Roslyn compile of the emitted files), not just on the text.
    /// </summary>
    [Theory]
    [InlineData("class", "Class")]
    [InlineData("event", "Event")]
    [InlineData("base", "Base")]
    [InlineData("int", "Int")]
    public void A_factory_route_token_spelled_like_a_csharp_keyword_still_compiles(string token, string property)
    {
        var src = $$"""
            context Ordering {
              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: String

                  @route("/orders/{{{token}}}")
                  create open({{token}}: String) {
                  }
                }
              }
            }
            """;

        var endpoints = FileEndingWith(BuildApi(src), "OrderingEndpoints.cs");

        endpoints.ShouldContain($"[Microsoft.AspNetCore.Mvc.FromRoute(Name = \"{token}\")] string @{token}");
        endpoints.ShouldContain($"request with {{ {property} = @{token} }}");
    }

    /// <summary>
    /// The ONE shape in which a factory's <c>{id}</c> token binds (#1846) — proven end-to-end through a
    /// real Roslyn compile, not just through <c>Diagnose</c>. A factory gets no aggregate-identity
    /// fallback (see
    /// <see cref="An_id_token_on_a_factory_is_a_KOI1215_warning_because_a_factory_mints_its_identity"/>):
    /// <c>{id}</c> binds by an ORDINARY NAME MATCH against a declared parameter or not at all. And on the
    /// default <b>Guid</b> identity a factory may not declare a parameter named <c>id</c> in the first
    /// place — KOI0807 <c>ReservedFactoryParameter</c> reserves the name for the synthetic
    /// <c>var id = &lt;Id&gt;.New();</c> local — so there <c>@route("/…/{id}")</c> is a permanent KOI1215
    /// with no way to comply. Only a NON-Guid key (<c>natural(…)</c>/<c>sequence</c>, i.e. the #324
    /// explicit-id opt-in) lets the parameter through, which is exactly this fixture's
    /// <c>natural(String)</c>.
    ///
    /// <para>Asserting through <see cref="BuildApi"/> is the point: this is the only path on which a
    /// <c>ToPascalCase</c> drift between <c>CSharpEmitter.Api.cs</c>'s <c>BuildRouteTokenBindings</c>
    /// rebind property and <c>CSharpEmitter.Application.cs</c>'s <c>EmitFactoryHandler</c> request-record
    /// property would emit a <c>with { … }</c> naming a member that does not exist — uncompilable C# that
    /// a text-only assertion would happily wave through.</para>
    /// </summary>
    [Fact]
    public void A_factory_declaring_an_explicit_id_parameter_binds_the_id_token_and_compiles()
    {
        const string src = """
            context Catalog {
              aggregate Books root Book {
                entity Book identified by BookId as natural(String) {
                  title: String

                  @route("/books/{id}")
                  create register(id: BookId, title: String) {
                  }
                }
              }
            }
            """;

        Diagnose(src).ShouldBeEmpty();

        var files = BuildApi(src);

        FileEndingWith(files, "BookRegisterRequest.cs")
            .ShouldContain("public sealed record BookRegisterRequest(BookId Id, string Title);");

        var endpoints = FileEndingWith(files, "CatalogEndpoints.cs");

        endpoints.ShouldContain(
            "endpoints.MapPost(\"/books/{id}\", async ([Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] BookId id,");
        endpoints.ShouldContain("request with { Id = id }");
    }

    // ---- @route token binding into the C# api layer — queries (#1748) -------

    /// <summary>A query criterion named the same as the route token binds the same way a command
    /// parameter does (#1748): lifted into <c>[FromRoute]</c> ahead of the <c>[AsParameters]</c> query,
    /// then re-bound into it via <c>with { Id = id }</c>.</summary>
    [Fact]
    public void A_query_route_token_binds_to_the_criterion_it_names()
    {
        const string src = """
            context Ordering {
              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: String
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              @route("/orders/{id}")
              query OrderById(id: String): OrderSummary
            }
            """;

        var endpoints = FileEndingWith(BuildApi(src), "OrderingEndpoints.cs");

        endpoints.ShouldContain(
            "endpoints.MapGet(\"/orders/{id}\", async ([Microsoft.AspNetCore.Mvc.FromRoute(Name = \"id\")] string id, [AsParameters] OrderById query, OrderByIdHandler handler, CancellationToken ct) =>");
        endpoints.ShouldContain("handler.HandleAsync(query with { Id = id }, ct)");
    }

    /// <summary>A query has no aggregate identity to fall back to (#1748): a token naming no criterion is
    /// simply unbound here — the KOI1215 diagnostic for it is Task 5's concern, not the emitter's.</summary>
    [Fact]
    public void A_query_route_token_with_no_matching_criterion_emits_no_FromRoute_parameter()
    {
        const string src = """
            context Ordering {
              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: String
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              @route("/orders/{id}")
              query OrdersByStatus(status: String): List<OrderSummary>
            }
            """;

        var endpoints = FileEndingWith(BuildApi(src), "OrderingEndpoints.cs");

        endpoints.ShouldContain(
            "endpoints.MapGet(\"/orders/{id}\", async ([AsParameters] OrdersByStatus query, OrdersByStatusHandler handler, CancellationToken ct) =>");
        endpoints.ShouldContain("handler.HandleAsync(query, ct)");
        endpoints.ShouldNotContain("FromRoute");
    }

    /// <summary>The query-side counterpart to <see cref="A_route_token_spelled_like_a_csharp_keyword_still_compiles"/>: a
    /// criterion named like a C# keyword needs the same <c>@</c>-escaped identifier (#1748 code review).</summary>
    [Fact]
    public void A_query_route_token_spelled_like_a_csharp_keyword_still_compiles()
    {
        const string src = """
            context Ordering {
              aggregate Order root Order {
                entity Order identified by OrderId {
                  status: String
                }
              }

              readmodel OrderSummary from Order {
                id
                status
              }

              @route("/orders/{event}")
              query OrdersByEvent(event: String): List<OrderSummary>
            }
            """;

        var endpoints = FileEndingWith(BuildApi(src), "OrderingEndpoints.cs");

        endpoints.ShouldContain("[Microsoft.AspNetCore.Mvc.FromRoute(Name = \"event\")] string @event");
        endpoints.ShouldContain("query with { Event = @event }");
    }
}
