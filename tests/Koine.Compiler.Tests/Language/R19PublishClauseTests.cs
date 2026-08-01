using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Epic R19 — the <c>publish &lt;IntegrationEvent&gt;(field: expr, ...)</c> command clause: the verb
/// form of a context's <c>publishes</c> declaration. <c>emit</c> keeps meaning "intra-aggregate
/// domain event"; <c>publish</c> means "published-language contract leaving the context".
/// This suite covers PARSING and VALIDATION (emission lands in a later task).
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

    /// <summary>Every ERROR-severity diagnostic code the model produces, in emission order.</summary>
    private static IReadOnlyList<string> ErrorCodes(string source) =>
        new KoineCompiler().Diagnose(source)
            .Where(d => d.Severity == DiagnosticSeverity.Error)
            .Select(d => d.Code)
            .ToList();

    private static IReadOnlyList<Diagnostic> Diagnose(string source) => new KoineCompiler().Diagnose(source);

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

    // ---- validation ---------------------------------------------------------

    /// <summary>
    /// The valid shape every negative case below perturbs: an integration event, the context-level
    /// <c>publishes</c> that puts it in the published language, and a root command that publishes it.
    /// </summary>
    private const string ValidPublish = """
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

    [Fact]
    public void A_valid_publish_validates_clean()
    {
        ErrorCodes(ValidPublish).ShouldBeEmpty();
    }

    [Fact]
    public void Publishing_a_domain_event_reports_that_it_is_not_an_integration_event_of_the_context()
    {
        // OrderDrafted is a plain domain `event`: `emit`-able, never `publish`-able.
        const string src = """
            context Ordering {
              aggregate Sales root Order {
                event OrderDrafted { orderId: OrderId }
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderDrafted(orderId: id) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBe([DiagnosticCodes.PublishUnknownIntegrationEvent]);
        Diagnose(src).Single().Message.ShouldBe("'OrderDrafted' is not an integration event of context 'Ordering'");
    }

    [Fact]
    public void Publishing_an_integration_event_the_context_does_not_declare_is_reported()
    {
        // The integration event exists, but no `publishes OrderPlaced` puts it in the published language.
        const string src = """
            context Ordering {
              integration event OrderPlaced { orderId: OrderId }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderPlaced(orderId: id) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBe([DiagnosticCodes.PublishNotDeclared]);
        Diagnose(src).Single().Message.ShouldBe("context 'Ordering' does not declare 'publishes OrderPlaced'");
    }

    [Fact]
    public void Publish_from_a_non_root_entity_is_reported()
    {
        const string src = """
            context Ordering {
              publishes LineAdded
              integration event LineAdded { lineId: LineId }

              aggregate Sales root Order {
                entity Order identified by OrderId { lineCount: Int = 0 }
                entity OrderLine identified by LineId {
                  quantity: Int = 1
                  command touch { publish LineAdded(lineId: id) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBe([DiagnosticCodes.PublishOutsideRoot]);
    }

    [Fact]
    public void Publish_naming_a_field_the_integration_event_does_not_have_is_reported()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderPlaced(orderId: id, nope: lineCount) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBe([DiagnosticCodes.EmitPayloadMismatch]);
    }

    [Fact]
    public void Publish_missing_a_payload_field_is_reported()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced {
                orderId: OrderId
                lines:   Int
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderPlaced(orderId: id) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBe([DiagnosticCodes.EmitPayloadMismatch]);
    }

    [Fact]
    public void Publish_with_a_type_incompatible_payload_value_is_reported()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { lines: Int }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish OrderPlaced(lines: id) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBe([DiagnosticCodes.EmitPayloadMismatch]);
    }

    [Fact]
    public void Publish_of_an_unknown_integration_event_does_not_cascade_a_publishes_or_payload_error()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { publish Nope(whatever: lineCount) }
                }
              }
            }
            """;

        // Exactly one primary diagnostic: no KOI1421, no payload mismatch on the unresolvable name.
        ErrorCodes(src).ShouldBe([DiagnosticCodes.PublishUnknownIntegrationEvent]);
    }

    // ---- 'emit' is untouched by this task (regression guard) ----------------

    [Fact]
    public void Emit_of_a_domain_event_still_validates_clean()
    {
        const string src = """
            context Ordering {
              aggregate Sales root Order {
                event OrderDrafted { orderId: OrderId }
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command draft { emit OrderDrafted(orderId: id) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBeEmpty();
    }

    [Fact]
    public void Emit_naming_an_integration_event_still_reports_the_unknown_event()
    {
        const string src = """
            context Ordering {
              publishes OrderPlaced
              integration event OrderPlaced { orderId: OrderId }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  lineCount: Int = 0
                  command place { emit OrderPlaced(orderId: id) }
                }
              }
            }
            """;

        ErrorCodes(src).ShouldBe([DiagnosticCodes.UnknownEvent]);
    }
}
