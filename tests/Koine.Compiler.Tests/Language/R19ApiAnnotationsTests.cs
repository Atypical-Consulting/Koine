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
}
