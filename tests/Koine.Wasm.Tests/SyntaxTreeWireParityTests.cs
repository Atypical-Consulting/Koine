using System.Text.Json;
using System.Text.Json.Nodes;
using Koine.Compiler;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the active-buffer syntax tree (issue #890). The <c>koine/syntaxTree</c>
/// projection must serialize <b>field-for-field identically</b> over the stdio LSP server
/// (<see cref="Koine.Cli.LspServer"/>, hand-written camelCase dict keys) and the in-browser WASM JSExport
/// surface (<see cref="Koine.Wasm.CompilerInterop"/>, source-gen CamelCase DTOs). This suite is the guard
/// for issue #1099: after collapsing the triplicated span shape (the syntax tree now reuses the
/// pre-existing <c>SourceSpan</c>/<c>WSourceSpan</c>/<c>MapSourceSpan</c> shapes instead of the deleted
/// <c>SyntaxSpan</c>/<c>WSyntaxSpan</c>/<c>SyntaxSpanJson</c>), the node's <c>span</c> keeps exactly the
/// keys <c>line, column, endLine, endColumn, offset, length, file</c> with the same values on both hosts —
/// declaration/field order is free to change because every consumer reads by key name.
/// </summary>
public class SyntaxTreeWireParityTests
{
    private const string Uri = "file:///ordering.koi";

    private const string Fixture =
        "context Ordering {\n" +
        "  value Money { amount: Decimal }\n" +
        "  enum OrderStatus { Draft, Placed }\n" +
        "}\n";

    private static readonly string[] SpanKeys =
        { "line", "column", "endLine", "endColumn", "offset", "length", "file" };

    [Fact]
    public void Wasm_syntaxTree_span_exposes_the_seven_camelCase_keys_matching_the_source_span()
    {
        var root = WasmSyntaxTree(Uri, Fixture);

        // The root (KoineModel) node carries the all-zero SourceSpan.None sentinel. Now that
        // WSyntaxNode.Span reuses WSourceSpan (WSyntaxSpan is gone), it MUST still serialize as a
        // NON-null object with all seven camelCase keys — line 0, file JSON-null — so Studio's
        // `span.line > 0` root guard keeps working.
        var rootSpan = root["span"]!.AsObject();
        AssertSpanKeys(rootSpan);
        ((int)rootSpan["line"]!).ShouldBe(0);
        rootSpan.ContainsKey("file").ShouldBeTrue();
        rootSpan["file"].ShouldBeNull(); // file: JSON null on the root

        // A real child (the `context Ordering` declaration) carries the 1-based source position.
        var context = root["children"]!.AsArray().First()!.AsObject();
        var span = context["span"]!.AsObject();
        AssertSpanKeys(span);
        ((int)span["line"]!).ShouldBe(1); // the `context Ordering` line (1-based)
    }

    [Fact]
    public void Lsp_and_wasm_syntaxTree_serialize_to_the_same_wire_shape()
    {
        // The whole point of #1099: consolidating each host's span shape must leave the two hosts'
        // syntax-tree JSON byte-name-stable. Canonical() sorts keys, so this asserts the same keys with
        // the same values on both wires regardless of the (now file-first) field order.
        var lsp = LspSyntaxTree(Uri, Fixture);
        var wasm = WasmSyntaxTree(Uri, Fixture);

        Canonical(lsp).ShouldBe(
            Canonical(wasm),
            "the koine/syntaxTree tree must serialize identically over LSP and WASM");
    }

    private static void AssertSpanKeys(JsonObject span)
    {
        foreach (var key in SpanKeys)
        {
            span.ContainsKey(key).ShouldBeTrue($"span is missing '{key}'");
        }
    }

    /// <summary>Drives the real stdio LSP wire (<c>koine/syntaxTree</c>) and returns the root node object.</summary>
    private static JsonObject LspSyntaxTree(string uri, string text) =>
        LspResult(uri, text, "koine/syntaxTree", new { })!.AsObject();

    /// <summary>
    /// Drives the WASM JSExport <c>SyntaxTree</c> surface (the in-browser backend) and returns the root
    /// node object. <c>SyntaxTree</c> is marked <c>[SupportedOSPlatform("browser")]</c> for the JS-interop
    /// boundary, but its body is pure managed JSON in/out (no JS calls), so calling it on the test host is
    /// safe — hence the CA1416 suppression.
    /// </summary>
#pragma warning disable CA1416 // SyntaxTree has no JS-interop in its body; safe to call off-browser in a parity test.
    private static JsonObject WasmSyntaxTree(string uri, string text)
    {
        var filesJson = JsonSerializer.Serialize(new[] { new { uri, text } });
        var json = CompilerInterop.SyntaxTree(filesJson, uri);
        return JsonNode.Parse(json)!.AsObject();
    }
#pragma warning restore CA1416
}
