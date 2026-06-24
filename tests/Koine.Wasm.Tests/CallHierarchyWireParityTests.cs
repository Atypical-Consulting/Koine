using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Cli;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the inlay-hint and call-hierarchy seams (#260, Task 4). The same
/// <see cref="Koine.Compiler.Services.KoineLanguageService"/> must serialize <b>field-for-field
/// identically</b> over the stdio LSP server (<see cref="LspServer"/>, hand-written camelCase dict
/// keys) and the in-browser WASM JSExport surface (<see cref="Koine.Wasm.CompilerInterop"/>,
/// source-gen CamelCase DTOs). Parity is non-negotiable: a divergent WASM request silently breaks the
/// browser. This suite pins the contract the Studio client is written against for both features.
/// </summary>
public class CallHierarchyWireParityTests
{
    // One fixture exercising both seams: an `OrderRow` read model with a direct `total` field whose
    // type is inferred from `Order` (inlay Type hint), plus an `Order.place` command emitting
    // `OrderPlaced` (call hierarchy). Mirrors InlayHintTests / CallHierarchyTests syntax.
    private const string Uri = "file:///t.koi";
    private const string Fixture =
        "context Ordering {\n" +
        "  value Money { amount: Decimal currency: String }\n" +
        "\n" +
        "  event OrderPlaced {\n" +
        "    order: OrderId\n" +
        "  }\n" +
        "\n" +
        "  entity Order identified by OrderId {\n" +
        "    total: Money\n" +
        "    status: String\n" +
        "\n" +
        "    command place {\n" +
        "      emit OrderPlaced(order: id)\n" +
        "    }\n" +
        "  }\n" +
        "\n" +
        "  readmodel OrderRow from Order {\n" +
        "    total\n" +
        "    status\n" +
        "  }\n" +
        "}\n";

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = Uri, text = Fixture } });

    // The CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary,
    // but their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmInlay(int sl, int sc, int el, int ec) =>
        CompilerInterop.InlayHints(FilesJson(), Uri, sl, sc, el, ec);

    private static string WasmPrepare(int line, int character) =>
        CompilerInterop.PrepareCallHierarchy(FilesJson(), Uri, line, character);
#pragma warning restore CA1416

    [Fact]
    public void InlayHints_are_identical_across_backends()
    {
        JsonNode lsp = LspInlay(0, 0, 100, 0);
        JsonNode wasm = JsonNode.Parse(WasmInlay(0, 0, 100, 0))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract the client relies on: the inferred Type hint, LSP kind 1.
        Canonical(wasm).ShouldContain(": Money");
        Canonical(wasm).ShouldContain("\"kind\":1");
    }

    [Fact]
    public void PrepareCallHierarchy_is_identical_across_backends()
    {
        // `command place` — the cursor sits one column into `place` so TokenLocator selects it.
        var (line, character) = PositionOf("place", "command place");

        JsonNode lsp = LspPrepare(line, character);
        JsonNode wasm = JsonNode.Parse(WasmPrepare(line, character))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the LSP SymbolKind (Method=6) + the echoed `data` blob.
        Canonical(wasm).ShouldContain("\"name\":\"place\"");
        Canonical(wasm).ShouldContain("\"kind\":6");
        Canonical(wasm).ShouldContain("\"chKind\":\"Command\"");
        Canonical(wasm).ShouldContain("\"owningType\":\"Order\"");
    }

    // ---- position helper (mirrors CallHierarchyTests) ---------------------

    private static (int line, int character) PositionOf(string needle, string after)
    {
        var anchor = Fixture.IndexOf(after, StringComparison.Ordinal);
        var index = Fixture.IndexOf(needle, anchor, StringComparison.Ordinal) + 1;
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < index; i++)
        {
            if (Fixture[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return (line, index - lineStart);
    }

    // ---- LSP driving + canonicalization -----------------------------------

    private static JsonNode LspInlay(int sl, int sc, int el, int ec) =>
        LspArrayResult("textDocument/inlayHint", new
        {
            range = new
            {
                start = new { line = sl, character = sc },
                end = new { line = el, character = ec },
            },
        });

    private static JsonNode LspPrepare(int line, int character) =>
        LspArrayResult("textDocument/prepareCallHierarchy", new { position = new { line, character } });

    /// <summary>Drives the LSP server for an array-returning request and returns the result array node.</summary>
    private static JsonNode LspArrayResult(string method, object extraParams)
    {
        var paramsObj = JsonSerializer.SerializeToNode(extraParams)!.AsObject();
        paramsObj["textDocument"] = new JsonObject { ["uri"] = Uri };
        var request = Frame(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = 99, method, @params = paramsObj }));
        var output = RunSession(Initialize(), DidOpen(Uri, Fixture), request);
        return ResultForId(output, 99)!;
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

    // ---- Minimal LSP session harness (mirrors ModelRoundTripWireParityTests) ----

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

    /// <summary>The <c>result</c> node (array or object) of the framed response correlated to <paramref name="id"/>.</summary>
    private static JsonNode? ResultForId(byte[] output, int id)
    {
        foreach (var body in Frames(output))
        {
            var node = JsonNode.Parse(body);
            if (node?["id"]?.GetValue<int>() == id && node["result"] is { } result)
            {
                return result;
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
