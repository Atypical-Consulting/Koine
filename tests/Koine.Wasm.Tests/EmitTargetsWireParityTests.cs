using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Cli;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the emit-target capability query (issue #282, <c>koine/emitTargets</c> /
/// <see cref="Koine.Wasm.CompilerInterop.ListEmitTargets"/>). The registry's
/// <see cref="Koine.Compiler.Emit.EmitterRegistry.SupportedTargetInfos"/> must produce <b>byte-for-byte
/// identical</b> JSON over the stdio LSP server (<see cref="LspServer"/>) and the in-browser WASM
/// JSExport surface, so Koine Studio's target picker is identical whether it runs on the Tauri (CLI) or
/// browser (WASM) backend. This is the automated form of "verify against both backends".
/// </summary>
public class EmitTargetsWireParityTests
{
    // CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary, but
    // ListEmitTargets has no JS interop in its body — safe to call off-browser in a parity test.
#pragma warning disable CA1416
    private static string WasmListEmitTargets() => CompilerInterop.ListEmitTargets();
#pragma warning restore CA1416

    [Fact]
    public void Emit_target_list_is_identical_across_backends()
    {
        JsonNode lsp = LspResult("koine/emitTargets");
        JsonNode wasm = JsonNode.Parse(WasmListEmitTargets())!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
    }

    [Fact]
    public void Wasm_list_carries_the_five_code_targets_with_metadata_and_excludes_glossary_and_docs()
    {
        var targets = JsonNode.Parse(WasmListEmitTargets())!["targets"]!.AsArray();

        targets.Select(t => t!["id"]!.GetValue<string>())
            .ShouldBe(["csharp", "typescript", "python", "php", "rust"]);

        var csharp = targets.First(t => t!["id"]!.GetValue<string>() == "csharp")!;
        csharp["displayName"]!.GetValue<string>().ShouldBe("C#");
        csharp["fileExtension"]!.GetValue<string>().ShouldBe(".cs");

        targets.Select(t => t!["id"]!.GetValue<string>()).ShouldNotContain("glossary");
        targets.Select(t => t!["id"]!.GetValue<string>()).ShouldNotContain("docs");
    }

    // ---- LSP driving + canonicalization (mirrors ScenarioWireParityTests) ----

    private static JsonNode LspResult(string method)
    {
        var request = Frame(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = 99, method, @params = new { } }));
        var output = RunSession(Initialize(), request);
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
