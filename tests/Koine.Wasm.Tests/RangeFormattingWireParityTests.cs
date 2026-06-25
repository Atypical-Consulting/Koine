using System.Text.Json;
using System.Text.Json.Nodes;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the <c>textDocument/rangeFormatting</c> seam (#331, Task 2). Koine's
/// formatter is whole-document + idempotent, so range formatting is "format the whole document, take the
/// minimal changed line-region, intersect it with the requested selection." The same
/// <see cref="Koine.Compiler.Formatting.KoineFormatter"/> drives both the stdio LSP server
/// (<see cref="LspServer"/>, hand-written camelCase dict) and the in-browser WASM JSExport
/// (<see cref="Koine.Wasm.CompilerInterop"/>, source-gen DTO), which must serialize the clipped
/// <c>TextEdit[]</c> <b>field-for-field identically</b> — a divergence silently breaks Format Selection.
/// </summary>
public class RangeFormattingWireParityTests
{
    // Line 2 (`total: Money`) is over-indented (8 spaces); every other line is already canonical, so the
    // minimal changed region is exactly that one line — selecting it must yield one indentation-fixing edit.
    private const string Uri = "file:///t.koi";
    private const string Fixture =
        "context Sales {\n" +
        "  entity Order identified by OrderId {\n" +
        "        total: Money\n" +
        "  }\n" +
        "}\n";

    // The mis-indented line is index 2; select it whole (0-based LSP coordinates).
    private const int SelStartLine = 2;
    private const int SelStartChar = 0;
    private const int SelEndLine = 2;
    private const int SelEndChar = 20;

    // The CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary,
    // but their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmRangeFormat() =>
        CompilerInterop.FormatRange(Fixture, SelStartLine, SelStartChar, SelEndLine, SelEndChar);
#pragma warning restore CA1416

    [Fact]
    public void RangeFormatting_is_identical_across_backends()
    {
        JsonNode lsp = LspRangeFormat();
        JsonNode wasm = JsonNode.Parse(WasmRangeFormat())!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract: exactly one edit, re-indenting the selected line to canonical 4
        // spaces (the 8-space original is gone) without touching any line outside the selection.
        wasm.AsArray().Count.ShouldBe(1);
        wasm[0]!["newText"]!.GetValue<string>().ShouldBe("    total: Money\n");
        wasm[0]!["range"]!["start"]!["line"]!.GetValue<int>().ShouldBe(2);
    }

    // ---- LSP driving -------------------------------------------------------

    private static JsonNode LspRangeFormat() =>
        WireParityHarness.LspResult(Uri, Fixture, "textDocument/rangeFormatting", new
        {
            range = new
            {
                start = new { line = SelStartLine, character = SelStartChar },
                end = new { line = SelEndLine, character = SelEndChar },
            },
        })!;
}
