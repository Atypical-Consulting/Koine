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
    /// templates that the routing stack accepts, so none of them may be diagnosed.
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
        Diagnose(CommandSource($"""@route("{route}")""")).ShouldBeEmpty();

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

    /// <summary>The conventional route the emit side derives for <c>entity.command</c>.</summary>
    private static string ConventionalCommandRoute(string entity, string command) =>
        RouteDerivation.ForCommand(
            new EntityDecl(entity, entity + "Id", [], [], [], [], []),
            new CommandDecl(command, [], [])).Route;

    /// <summary>The conventional route the emit side derives for a query.</summary>
    private static string ConventionalQueryRoute(string query) =>
        RouteDerivation.ForQuery(new QueryDecl(query, [], new TypeRef("Unused"))).Route;

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
}
