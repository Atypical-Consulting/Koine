using System.Text.Json;
using System.Text.Json.Nodes;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the strategic context map (issue #290). Each declared bounded context
/// on the <c>koine/contextMap</c> result must carry its declaration <c>sourceSpan</c> (the 1-based
/// <see cref="Koine.Compiler.Ast.SourceSpan"/> over the <c>context</c> name token) so the Studio
/// context-map graph can jump to the <c>.koi</c> declaration on click. The same projection must
/// serialize <b>field-for-field identically</b> over the stdio LSP server (<see cref="LspServer"/>,
/// hand-written camelCase dict keys) and the in-browser WASM JSExport surface
/// (<see cref="Koine.Wasm.CompilerInterop"/>, source-gen CamelCase DTOs) — a drift between them is a bug.
/// </summary>
public class ContextMapWireParityTests
{
    /// <summary>Two declared contexts plus a relation, so the projection covers declared contexts and edges.</summary>
    private const string Fixture = """
        context Ordering {
          value Line { product: ProductId }
        }

        context Shipping {
          value Parcel { ref: String }
        }

        contextmap {
          Ordering -> Shipping : open-host
        }
        """;

    private const string Uri = "file:///ordering.koi";

    [Fact]
    public void Both_backends_carry_a_declaration_source_span_for_each_context()
    {
        foreach (var result in new[] { LspContextMap(), WasmContextMap() })
        {
            // `contexts` stays the bare name list (unchanged); the additive `contextSpans` map carries
            // each declared context's declaration span, keyed by name.
            result["contexts"]!.AsArray().Select(c => (string?)c).ShouldBe(["Ordering", "Shipping"]);

            var spans = result["contextSpans"]!.AsObject();
            spans.ContainsKey("Ordering").ShouldBeTrue();
            spans.ContainsKey("Shipping").ShouldBeTrue();

            // The `Ordering` context's span points at its name token: 1-based line 1, column 9
            // (after "context "), and carries the declaring file uri for a cross-file jump.
            var span = spans["Ordering"];
            span.ShouldNotBeNull();
            ((int?)span!["line"]).ShouldBe(1);
            ((int?)span["column"]).ShouldBe(9);
            ((string?)span["file"]).ShouldBe(Uri);
        }
    }

    [Fact]
    public void Both_backends_serialize_the_context_spans_identically()
    {
        // The `contextSpans` substructure must serialize field-for-field identically over the two
        // backends — the guard that the desktop LSP and the in-browser WASM host never drift.
        Canonical(LspContextMap()["contextSpans"]).ShouldBe(Canonical(WasmContextMap()["contextSpans"]));
    }

    [Fact]
    public void Context_span_uses_the_raw_camelCase_keys_not_a_zero_based_range()
    {
        // The span carries the raw 1-based fields (line/column/offset/length), matching the diagram-node
        // wire — NOT a 0-based LSP { start, end } range. Guard both wires.
        foreach (var result in new[] { LspContextMap(), WasmContextMap() })
        {
            var span = result["contextSpans"]!["Ordering"]!.AsObject();
            span.ContainsKey("line").ShouldBeTrue();
            span.ContainsKey("column").ShouldBeTrue();
            span.ContainsKey("offset").ShouldBeTrue();
            span.ContainsKey("length").ShouldBeTrue();
            span.ContainsKey("start").ShouldBeFalse();
            span.ContainsKey("end").ShouldBeFalse();
        }
    }

    // ---- backend drivers ------------------------------------------------------

    /// <summary>Drives the real stdio LSP wire (<c>koine/contextMap</c>) and returns its <c>result</c>.</summary>
    private static JsonObject LspContextMap() =>
        LspResult(Uri, Fixture, "koine/contextMap", new { })!.AsObject();

    /// <summary>
    /// Drives the WASM JSExport <c>ContextMap</c> surface (the in-browser backend) and returns its result.
    /// <c>ContextMap</c> is marked <c>[SupportedOSPlatform("browser")]</c> for the JS-interop boundary, but
    /// its body is pure managed JSON in/out (no JS calls), so calling it on the test host is safe — hence
    /// the CA1416 suppression.
    /// </summary>
#pragma warning disable CA1416 // ContextMap has no JS-interop in its body; safe to call off-browser in a parity test.
    private static JsonObject WasmContextMap()
    {
        var filesJson = JsonSerializer.Serialize(new[] { new { uri = Uri, text = Fixture } });
        var json = CompilerInterop.ContextMap(filesJson);
        return JsonNode.Parse(json)!.AsObject();
    }
#pragma warning restore CA1416

}
