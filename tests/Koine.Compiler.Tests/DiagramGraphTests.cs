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

        var byFile = new DocsEmitter().EmitDiagrams(model!);
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

        // The Ordering context doc carries a state-machine diagram and an aggregate diagram.
        byFile.ShouldContainKey("docs/Ordering.md");
        var orderingKinds = byFile["docs/Ordering.md"].Select(d => d.Kind).ToList();
        orderingKinds.ShouldContain("statemachine");
        orderingKinds.ShouldContain("aggregate");

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
                      .Append(" | \"").Append(node.Label).Append('"')
                      .Append(" @ ").Append(span.Line).Append(':').Append(span.Column)
                      .Append('-').Append(span.EndLine).Append(':').Append(span.EndColumn)
                      .Append('\n');
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
