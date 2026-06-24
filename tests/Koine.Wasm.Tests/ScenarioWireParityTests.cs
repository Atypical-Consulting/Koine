using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Cli;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the scenario runner (#149, <c>koine/runScenario</c>). The same
/// <see cref="Koine.Compiler.Services.ScenarioService"/> must produce <b>byte-for-byte identical</b>
/// JSON over the stdio LSP server (<see cref="LspServer"/>) and the in-browser WASM JSExport surface
/// (<see cref="Koine.Wasm.CompilerInterop"/>). Parity is non-negotiable: the Studio scenario panel is
/// written against one response shape and must behave the same whether it runs on the Tauri (CLI) or
/// browser (WASM) backend. This is the automated form of "verify against both backends".
/// </summary>
public class ScenarioWireParityTests
{
    private const string Fixture = """
        context Ordering {
          enum OrderStatus { Draft, Placed, Shipped }
          aggregate Sales root Order {
            event OrderPlaced { orderId: OrderId  lineCount: Int }
            value OrderLine { product: ProductId  quantity: Int }
            entity Order identified by OrderId {
              lines:  List<OrderLine>
              status: OrderStatus = Draft
              invariant status == Draft when lines.isEmpty
              states status { Draft -> Placed  Placed -> Shipped }
              command place {
                requires status == Draft   "only a draft order can be placed"
                requires !lines.isEmpty    "cannot place an empty order"
                status -> Placed
                emit OrderPlaced(orderId: id, lineCount: lines.count)
              }
            }
          }
        }
        """;

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = "file:///t.koi", text = Fixture } });

    // CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary, but
    // their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmRunScenario(string target, string operation, object given, object args) =>
        CompilerInterop.RunScenario(
            FilesJson(), target, operation, JsonSerializer.Serialize(given), JsonSerializer.Serialize(args));
#pragma warning restore CA1416

    [Fact]
    public void Placing_a_draft_order_is_identical_across_backends()
    {
        var given = new { status = "Draft", lines = new[] { new { product = "P1", quantity = 2 } } };
        object args = new { };

        JsonNode lsp = LspResult("koine/runScenario", new { target = "Order", operation = "place", given, args });
        JsonNode wasm = JsonNode.Parse(WasmRunScenario("Order", "place", given, args))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract the panel relies on.
        wasm["ok"]!.GetValue<bool>().ShouldBeTrue();
        Canonical(wasm).ShouldContain("OrderPlaced");
    }

    [Fact]
    public void Rejecting_a_non_draft_order_is_identical_across_backends()
    {
        var given = new { status = "Placed", lines = new[] { new { product = "P1", quantity = 1 } } };
        object args = new { };

        JsonNode lsp = LspResult("koine/runScenario", new { target = "Order", operation = "place", given, args });
        JsonNode wasm = JsonNode.Parse(WasmRunScenario("Order", "place", given, args))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["ok"]!.GetValue<bool>().ShouldBeFalse();
    }

    // ---- LSP driving + canonicalization (mirrors ModelRoundTripWireParityTests) ----

    private static JsonNode LspResult(string method, object extraParams)
    {
        var paramsObj = MergeParams(extraParams);
        var request = Frame(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = 99, method, @params = paramsObj }));
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", Fixture), request);
        return ResultForId(output, 99)!;
    }

    private static JsonObject MergeParams(object extra)
    {
        var obj = JsonSerializer.SerializeToNode(extra)!.AsObject();
        obj["textDocument"] = new JsonObject { ["uri"] = "file:///t.koi" };
        return obj;
    }

    private static string Canonical(JsonNode? node) => Sort(node)?.ToJsonString() ?? "null";

    private static JsonNode? Sort(JsonNode? node)
    {
        switch (node)
        {
            case JsonObject obj:
                var sorted = new JsonObject();
                foreach (var kv in obj.OrderBy(k => k.Key, StringComparer.Ordinal))
                {
                    sorted[kv.Key] = Sort(kv.Value?.DeepClone());
                }

                return sorted;
            case JsonArray arr:
                var copy = new JsonArray();
                foreach (var item in arr)
                {
                    copy.Add(Sort(item?.DeepClone()));
                }

                return copy;
            default:
                return node?.DeepClone();
        }
    }

    private static byte[] RunSession(params byte[][] messages)
    {
        using var input = new MemoryStream();
        foreach (var m in messages)
        {
            input.Write(m, 0, m.Length);
        }

        input.Position = 0;
        using var output = new MemoryStream();
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

    private static JsonObject? ResultForId(byte[] output, int id)
    {
        foreach (var body in Frames(output))
        {
            var node = JsonNode.Parse(body);
            if (node?["id"]?.GetValue<int>() == id && node["result"] is { } result)
            {
                return result.AsObject();
            }
        }

        return null;
    }

    private static IEnumerable<string> Frames(byte[] output)
    {
        var text = Encoding.UTF8.GetString(output);
        var i = 0;
        while (true)
        {
            var marker = text.IndexOf("Content-Length: ", i, StringComparison.Ordinal);
            if (marker < 0)
            {
                yield break;
            }

            var numStart = marker + "Content-Length: ".Length;
            var numEnd = text.IndexOf("\r\n", numStart, StringComparison.Ordinal);
            var len = int.Parse(text.Substring(numStart, numEnd - numStart));
            var bodyStart = text.IndexOf("\r\n\r\n", numEnd, StringComparison.Ordinal) + 4;
            yield return text.Substring(bodyStart, len);
            i = bodyStart + len;
        }
    }
}
