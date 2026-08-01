using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R19 — the <c>publish &lt;IntegrationEvent&gt;(field: expr, ...)</c> command clause: the verb
/// form of a context's <c>publishes</c> declaration. <c>emit</c> keeps meaning "intra-aggregate
/// domain event"; <c>publish</c> means "published-language contract leaving the context".
/// This suite covers the PARSING layer only (validation and emission land in later tasks).
/// </summary>
public class R19PublishClauseTests
{
    private static ContextNode Context(string source)
    {
        (KoineModel? model, IReadOnlyList<Diagnostic> diagnostics) = new KoineCompiler().Parse(source);
        model.ShouldNotBeNull(string.Join("\n", diagnostics.Select(d => d.ToString())));
        return model!.Contexts.Single();
    }

    private static CommandDecl CommandOf(string source, string entity, string command) =>
        Context(source).AllEntities().Single(e => e.Name == entity).Commands.Single(c => c.Name == command);

    // ---- parsing ------------------------------------------------------------

    [Fact]
    public void Publish_clause_parses_into_a_PublishClause_node()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderPlaced(orderId: id) }
                }
              }
            }
            """;

        CommandDecl place = CommandOf(src, "Order", "place");
        PublishClause published = place.Body.OfType<PublishClause>().Single();

        published.EventName.ShouldBe("OrderPlaced");
        published.Args.Count.ShouldBe(1);
        published.Args[0].Field.ShouldBe("orderId");
        published.Args[0].Value.ShouldBeOfType<IdentifierExpr>().Name.ShouldBe("id");
    }

    [Fact]
    public void Publish_clause_carries_its_source_span()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place {
                    publish OrderPlaced(orderId: id)
                  }
                }
              }
            }
            """;

        PublishClause published = CommandOf(src, "Order", "place").Body.OfType<PublishClause>().Single();

        published.Span.ShouldNotBe(SourceSpan.None);
        published.Span.Line.ShouldBe(9);
    }

    [Fact]
    public void Publish_clause_without_arguments_parses_with_an_empty_payload()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderPlaced }
                }
              }
            }
            """;

        PublishClause published = CommandOf(src, "Order", "place").Body.OfType<PublishClause>().Single();

        published.EventName.ShouldBe("OrderPlaced");
        published.Args.ShouldBeEmpty();
    }

    [Fact]
    public void Publish_clause_with_several_arguments_keeps_their_order()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId, lines: Int }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderPlaced(orderId: id, lines: lineCount) }
                }
              }
            }
            """;

        PublishClause published = CommandOf(src, "Order", "place").Body.OfType<PublishClause>().Single();

        published.Args.Select(a => a.Field).ShouldBe(["orderId", "lines"]);
    }

    [Fact]
    public void Publish_and_emit_coexist_in_one_command_body_as_distinct_nodes()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Sales root Order {
                event OrderDrafted { orderId: OrderId }
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place {
                    emit OrderDrafted(orderId: id)
                    publish OrderPlaced(orderId: id)
                  }
                }
              }
            }
            """;

        CommandDecl place = CommandOf(src, "Order", "place");

        place.Body.OfType<EmitClause>().Single().EventName.ShouldBe("OrderDrafted");
        place.Body.OfType<PublishClause>().Single().EventName.ShouldBe("OrderPlaced");
        place.Body.Count.ShouldBe(2);
    }

    // ---- 'publish' stays a soft keyword -------------------------------------

    [Fact]
    public void Publish_is_still_usable_as_an_ordinary_identifier()
    {
        const string src = """
            context Ordering {
              value Settings {
                publish: Bool = true
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  publish: Bool = false
                  command allow { publish -> true }
                }
              }
            }
            """;

        ContextNode ctx = Context(src);

        ValueObjectDecl settings = ctx.AllTypeDecls().OfType<ValueObjectDecl>().Single(v => v.Name == "Settings");
        settings.Members.Single().Name.ShouldBe("publish");

        CommandDecl allow = CommandOf(src, "Order", "allow");
        allow.Body.OfType<Transition>().Single().Field.ShouldBe("publish");
        allow.Body.OfType<PublishClause>().ShouldBeEmpty();
    }
}
