using System.Text.Json.Nodes;
using Koine.Compiler.Services;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for full-document semantic tokens (issue #329,
/// <c>textDocument/semanticTokens/full</c> / <see cref="Koine.Wasm.CompilerInterop.SemanticTokens"/>).
/// The already-shipped stdio LSP server (<see cref="LspServer"/>) and the in-browser WASM JSExport
/// surface must emit a <b>byte-for-byte identical</b> <c>data</c> int stream, so Koine Studio
/// (browser/WASM backend) and the docs-site playground get the same semantically-accurate color the
/// desktop LSP already does. This is the automated form of "verify against both backends".
///
/// <para>Both backends reuse the same <see cref="SemanticTokenProvider"/> (<c>Tokenize</c> + the static
/// <c>Encode</c>), so the streams agree by construction — this test pins that they stay agreed. It also
/// asserts the legend the stdio <c>initialize</c> advertises equals the provider's
/// <see cref="SemanticTokenProvider.TokenTypeNames"/>/<see cref="SemanticTokenProvider.TokenModifierNames"/>
/// constants, so both sides decode the same <c>tokenType</c>/modifier ints.</para>
/// </summary>
public class SemanticTokensWireParityTests
{
    // CompilerInterop.SemanticTokens is [SupportedOSPlatform("browser")] for the JS-interop boundary, but
    // its body has no JS interop (pure tokenize + JSON) — safe to call off-browser in a parity test.
#pragma warning disable CA1416
    private static string WasmSemanticTokens(string source) => CompilerInterop.SemanticTokens(source);
#pragma warning restore CA1416

    private const string Uri = "file:///model.koi";

    // enum + value (member) + service operation parameter: exercises enum / enumMember / type / property /
    // parameter token types and the declaration modifier. Each fragment is independently proven to parse
    // and tokenize in SemanticTokenProviderTests, so the composite is a non-empty, multi-type stream.
    private const string Source =
        "context C {\n" +
        "  enum Status { Draft, Active }\n" +
        "  value Money { amount: Decimal }\n" +
        "  service Calc {\n" +
        "    operation total(base: Money): Money = base\n" +
        "  }\n" +
        "}\n";

    // An unnamed value does not parse: both backends must degrade to empty data (graceful fallback).
    private const string BrokenSource = "context C {\n  value {\n  }\n}\n";

    [Fact]
    public void Semantic_tokens_data_is_identical_across_backends()
    {
        var lsp = LspSemanticTokens(Source);
        var wasm = JsonNode.Parse(WasmSemanticTokens(Source))!["data"];

        // Guard against a vacuous pass on two empty arrays: a representative model must produce tokens.
        lsp!.AsArray().Count.ShouldBeGreaterThan(0);
        Canonical(lsp).ShouldBe(Canonical(wasm));
    }

    [Fact]
    public void Non_parsing_source_degrades_to_empty_data_on_both_backends()
    {
        var lsp = LspSemanticTokens(BrokenSource);
        var wasm = JsonNode.Parse(WasmSemanticTokens(BrokenSource))!["data"];

        lsp!.AsArray().Count.ShouldBe(0);
        Canonical(lsp).ShouldBe(Canonical(wasm));
    }

    [Fact]
    public void Initialize_legend_matches_the_provider_constants()
    {
        var legend = ResultForId(RunSession(Initialize()), 1)!["capabilities"]!["semanticTokensProvider"]!["legend"]!;

        legend["tokenTypes"]!.AsArray().Select(n => n!.GetValue<string>())
            .ShouldBe(SemanticTokenProvider.TokenTypeNames);
        legend["tokenModifiers"]!.AsArray().Select(n => n!.GetValue<string>())
            .ShouldBe(SemanticTokenProvider.TokenModifierNames);
    }

    // ---- LSP driving (the plumbing lives in WireParityHarness) ----

    // semanticTokens/full needs an open document; the request params are just { textDocument: { uri } }.
    private static JsonNode? LspSemanticTokens(string text) =>
        LspResult(Uri, text, "textDocument/semanticTokens/full", new { })?["data"];
}
