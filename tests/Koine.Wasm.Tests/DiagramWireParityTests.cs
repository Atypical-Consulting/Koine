using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Compiler;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the structured diagram graphs (issue #93, task 2). The same
/// <see cref="DocsEmitter"/> graph must serialize <b>field-for-field
/// identically</b> over the stdio LSP server (<see cref="LspServer"/>, hand-written camelCase dict
/// keys) and the in-browser WASM JSExport surface (<see cref="Koine.Wasm.CompilerInterop"/>,
/// source-gen CamelCase DTOs). This suite is the guard the later Studio tasks (renderer, jump-to-source)
/// are written against: it pins the camelCase keys, the raw 1-based <c>sourceSpan</c>, and that
/// <c>sourceSpan.file</c> is populated.
/// </summary>
public class DiagramWireParityTests
{
    /// <summary>A model exercising all four diagram kinds: state machine, aggregate, integration event, context map.</summary>
    private const string Fixture = """
        context Ordering version 1 {
          enum OrderStatus { Draft, Submitted, Paid, Shipped, Cancelled }

          value Money {
            amount: Decimal
            invariant amount >= 0 "an amount cannot be negative"
          }

          /// Published once an order is accepted.
          integration event OrderPlaced {
            orderId: OrderId
            total: Decimal
          }

          publishes OrderPlaced

          aggregate Order root Order {
            /// Recorded when an order is submitted.
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

    private const string Uri = "file:///ordering.koi";

    [Fact]
    public void Lsp_and_wasm_docs_carry_an_identical_diagrams_substructure()
    {
        var lsp = LspDocsFiles();
        var wasm = WasmDocsFiles();

        // Both backends produced the same set of docs files.
        FilePaths(lsp).ShouldBe(FilePaths(wasm));

        // At least one file carries diagrams (the Ordering doc + the strategic views).
        lsp.Any(f => f!["diagrams"]!.AsArray().Count > 0)
            .ShouldBeTrue("the LSP docs payload should carry at least one diagram");
        wasm.Any(f => f!["diagrams"]!.AsArray().Count > 0)
            .ShouldBeTrue("the WASM docs payload should carry at least one diagram");

        // The diagrams substructure is field-for-field identical between the two backends.
        foreach (var path in FilePaths(lsp))
        {
            var lspDiagrams = lsp.Single(f => (string)f!["path"]! == path)!["diagrams"];
            var wasmDiagrams = wasm.Single(f => (string)f!["path"]! == path)!["diagrams"];

            Canonical(lspDiagrams).ShouldBe(
                Canonical(wasmDiagrams),
                $"diagrams for {path} must serialize identically over LSP and WASM");
        }
    }

    [Fact]
    public void Both_backends_expose_nodes_with_qualified_name_and_populated_source_span()
    {
        foreach (var files in new[] { LspDocsFiles(), WasmDocsFiles() })
        {
            var nodes = AllNodes(files).ToList();
            nodes.ShouldNotBeEmpty();

            // Every node carries a non-empty qualifiedName + a non-null sourceSpan.
            foreach (var node in nodes)
            {
                ((string?)node["qualifiedName"]).ShouldNotBeNullOrEmpty();
                node["sourceSpan"].ShouldNotBeNull();
            }

            // sourceSpan.file is populated for at least one node (Task 4 needs it for cross-file jump).
            nodes.Any(n => !string.IsNullOrEmpty((string?)n["sourceSpan"]!["file"]))
                .ShouldBeTrue("at least one node must carry a non-empty sourceSpan.file");
        }
    }

    [Fact]
    public void Diagram_node_uses_the_camelCase_sourceSpan_key_not_span()
    {
        // The contract key is "sourceSpan" (not "span"): Task 3/4 import these names. Guard both wires.
        foreach (var files in new[] { LspDocsFiles(), WasmDocsFiles() })
        {
            var node = AllNodes(files).First();
            node["sourceSpan"].ShouldNotBeNull();
            node.AsObject().ContainsKey("span").ShouldBeFalse();
            node.AsObject().ContainsKey("qualifiedName").ShouldBeTrue();
        }
    }

    [Fact]
    public void Both_backends_carry_stereotype_and_members_on_the_aggregate_class_node()
    {
        // The enriched class boxes (issue #93 follow-up): the aggregate-root node carries a non-null
        // camelCase "stereotype" and a non-empty "members" array of { text, kind } on BOTH backends.
        foreach (var files in new[] { LspDocsFiles(), WasmDocsFiles() })
        {
            var root = AllNodes(files).First(n => (string?)n["kind"] == "aggregate-root");

            ((string?)root["stereotype"]).ShouldBe("aggregate root");

            var members = root["members"]!.AsArray();
            members.Count.ShouldBeGreaterThan(0, "the class node must carry UML member rows");
            foreach (var member in members)
            {
                ((string?)member!["text"]).ShouldNotBeNullOrEmpty();
                ((string?)member["kind"]).ShouldNotBeNullOrEmpty();
            }

            // The identity row is always present and reads source-like.
            members.Select(m => (string?)m!["text"]).ShouldContain("id: OrderId");
        }
    }

    [Fact]
    public void Both_backends_carry_the_event_doc_for_the_when_column()
    {
        // Issue #170: the Events table's "When" column is sourced from node.doc — a documented event
        // carries its `///` text identically on BOTH wires (camelCase key "doc"); the canonical-equality
        // test guards they match, this pins the value and that it reaches the event nodes specifically.
        foreach (var files in new[] { LspDocsFiles(), WasmDocsFiles() })
        {
            var domainEvent = AllNodes(files).First(n => (string?)n["kind"] == "event");
            ((string?)domainEvent["doc"]).ShouldBe("Recorded when an order is submitted.");

            var integrationEvent = AllNodes(files).First(n => (string?)n["kind"] == "integration-event");
            ((string?)integrationEvent["doc"]).ShouldBe("Published once an order is accepted.");

            // The "When" field is event-only: a non-event class node (the aggregate root) carries no doc.
            AllNodes(files).First(n => (string?)n["kind"] == "aggregate-root")["doc"].ShouldBeNull();
        }
    }

    [Fact]
    public void Both_backends_keep_non_class_nodes_as_simple_boxes()
    {
        // State/context/integration nodes stay simple boxes: null stereotype + empty members, identically
        // serialized on both wires (the canonical-equality test already covers value parity).
        foreach (var files in new[] { LspDocsFiles(), WasmDocsFiles() })
        {
            var state = AllNodes(files).First(n => (string?)n["kind"] == "state");
            state["stereotype"].ShouldBeNull();
            state["members"]!.AsArray().Count.ShouldBe(0);
        }
    }

    // ---- backend drivers ------------------------------------------------------

    /// <summary>Drives the real stdio LSP wire (<c>koine/docs</c>) and returns the <c>result.files</c> array.</summary>
    private static JsonArray LspDocsFiles() =>
        LspResult(Uri, Fixture, "koine/docs", new { })!["files"]!.AsArray();

    /// <summary>
    /// Drives the WASM JSExport <c>Docs</c> surface (the in-browser backend) and returns its <c>files</c>
    /// array. <c>Docs</c> is marked <c>[SupportedOSPlatform("browser")]</c> for the JS-interop boundary,
    /// but its body is pure managed JSON in/out (no JS calls), so calling it on the test host is safe —
    /// hence the CA1416 suppression.
    /// </summary>
#pragma warning disable CA1416 // Docs has no JS-interop in its body; safe to call off-browser in a parity test.
    private static JsonArray WasmDocsFiles()
    {
        var filesJson = JsonSerializer.Serialize(new[] { new { uri = Uri, text = Fixture } });
        var json = CompilerInterop.Docs(filesJson);
        return JsonNode.Parse(json)!["files"]!.AsArray();
    }
#pragma warning restore CA1416

    // ---- shared assertions helpers -------------------------------------------

    private static IEnumerable<string> FilePaths(JsonArray files) =>
        files.Select(f => (string)f!["path"]!).OrderBy(p => p, StringComparer.Ordinal);

    private static IEnumerable<JsonObject> AllNodes(JsonArray files) =>
        from file in files
        from diagram in file!["diagrams"]!.AsArray()
        from node in diagram!["graph"]!["nodes"]!.AsArray()
        select node!.AsObject();
}
