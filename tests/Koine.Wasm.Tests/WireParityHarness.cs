using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Cli;

namespace Koine.Wasm.Tests;

/// <summary>
/// The shared, domain-agnostic plumbing for the dual-backend <b>wire-parity</b> suite. Every parity
/// test asserts that the stdio LSP server (<see cref="LspServer"/>) and the in-browser WASM JSExport
/// surface (<see cref="Koine.Wasm.CompilerInterop"/>) emit <b>byte-for-byte identical</b> JSON for the
/// requests Koine Studio relies on. The framing, the LSP-session driving and the order-insensitive JSON
/// canonicalization are identical across those tests, so they live here once (issue #304) — each parity
/// test keeps only its own fixture, the request it drives, the WASM export it calls, and its assertions.
/// </summary>
internal static class WireParityHarness
{
    /// <summary>Wraps a JSON-RPC body in a <c>Content-Length</c>-framed message (UTF-8 body, byte count).</summary>
    public static byte[] Frame(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        return header.Concat(body).ToArray();
    }

    /// <summary>The <c>initialize</c> handshake frame every session opens with.</summary>
    public static byte[] Initialize() =>
        Frame("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}");

    /// <summary>A <c>textDocument/didOpen</c> notification frame for <paramref name="uri"/> / <paramref name="text"/>.</summary>
    public static byte[] DidOpen(string uri, string text) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "textDocument/didOpen",
            @params = new { textDocument = new { uri, languageId = "koine", version = 1, text } },
        }));

    /// <summary>Feeds the framed <paramref name="messages"/> through a fresh <see cref="LspServer"/> and returns the raw transcript.</summary>
    public static byte[] RunSession(params byte[][] messages)
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

    /// <summary>
    /// Splits a concatenated LSP stdout stream into its JSON message bodies. Works on the raw bytes
    /// because <c>Content-Length</c> is a UTF-8 BYTE count, not a char count — a payload can carry
    /// multi-byte characters (e.g. Mermaid box-drawing), so a char-indexed split would desync.
    /// </summary>
    public static IEnumerable<string> Frames(byte[] output)
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

    /// <summary>
    /// The <c>result</c> node (object <i>or</i> array) of the framed response correlated to
    /// <paramref name="id"/>, or <c>null</c> if no such response carries a result.
    /// </summary>
    public static JsonNode? ResultForId(byte[] output, int id)
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
                return result;
            }
        }

        return null;
    }

    /// <summary>
    /// Convenience for the common parity shape: open <paramref name="uri"/>/<paramref name="text"/>,
    /// drive one request (with <c>textDocument = { uri }</c> merged into <paramref name="extraParams"/>),
    /// and return its <c>result</c> node. Tests that don't open a document drive the primitives directly.
    /// </summary>
    public static JsonNode? LspResult(string uri, string text, string method, object extraParams, int id = 99)
    {
        var paramsObj = JsonSerializer.SerializeToNode(extraParams)!.AsObject();
        paramsObj["textDocument"] = new JsonObject { ["uri"] = uri };
        var request = Frame(JsonSerializer.Serialize(new { jsonrpc = "2.0", id, method, @params = paramsObj }));
        var output = RunSession(Initialize(), DidOpen(uri, text), request);
        return ResultForId(output, id);
    }

    /// <summary>
    /// Canonical JSON text for deep, <b>key-order-independent</b> equality of a subtree: object keys are
    /// sorted recursively so the comparison asserts the same fields with the same values, regardless of
    /// the order each serializer happens to write them (the LSP dict vs. the WASM source-gen DTO).
    /// </summary>
    public static string Canonical(JsonNode? node) => Sort(node)?.ToJsonString() ?? "null";

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
