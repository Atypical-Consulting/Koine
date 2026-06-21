using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Cli;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the model→<c>.koi</c> round-trip seam (#91). The same
/// <see cref="Koine.Compiler.Services.ModelRoundTripService"/> must serialize <b>field-for-field
/// identically</b> over the stdio LSP server (<see cref="LspServer"/>, hand-written camelCase dict
/// keys) and the in-browser WASM JSExport surface (<see cref="Koine.Wasm.CompilerInterop"/>,
/// source-gen CamelCase DTOs). Parity is non-negotiable: an unhandled or divergent WASM request
/// silently breaks the browser. This suite pins the contract the Studio editors are written against.
/// </summary>
public class ModelRoundTripWireParityTests
{
    private const string Fixture = """
        context Ordering {
          value Money { amount: Decimal }
          enum OrderStatus { Draft, Placed, Shipped }

          aggregate Order root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft
              states status {
                Draft -> Placed
                Placed -> Shipped
              }
            }
          }
        }
        """;

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = "file:///t.koi", text = Fixture } });

    // The CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary,
    // but their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmModel(string? qn) => Koine.Wasm.CompilerInterop.Model(FilesJson(), qn);
    private static string WasmModelMembers(string qn) => Koine.Wasm.CompilerInterop.ModelMembers(FilesJson(), qn);
    private static string WasmEmitKoine(string editJson) => Koine.Wasm.CompilerInterop.EmitKoine(FilesJson(), editJson);
    private static string WasmApplyModelEdit(string editJson) => Koine.Wasm.CompilerInterop.ApplyModelEdit(FilesJson(), editJson);
#pragma warning restore CA1416

    [Fact]
    public void Model_tree_is_identical_across_backends()
    {
        JsonNode lsp = LspModel(null);
        JsonNode wasm = JsonNode.Parse(WasmModel(null))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract the editors rely on.
        lsp["kind"]!.GetValue<string>().ShouldBe("model");
        Canonical(lsp).ShouldContain("Ordering.Money");
        Canonical(lsp).ShouldContain("Ordering.Order.Order.states.status");
    }

    [Fact]
    public void Scoped_model_node_is_identical_across_backends()
    {
        JsonNode lsp = LspModel("Ordering.Money");
        JsonNode wasm = JsonNode.Parse(WasmModel("Ordering.Money"))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["qualifiedName"]!.GetValue<string>().ShouldBe("Ordering.Money");
    }

    [Fact]
    public void Model_members_are_identical_across_backends()
    {
        JsonNode lsp = LspResult("koine/modelMembers", new { qualifiedName = "Ordering.OrderStatus" });
        JsonNode wasm = JsonNode.Parse(WasmModelMembers("Ordering.OrderStatus"))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("Draft");
    }

    [Fact]
    public void EmitKoine_is_identical_across_backends_for_a_legal_edit()
    {
        var edit = new { kind = "addField", target = "Ordering.Money", name = "tax", type = "Decimal" };
        JsonNode lsp = LspResult("koine/emitKoine", new { edit });
        JsonNode wasm = JsonNode.Parse(WasmEmitKoine(JsonSerializer.Serialize(edit)))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("tax: Decimal");
    }

    [Fact]
    public void EmitKoine_is_identical_across_backends_for_an_illegal_edit()
    {
        var edit = new { kind = "changeFieldType", target = "Ordering.Money.amount", type = "Nope" };
        JsonNode lsp = LspResult("koine/emitKoine", new { edit });
        JsonNode wasm = JsonNode.Parse(WasmEmitKoine(JsonSerializer.Serialize(edit)))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["koine"].ShouldBeNull();
        Canonical(wasm).ShouldContain("KOI0101");
    }

    [Fact]
    public void ApplyModelEdit_is_identical_across_backends()
    {
        var edit = new { kind = "addField", target = "Ordering.Money", name = "tax", type = "Decimal" };
        JsonNode lsp = LspResult("koine/applyModelEdit", new { edit });
        JsonNode wasm = JsonNode.Parse(WasmApplyModelEdit(JsonSerializer.Serialize(edit)))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["uri"]!.GetValue<string>().ShouldBe("file:///t.koi");
        wasm["edits"]!.AsArray().Count.ShouldBe(1);
    }

    // ---- LSP driving + canonicalization ----------------------------------

    private static JsonNode LspModel(string? qualifiedName) =>
        LspResult("koine/model", qualifiedName is null ? new { } : (object)new { qualifiedName });

    private static JsonNode LspResult(string method, object extraParams)
    {
        var paramsObj = MergeParams(method, extraParams);
        var request = Frame(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = 99, method, @params = paramsObj }));
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", Fixture), request);
        return ResultForId(output, 99)!;
    }

    private static JsonObject MergeParams(string method, object extra)
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

    // ---- Minimal LSP session harness (mirrors DiagramWireParityTests) -----

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
            if (node?["id"]?.GetValue<int>() == id && node["result"] is JsonNode result)
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
