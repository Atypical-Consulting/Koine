using Koine.Compiler.Ast;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Structured-diagram graph (issue #93, task 1): the <see cref="DocsEmitter"/> emits a source-aware
/// <see cref="DiagramGraph"/> alongside each Mermaid diagram — nodes carry a qualified name and the
/// most precise <see cref="SourceSpan"/> the AST offers, edges reference node ids. This suite asserts
/// the structural invariants the later (Studio) tasks rely on; <see cref="RDocsTests"/> still guards
/// the Markdown/Mermaid output, which must stay byte-identical.
/// </summary>
public class DiagramGraphTests
{
    /// <summary>A model exercising all four diagram kinds: state machine, aggregate, integration event, context map.</summary>
    private const string Fixture = """
        context Ordering version 1 {
          enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

          value Money {
            amount: Decimal
            invariant amount >= 0 "an amount cannot be negative"
          }

          integration event OrderPlaced {
            orderId: OrderId
            total: Decimal
          }

          publishes OrderPlaced

          aggregate Order root Order {
            event OrderSubmitted { orderId: OrderId }

            value OrderLine {
              product: ProductId
              quantity: Int
              unitPrice: Money
            }

            entity Order identified by OrderId {
              customer: CustomerId
              lines: List<OrderLine>
              status: OrderStatus = Draft

              states status {
                Draft -> Submitted, Cancelled
                Submitted -> Paid, Cancelled
                Paid -> Shipped, Cancelled
                Shipped
                Cancelled
              }

              command submit {
                requires status == Draft "only a draft order can be submitted"
                status -> Submitted
                emit OrderSubmitted(orderId: id)
              }
            }
          }
        }

        context Shipping {
          subscribes Ordering.OrderPlaced
          value Parcel { ref: String }
        }

        contextmap {
          Ordering -> Shipping : open-host
        }
        """;

    private static IReadOnlyDictionary<string, IReadOnlyList<DiagramDescriptor>> Descriptors()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(
            new[] { new SourceFile("ordering.koi", Fixture) });
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();

        var byFile = new DocsEmitter().EmitDiagrams(model);
        byFile.ShouldNotBeEmpty();
        return byFile;
    }

    [Fact]
    public void Every_node_has_a_real_span_qualified_name_and_unique_id()
    {
        foreach (var (file, descriptors) in Descriptors())
        {
            foreach (DiagramDescriptor descriptor in descriptors)
            {
                DiagramGraph graph = descriptor.Graph;

                graph.Nodes.ShouldNotBeEmpty($"{file}/{descriptor.Caption} should have nodes");

                foreach (DiagramNode node in graph.Nodes)
                {
                    node.QualifiedName.ShouldNotBeNullOrEmpty(
                        $"node {node.Id} in {file}/{descriptor.Caption} needs a qualified name");
                    node.Span.ShouldNotBeNull(
                        $"node {node.Id} in {file}/{descriptor.Caption} needs a span");
                    node.Span!.Value.IsNone.ShouldBeFalse(
                        $"node {node.Id} in {file}/{descriptor.Caption} must not have the None span");
                    node.Kind.ShouldNotBeNullOrEmpty();
                }

                // Ids are unique within a single graph.
                var ids = graph.Nodes.Select(n => n.Id).ToList();
                ids.Distinct(StringComparer.Ordinal).Count().ShouldBe(
                    ids.Count, $"{file}/{descriptor.Caption} has duplicate node ids");
            }
        }
    }

    [Fact]
    public void Every_edge_references_existing_nodes_in_its_own_graph()
    {
        foreach (var (file, descriptors) in Descriptors())
        {
            foreach (DiagramDescriptor descriptor in descriptors)
            {
                DiagramGraph graph = descriptor.Graph;
                var ids = graph.Nodes.Select(n => n.Id).ToHashSet(StringComparer.Ordinal);

                foreach (DiagramEdge edge in graph.Edges)
                {
                    ids.ShouldContain(edge.From,
                        $"edge {edge.From}->{edge.To} in {file}/{descriptor.Caption} has an unknown source");
                    ids.ShouldContain(edge.To,
                        $"edge {edge.From}->{edge.To} in {file}/{descriptor.Caption} has an unknown target");
                }
            }
        }
    }

    [Fact]
    public void Diagrams_are_grouped_under_the_file_they_appear_in()
    {
        var byFile = Descriptors();

        // The Ordering context doc carries a state-machine diagram and the context class diagram.
        byFile.ShouldContainKey("docs/Ordering.md");
        var orderingKinds = byFile["docs/Ordering.md"].Select(d => d.Kind).ToList();
        orderingKinds.ShouldContain("statemachine");
        orderingKinds.ShouldContain("context");

        // The strategic views each have their own file.
        byFile.ShouldContainKey("docs/context-map.md");
        byFile["docs/context-map.md"].ShouldHaveSingleItem().Kind.ShouldBe("contextmap");

        byFile.ShouldContainKey("docs/integration-events.md");
        byFile["docs/integration-events.md"].ShouldHaveSingleItem().Kind.ShouldBe("integration-events");
    }

    [Fact]
    public void Mermaid_carried_on_each_descriptor_matches_the_emitted_markdown()
    {
        // The descriptor's Mermaid is the same fenced snippet embedded in the emitted Markdown,
        // so the structured graph and the rendered diagram never drift.
        var (model, _) = new KoineCompiler().Parse(new[] { new SourceFile("ordering.koi", Fixture) });
        var emitter = new DocsEmitter();
        var files = emitter.Emit(model!);
        var byFile = emitter.EmitDiagrams(model!);

        foreach (var (path, descriptors) in byFile)
        {
            var contents = files.Single(f => f.RelativePath == path).Contents;
            foreach (DiagramDescriptor descriptor in descriptors)
            {
                descriptor.Mermaid.ShouldNotBeNullOrEmpty();
                contents.ShouldContain(descriptor.Mermaid);
            }
        }
    }

    [Fact]
    public void Aggregate_root_node_carries_stereotype_and_member_rows_for_id_and_fields()
    {
        DiagramGraph context = ContextGraph();

        DiagramNode rootNode = context.Nodes
            .Where(n => n.Kind == "aggregate-root")
            .ToList()
            .ShouldHaveSingleItem();

        rootNode.Stereotype.ShouldBe("aggregate root");
        rootNode.Members.ShouldNotBeNull();
        rootNode.Members!.ShouldNotBeEmpty();

        // The synthetic identity row plus every declared concrete field reads source-like.
        var fields = rootNode.Members!.Where(m => m.Kind == "field").Select(m => m.Text).ToList();
        fields.ShouldContain("id: OrderId");
        fields.ShouldContain("customer: CustomerId");
        fields.ShouldContain("lines: List<OrderLine>");
        fields.ShouldContain("status: OrderStatus");

        // The command surfaces as a method row (commands/factories live in the method compartment).
        rootNode.Members!.ShouldContain(m => m.Kind == "method" && m.Text.StartsWith("submit("));
    }

    [Fact]
    public void Versioned_aggregate_roots_synthetic_version_row_uses_the_koine_Int_type_name()
    {
        // A `versioned` aggregate injects a synthetic optimistic-concurrency row. It must read like
        // every other field — the target-agnostic Koine primitive `Int`, not the lowercase C# `int`
        // that would leak the emitter primitive into the diagram/inspector model Studio renders
        // verbatim (#532). The C# emitter still emits `public int Version`; only the label changes.
        const string source = """
            context Billing {
              aggregate Subscriptions root Subscription versioned {
                entity Subscription identified by SubscriptionId {
                  failedAttempts: Int
                }
              }
            }
            """;

        var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("billing.koi", source) });
        diagnostics.ShouldBeEmpty();
        DiagramGraph context = new DocsEmitter().EmitDiagrams(model!)["docs/Billing.md"]
            .First(d => d.Kind == "context").Graph;

        DiagramNode rootNode = context.Nodes
            .Where(n => n.Kind == "aggregate-root")
            .ToList()
            .ShouldHaveSingleItem();

        var fields = rootNode.Members!.Where(m => m.Kind == "field").Select(m => m.Text).ToList();
        fields.ShouldContain("version: Int"); // the Koine primitive name, consistent with sibling rows
        fields.ShouldNotContain("version: int"); // not the lowercase C# emitter primitive
    }

    [Fact]
    public void Value_object_node_carries_its_invariants_as_business_rules()
    {
        DiagramGraph context = ContextGraph();

        DiagramNode money = context.Nodes.First(n => n.Kind == "value-object" && n.Label == "Money");

        // Invariants ride on a dedicated DiagramNode field (NOT the member rows) so the inspector's
        // Rules tab can surface them; the declared message is carried verbatim (matching the docs).
        money.Invariants.ShouldNotBeNull();
        money.Invariants!.ShouldContain("an amount cannot be negative");

        // A node with no invariants leaves the field null (compact wire) — the enum proves it.
        DiagramNode status = context.Nodes.First(n => n.Kind == "enum");
        status.Invariants.ShouldBeNull();
    }

    [Fact]
    public void Enum_node_carries_its_values_as_value_members()
    {
        // A nested enum (declared inside the aggregate) is drawn in the aggregate class diagram; the
        // shared fixture's OrderStatus is context-level, so use a model whose enum is aggregate-nested.
        const string source = """
            context Catalog {
              aggregate Product root Product {
                enum Availability { InStock, Backordered, Discontinued }

                entity Product identified by ProductId {
                  availability: Availability = InStock
                }
              }
            }
            """;

        var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("catalog.koi", source) });
        diagnostics.ShouldBeEmpty();

        DiagramGraph context = new DocsEmitter().EmitDiagrams(model!)["docs/Catalog.md"]
            .First(d => d.Kind == "context").Graph;

        DiagramNode enumNode = context.Nodes.First(n => n.Kind == "enum");
        enumNode.Stereotype.ShouldBe("enumeration");
        enumNode.Members.ShouldNotBeNull();

        var values = enumNode.Members!.Where(m => m.Kind == "value").Select(m => m.Text).ToList();
        values.ShouldBe(new[] { "InStock", "Backordered", "Discontinued" });
    }

    [Fact]
    public void Derived_member_surfaces_as_a_computed_member_distinct_from_fields()
    {
        const string source = """
            context Sales {
              aggregate Cart root Cart {
                value Line {
                  quantity: Int
                  unitPrice: Int
                  subtotal: Int = quantity * unitPrice
                }

                entity Cart identified by CartId {
                  lines: List<Line>
                }
              }
            }
            """;
        var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("sales.koi", source) });
        diagnostics.ShouldBeEmpty();

        DiagramDescriptor context = new DocsEmitter().EmitDiagrams(model!)["docs/Sales.md"]
            .First(d => d.Kind == "context");

        DiagramNode line = context.Graph.Nodes.First(n => n.Kind == "value-object" && n.Label == "Line");

        // The derived field is present, classified "computed", with source-like text — and it is
        // NOT also reported as a plain field.
        line.Members!.ShouldContain(m => m.Kind == "computed" && m.Text == "subtotal: Int");
        line.Members!.ShouldNotContain(m => m.Kind == "field" && m.Text.StartsWith("subtotal"));

        // Mermaid uses UML derived-attribute notation: a leading '/' on the name.
        context.Mermaid.ShouldContain("/subtotal");
    }

    [Fact]
    public void State_and_context_nodes_stay_simple_boxes_without_members()
    {
        // Only the class diagram (kind "context") carries stereotypes + member rows; the lifecycle,
        // context-map and integration-event diagrams stay simple boxes.
        foreach (var (_, descriptors) in Descriptors())
        {
            foreach (DiagramDescriptor descriptor in descriptors
                .Where(d => d.Kind is "statemachine" or "contextmap" or "integration-events"))
            {
                foreach (DiagramNode node in descriptor.Graph.Nodes)
                {
                    node.Stereotype.ShouldBeNull(
                        $"{descriptor.Kind} node {node.Id} should stay a simple box (no stereotype)");
                    (node.Members ?? []).ShouldBeEmpty(
                        $"{descriptor.Kind} node {node.Id} should stay a simple box (no members)");
                }
            }
        }
    }

    [Fact]
    public void Composition_edges_carry_the_cardinality_derived_from_the_koine_field_type()
    {
        const string source = """
            context Sales {
              aggregate Order root Order {
                value Money { amount: Decimal }
                value OrderLine { product: ProductId quantity: Int }
                value Address { street: String }

                entity Order identified by OrderId {
                  lines: List<OrderLine>
                  total: Money
                  shipTo: Address?
                }
              }
            }
            """;

        var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("sales.koi", source) });
        diagnostics.ShouldBeEmpty();
        DiagramGraph context = new DocsEmitter().EmitDiagrams(model!)["docs/Sales.md"]
            .First(d => d.Kind == "context").Graph;

        string? CardinalityTo(string nodeId) =>
            context.Edges.First(e => e.From == "Order" && e.To == nodeId).Cardinality;

        // The cardinality comes from the Koine field type, not a string heuristic on the diagram.
        CardinalityTo("OrderLine").ShouldBe("*"); // lines: List<OrderLine> — a collection
        CardinalityTo("Money").ShouldBe("1"); // total: Money — a required single reference
        CardinalityTo("Address").ShouldBe("0..1"); // shipTo: Address? — an optional reference
    }

    [Fact]
    public void Identity_reference_to_an_in_context_entity_draws_an_association_edge()
    {
        // An aggregate that references another entity by its identity type (the DDD "reference other
        // aggregates by id" rule — `customer: CustomerId` → the Customer entity) must still be connected
        // on the diagram. It is an association, not a composition: holding another aggregate's id is a
        // reference, not ownership, so it draws as an arrow (no owner diamond).
        const string source = """
            context Billing {
              entity Customer identified by CustomerId {
                name: String
              }

              aggregate Sales root Order {
                entity Order identified by OrderId {
                  customer: CustomerId
                }
              }
            }
            """;

        var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("billing.koi", source) });
        diagnostics.ShouldBeEmpty();
        DiagramGraph context = new DocsEmitter().EmitDiagrams(model!)["docs/Billing.md"]
            .First(d => d.Kind == "context").Graph;

        DiagramEdge? edge = context.Edges.FirstOrDefault(e => e.From == "Order" && e.To == "Customer");
        edge.ShouldNotBeNull(); // the missing connector this regression test guards
        edge.ArrowKind.ShouldBe("association"); // a by-id reference, not an owning composition
        edge.Cardinality.ShouldBe("1"); // `customer: CustomerId` — a required single reference
        edge.SourceCardinality.ShouldBeNull(); // an association has no owner-end diamond/multiplicity
        edge.BackingMember.ShouldBe("Billing.Order.customer"); // the field a visual editor would remove
    }

    [Fact]
    public void Event_nodes_carry_their_doc_description_only_when_documented()
    {
        // The Events table's "When" column is sourced from this field (issue #170): a documented event
        // carries its `///` text on the node; an undocumented one leaves it null (the renderer shows `—`).
        const string source = """
            context Ordering {
              /// Published to other contexts once an order is accepted.
              integration event OrderPlaced {
                orderId: OrderId
              }

              integration event OrderArchived {
                orderId: OrderId
              }

              publishes OrderPlaced
              publishes OrderArchived

              aggregate Order root Order {
                /// Recorded when an order is submitted for fulfilment.
                event OrderSubmitted { orderId: OrderId }

                event OrderCancelled { orderId: OrderId }

                entity Order identified by OrderId {
                  customer: CustomerId
                }
              }
            }
            """;

        var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("ordering.koi", source) });
        diagnostics.ShouldBeEmpty();
        var byFile = new DocsEmitter().EmitDiagrams(model!);

        // Domain events draw as class nodes (kind "event") in the context class diagram.
        DiagramGraph context = byFile["docs/Ordering.md"].First(d => d.Kind == "context").Graph;
        DiagramNode submitted = context.Nodes.First(n => n.Kind == "event" && n.Label == "OrderSubmitted");
        submitted.Doc.ShouldBe("Recorded when an order is submitted for fulfilment.");
        DiagramNode cancelled = context.Nodes.First(n => n.Kind == "event" && n.Label == "OrderCancelled");
        cancelled.Doc.ShouldBeNull();

        // Integration events are nodes (kind "integration-event") in the integration-event flow.
        DiagramGraph flow = byFile["docs/integration-events.md"].First(d => d.Kind == "integration-events").Graph;
        DiagramNode placed = flow.Nodes.First(n => n.Kind == "integration-event" && n.Label.EndsWith("OrderPlaced"));
        placed.Doc.ShouldBe("Published to other contexts once an order is accepted.");
        DiagramNode archived = flow.Nodes.First(n => n.Kind == "integration-event" && n.Label.EndsWith("OrderArchived"));
        archived.Doc.ShouldBeNull();

        // Non-event nodes never carry a doc on the wire (the field is event-only).
        context.Nodes.Where(n => n.Kind is not "event").ShouldAllBe(n => n.Doc == null);
    }

    /// <summary>
    /// The event-flow chain (issue #439): the context class-diagram graph also carries a <c>command</c>
    /// node per command/factory and a <c>policy</c> node per policy, wired into the existing domain
    /// <c>event</c> nodes by the directed chain <c>command --emits--&gt; event --triggers--&gt; policy
    /// --issues--&gt; command</c>, so Studio's Flow canvas renders the whole producer/reactor chain.
    /// </summary>
    [Fact]
    public void Command_and_policy_nodes_complete_the_event_flow_chain()
    {
        DiagramGraph graph = PaymentContextGraph();

        // A command node per command (here the `capture` command emits the event) and the issued `record`
        // command, plus a policy node — all carrying source-jump qualified names. They are NOT events, so
        // they stay simple boxes (no stereotype/members) and carry no "When" doc.
        DiagramNode capture = graph.Nodes.First(n => n.Kind == "command" && n.Label == "capture");
        capture.QualifiedName.ShouldBe("Payment.Charge.capture");
        capture.Stereotype.ShouldBeNull();
        (capture.Members ?? []).ShouldBeEmpty();
        capture.Doc.ShouldBeNull();

        DiagramNode record = graph.Nodes.First(n => n.Kind == "command" && n.Label == "record");
        record.QualifiedName.ShouldBe("Payment.LedgerEntry.record");

        DiagramNode policy = graph.Nodes.First(n => n.Kind == "policy" && n.Label == "PostToLedger");
        policy.QualifiedName.ShouldBe("Payment.PostToLedger");
        policy.Stereotype.ShouldBeNull();
        (policy.Members ?? []).ShouldBeEmpty();

        // The complete chain: command --emits--> event --triggers--> policy --issues--> command.
        DiagramNode captured = graph.Nodes.First(n => n.Kind == "event" && n.Label == "ChargeCaptured");
        graph.Edges.ShouldContain(e => e.From == capture.Id && e.To == captured.Id && e.Label == "emits");
        graph.Edges.ShouldContain(e => e.From == captured.Id && e.To == policy.Id && e.Label == "triggers");
        graph.Edges.ShouldContain(e => e.From == policy.Id && e.To == record.Id && e.Label == "issues");
    }

    /// <summary>A two-aggregate context with a full command → event → policy → command chain (mirrors the
    /// pizzeria/saas payment context): <c>capture</c> emits <c>ChargeCaptured</c>; the <c>PostToLedger</c>
    /// policy reacts and issues <c>Books.record</c>.</summary>
    private const string PaymentFixture = """
        context Payment {
          enum ChargeStatus { Authorized, Captured }

          event ChargeCaptured {
            charge: ChargeId
            capturedAmount: Decimal
          }

          aggregate Billing root Charge {
            entity Charge identified by ChargeId {
              amount: Decimal
              status: ChargeStatus = Authorized

              states status {
                Authorized -> Captured
                Captured
              }

              command capture {
                requires status == Authorized "only an authorized charge can be captured"
                status -> Captured
                emit ChargeCaptured(charge: id, capturedAmount: amount)
              }
            }
          }

          aggregate Books root LedgerEntry {
            entity LedgerEntry identified by LedgerEntryId {
              balance: Decimal

              command record(amount: Decimal) {
                balance -> amount
              }
            }
          }

          policy PostToLedger when ChargeCaptured then Books.record(amount: capturedAmount)
        }
        """;

    /// <summary>The Payment context's class-diagram graph (carrying the command/policy event-flow chain).</summary>
    private static DiagramGraph PaymentContextGraph()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(new[] { new SourceFile("payment.koi", PaymentFixture) });
        diagnostics.ShouldBeEmpty();
        return new DocsEmitter().EmitDiagrams(model!)["docs/Payment.md"].First(d => d.Kind == "context").Graph;
    }

    /// <summary>The Ordering context's class-diagram graph from the fixture.</summary>
    private static DiagramGraph ContextGraph() =>
        Descriptors()["docs/Ordering.md"].First(d => d.Kind == "context").Graph;

    [Fact]
    public Task Diagram_graphs_snapshot()
    {
        var (model, _) = new KoineCompiler().Parse(new[] { new SourceFile("ordering.koi", Fixture) });
        var byFile = new DocsEmitter().EmitDiagrams(model!);
        return Verify(RenderDescriptors(byFile)).UseDirectory("Snapshots");
    }

    /// <summary>Stable, human-reviewable rendering of the descriptors for the Verify snapshot.</summary>
    private static string RenderDescriptors(
        IReadOnlyDictionary<string, IReadOnlyList<DiagramDescriptor>> byFile)
    {
        var sb = new System.Text.StringBuilder();
        foreach (var path in byFile.Keys.OrderBy(p => p, StringComparer.Ordinal))
        {
            sb.Append("==== ").Append(path).Append(" ====\n");
            foreach (DiagramDescriptor descriptor in byFile[path])
            {
                sb.Append("-- diagram: ").Append(descriptor.Caption)
                  .Append(" [").Append(descriptor.Kind).Append("]\n");
                sb.Append("  nodes:\n");
                foreach (DiagramNode node in descriptor.Graph.Nodes)
                {
                    SourceSpan span = node.Span!.Value;
                    sb.Append("    ").Append(node.Id)
                      .Append(" | ").Append(node.Kind)
                      .Append(" | ").Append(node.QualifiedName)
                      .Append(" | \"").Append(node.Label).Append('"');
                    if (node.Stereotype is not null)
                    {
                        sb.Append(" | «").Append(node.Stereotype).Append('»');
                    }

                    sb.Append(" @ ").Append(span.Line).Append(':').Append(span.Column)
                      .Append('-').Append(span.EndLine).Append(':').Append(span.EndColumn)
                      .Append('\n');

                    foreach (DiagramMember member in node.Members ?? [])
                    {
                        sb.Append("      • [").Append(member.Kind).Append("] ")
                          .Append(member.Text).Append('\n');
                    }
                }

                sb.Append("  edges:\n");
                foreach (DiagramEdge edge in descriptor.Graph.Edges)
                {
                    sb.Append("    ").Append(edge.From).Append(" -> ").Append(edge.To);
                    if (edge.Label is not null)
                    {
                        sb.Append(" : ").Append(edge.Label);
                    }

                    sb.Append('\n');
                }
            }
        }

        return sb.ToString();
    }
}
