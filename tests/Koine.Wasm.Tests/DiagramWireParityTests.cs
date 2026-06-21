using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Cli;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the structured diagram graphs (issue #93, task 2). The same
/// <see cref="Koine.Compiler.Emit.Docs.DocsEmitter"/> graph must serialize <b>field-for-field
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
    private static JsonArray LspDocsFiles()
    {
        var output = RunSession(Initialize(), DidOpen(Uri, Fixture), DocsRequest(Uri));
        var result = ResultForId(output, DocsRequestId);
        return result!["files"]!.AsArray();
    }

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

    /// <summary>
    /// Canonical JSON text for deep, <b>key-order-independent</b> equality of a subtree: object keys are
    /// sorted recursively so the comparison asserts the same fields with the same values, regardless of
    /// the order each serializer happens to write them (the LSP dict vs. the WASM source-gen DTO).
    /// </summary>
    private static string Canonical(JsonNode? node) => Sort(node)?.ToJsonString() ?? "null";

    private static JsonNode? Sort(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var sorted = new JsonObject();
                foreach (var (key, value) in obj.OrderBy(kvp => kvp.Key, StringComparer.Ordinal))
                {
                    sorted[key] = Sort(value);
                }

                return sorted;
            case JsonArray array:
                var copy = new JsonArray();
                foreach (var item in array)
                {
                    copy.Add(Sort(item));
                }

                return copy;
            default:
                return node?.DeepClone();
        }
    }

    // ---- LSP wire harness (mirrors LspServerTests) ---------------------------

    private const int DocsRequestId = 31;

    private static byte[] RunSession(params byte[][] messages)
    {
        var input = new MemoryStream(messages.SelectMany(m => m).ToArray());
        var output = new MemoryStream();
        new LspServer(input, output).Loop();
        return output.ToArray();
    }

    private static byte[] Frame(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        return header.Concat(body).ToArray();
    }

    private static byte[] Initialize() =>
        Frame("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}");

    private static byte[] DidOpen(string uri, string text) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "textDocument/didOpen",
            @params = new { textDocument = new { uri, languageId = "koine", version = 1, text } },
        }));

    private static byte[] DocsRequest(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = DocsRequestId,
            method = "koine/docs",
            @params = new { textDocument = new { uri } },
        }));

    /// <summary>Parses the concatenated <c>Content-Length</c> frames and returns the <c>result</c> for one request id.</summary>
    private static JsonObject? ResultForId(byte[] output, int id)
    {
        foreach (var body in Frames(output))
        {
            var node = JsonNode.Parse(body);
            if (node is JsonObject obj
                && obj.TryGetPropertyValue("id", out var idNode)
                && idNode is not null
                && idNode.GetValue<int>() == id
                && obj.TryGetPropertyValue("result", out var result))
            {
                return result as JsonObject;
            }
        }

        return null;
    }

    /// <summary>
    /// Splits a concatenated LSP stdout stream into its JSON message bodies. Works on the raw bytes
    /// because <c>Content-Length</c> is a UTF-8 BYTE count, not a char count — the diagram payload
    /// carries multi-byte characters (the Mermaid box-drawing), so a char-indexed split would desync.
    /// </summary>
    private static IEnumerable<string> Frames(byte[] output)
    {
        var separator = "\r\n\r\n"u8.ToArray();
        var index = 0;
        while (index < output.Length)
        {
            var headerEnd = IndexOf(output, separator, index);
            if (headerEnd < 0)
            {
                yield break;
            }

            var header = Encoding.ASCII.GetString(output, index, headerEnd - index);
            var marker = header.IndexOf("Content-Length:", StringComparison.OrdinalIgnoreCase);
            var lengthText = header[(marker + "Content-Length:".Length)..].Trim();
            var length = int.Parse(lengthText);

            var bodyStart = headerEnd + separator.Length;
            yield return Encoding.UTF8.GetString(output, bodyStart, length);
            index = bodyStart + length;
        }
    }

    /// <summary>First index of <paramref name="needle"/> in <paramref name="haystack"/> at or after <paramref name="start"/>, or -1.</summary>
    private static int IndexOf(byte[] haystack, byte[] needle, int start)
    {
        for (var i = start; i <= haystack.Length - needle.Length; i++)
        {
            var match = true;
            for (var j = 0; j < needle.Length; j++)
            {
                if (haystack[i + j] != needle[j])
                {
                    match = false;
                    break;
                }
            }

            if (match)
            {
                return i;
            }
        }

        return -1;
    }
}
