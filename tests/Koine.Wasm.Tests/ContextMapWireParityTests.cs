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

    /// <summary>
    /// One relation of every <see cref="Koine.Compiler.Ast.ContextRelationKind"/>, so the additive
    /// <c>upstreamRole</c>/<c>downstreamRole</c> projection (#483) is exercised for all seven kinds on
    /// both wires. A context map allows only ONE relation per unordered pair, hence the eight contexts.
    /// </summary>
    private const string RolesFixture = """
        context Alpha   { value A { v: String } }
        context Bravo   { value B { v: String } }
        context Charlie { value C { v: String } }
        context Delta   { value D { v: String } }
        context Echo    { value E { v: String } }
        context Foxtrot { value F { v: String } }
        context Golf    { value G { v: String } }
        context Hotel   { value H { v: String } }

        contextmap {
          Alpha   <-> Bravo   : partnership
          Charlie <-> Delta   : shared-kernel
          Echo    ->  Foxtrot : customer-supplier
          Golf    ->  Hotel   : conformist
          Alpha   ->  Charlie : anti-corruption-layer
            acl { Alpha.A -> Charlie.C }
          Bravo   ->  Delta   : open-host
          Echo    ->  Golf    : published-language
        }
        """;

    private const string Uri = "file:///ordering.koi";

    /// <summary>
    /// The strategic-DDD role each relation kind gives its two ends (#483). <c>null</c> for the two
    /// symmetric patterns — partnership and shared kernel put both contexts on an equal footing, so
    /// neither end plays an upstream/downstream role.
    /// </summary>
    public static TheoryData<string, string?, string?> ExpectedRoles => new()
    {
        { "Partnership", null, null },
        { "SharedKernel", null, null },
        { "CustomerSupplier", "Supplier", "Customer" },
        { "Conformist", "Upstream", "Conformist" },
        { "AntiCorruptionLayer", "Upstream", "Anti-Corruption Layer" },
        { "OpenHost", "Open Host Service", "Downstream" },
        { "PublishedLanguage", "Published Language", "Downstream" },
    };

    [Theory]
    [MemberData(nameof(ExpectedRoles))]
    public void Both_backends_type_each_relation_end_with_its_strategic_role(
        string kind, string? upstreamRole, string? downstreamRole)
    {
        foreach (var result in new[] { LspContextMap(RolesFixture), WasmContextMap(RolesFixture) })
        {
            var relation = result["relations"]!.AsArray()
                .Single(r => (string?)r!["kind"] == kind)!
                .AsObject();

            // The keys are always present (even when the role is null) so the Studio badge renderer
            // can distinguish "symmetric relation" from "an older backend that doesn't emit roles".
            relation.ContainsKey("upstreamRole").ShouldBeTrue();
            relation.ContainsKey("downstreamRole").ShouldBeTrue();
            ((string?)relation["upstreamRole"]).ShouldBe(upstreamRole);
            ((string?)relation["downstreamRole"]).ShouldBe(downstreamRole);
        }
    }

    [Fact]
    public void Both_backends_serialize_the_relation_roles_identically()
    {
        // The whole `relations` array — roles included — must serialize field-for-field identically
        // over the two backends; a drift between them is a bug.
        Canonical(LspContextMap(RolesFixture)["relations"])
            .ShouldBe(Canonical(WasmContextMap(RolesFixture)["relations"]));
    }

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
    private static JsonObject LspContextMap(string? source = null) =>
        LspResult(Uri, source ?? Fixture, "koine/contextMap", new { })!.AsObject();

    /// <summary>
    /// Drives the WASM JSExport <c>ContextMap</c> surface (the in-browser backend) and returns its result.
    /// <c>ContextMap</c> is marked <c>[SupportedOSPlatform("browser")]</c> for the JS-interop boundary, but
    /// its body is pure managed JSON in/out (no JS calls), so calling it on the test host is safe — hence
    /// the CA1416 suppression.
    /// </summary>
#pragma warning disable CA1416 // ContextMap has no JS-interop in its body; safe to call off-browser in a parity test.
    private static JsonObject WasmContextMap(string? source = null)
    {
        var filesJson = JsonSerializer.Serialize(new[] { new { uri = Uri, text = source ?? Fixture } });
        var json = CompilerInterop.ContextMap(filesJson);
        return JsonNode.Parse(json)!.AsObject();
    }
#pragma warning restore CA1416
}
