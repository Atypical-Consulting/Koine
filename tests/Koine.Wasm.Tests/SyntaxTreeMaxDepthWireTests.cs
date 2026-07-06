using System.Text.Json;
using System.Text.Json.Nodes;

namespace Koine.Wasm.Tests;

/// <summary>
/// The browser WASM counterpart to the desktop LSP MaxDepth guard (#1098): a pathologically deep
/// expression chain must serialize through the source-gen <see cref="Koine.Wasm.CompilerInterop"/>
/// <c>[JSExport] SyntaxTree</c> instead of tripping the <c>System.Text.Json</c> default MaxDepth (64),
/// which the export's <c>try/catch</c> turns into the literal <c>"null"</c> — blanking Studio's
/// syntax-tree panel. Both hosts (this <c>LangJson</c> context and the stdio LSP's
/// <c>SerializerOptions</c>) keep an identical raised MaxDepth so the wire shape stays interchangeable.
/// </summary>
public class SyntaxTreeMaxDepthWireTests
{
    private const string Uri = "file:///deep.koi";

    // A long left-associative fold `1 + 1 + … + 1` nests one BinaryExpr per `+`, so the projected
    // WSyntaxNode tree — and its ~2×-deep JSON — blows past the default MaxDepth of 64.
    private static string DeepSource()
    {
        var fold = string.Join(" + ", Enumerable.Repeat("1", 80));
        return
            "context Deep {\n" +
            "  value N {\n" +
            "    amount: Int\n" +
            $"    invariant amount >= {fold} \"deep\"\n" +
            "  }\n" +
            "}\n";
    }

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = Uri, text = DeepSource() } });

    // CompilerInterop.SyntaxTree is [SupportedOSPlatform("browser")] for the JS-interop boundary, but
    // its body has no JS interop — safe to call off-browser in a wire test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmSyntaxTree() => CompilerInterop.SyntaxTree(FilesJson(), Uri);
#pragma warning restore CA1416

    [Fact]
    public void SyntaxTree_serializes_a_deep_chain_instead_of_falling_back_to_null()
    {
        var json = WasmSyntaxTree();

        // Before the #1098 fix: deep tree → JsonException → the export's catch → the literal "null",
        // so the panel silently blanks (the whole tree lost, not just the deep branch).
        json.ShouldNotBe("null");

        var root = JsonNode.Parse(json, documentOptions: new JsonDocumentOptions { MaxDepth = 256 })!;

        // The camelCase wire shape is intact …
        root["kind"]!.GetValue<string>().ShouldBe("KoineModel");
        // … and it preserves the full nesting rather than dropping the deep branch.
        JsonTreeDepth(root).ShouldBeGreaterThanOrEqualTo(80);
    }

    /// <summary>Node-level nesting depth of a syntax-tree JSON node (counting its own level).</summary>
    private static int JsonTreeDepth(JsonNode node)
    {
        var max = 0;
        if (node["children"] is JsonArray kids)
        {
            foreach (var child in kids)
            {
                if (child is not null)
                {
                    max = Math.Max(max, JsonTreeDepth(child));
                }
            }
        }

        return max + 1;
    }
}
