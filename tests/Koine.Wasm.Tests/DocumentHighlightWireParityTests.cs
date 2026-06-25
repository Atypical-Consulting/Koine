using System.Text.Json;
using System.Text.Json.Nodes;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the <c>textDocument/documentHighlight</c> seam (#331, Task 1). The same
/// <see cref="Koine.Compiler.Services.KoineLanguageService"/> binder (<c>ReferencesAt</c>, filtered to
/// the active document) must serialize <b>field-for-field identically</b> over the stdio LSP server
/// (<see cref="LspServer"/>, hand-written camelCase dict keys) and the in-browser WASM JSExport surface
/// (<see cref="Koine.Wasm.CompilerInterop"/>, source-gen CamelCase DTOs). A divergent WASM request
/// silently breaks the browser editor's same-file occurrence highlighting, so parity is non-negotiable.
/// </summary>
public class DocumentHighlightWireParityTests
{
    // A single value (`Money`) referenced from two entity fields in the same file: clicking the
    // declaration must highlight the declaration + both usages. Mirrors the CallHierarchy fixture style.
    private const string Uri = "file:///t.koi";
    private const string Fixture =
        "context Ordering {\n" +
        "  value Money { amount: Decimal currency: String }\n" +
        "\n" +
        "  entity Order identified by OrderId {\n" +
        "    total: Money\n" +
        "    subtotal: Money\n" +
        "  }\n" +
        "}\n";

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = Uri, text = Fixture } });

    // The CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary,
    // but their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmHighlights(int line, int character) =>
        CompilerInterop.DocumentHighlightsAt(FilesJson(), Uri, line, character);
#pragma warning restore CA1416

    [Fact]
    public void DocumentHighlights_are_identical_across_backends()
    {
        // Cursor one column into the `Money` declaration name so TokenLocator selects it.
        var (line, character) = PositionOf("Money", "value Money");

        JsonNode lsp = LspHighlight(line, character);
        JsonNode wasm = JsonNode.Parse(WasmHighlights(line, character))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract: the declaration + the two usages, all DocumentHighlightKind.Text (1).
        wasm.AsArray().Count.ShouldBeGreaterThanOrEqualTo(3);
        Canonical(wasm).ShouldContain("\"kind\":1");
    }

    // ---- position helper (mirrors CallHierarchyWireParityTests) ------------

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

    // ---- LSP driving -------------------------------------------------------

    private static JsonNode LspHighlight(int line, int character) =>
        WireParityHarness.LspResult(
            Uri, Fixture, "textDocument/documentHighlight", new { position = new { line, character } })!;
}
