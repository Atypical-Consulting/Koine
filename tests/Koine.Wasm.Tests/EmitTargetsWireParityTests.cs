using System.Text.Json;
using System.Text.Json.Nodes;
using static Koine.Wasm.Tests.WireParityHarness;

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
    public void Wasm_list_carries_the_code_targets_with_metadata_and_excludes_glossary_and_docs()
    {
        var targets = JsonNode.Parse(WasmListEmitTargets())!["targets"]!.AsArray();

        targets.Select(t => t!["id"]!.GetValue<string>())
            .ShouldBe(["csharp", "typescript", "python", "php", "rust", "java", "asyncapi", "openapi"]);

        var csharp = targets.First(t => t!["id"]!.GetValue<string>() == "csharp")!;
        csharp["displayName"]!.GetValue<string>().ShouldBe("C#");
        csharp["fileExtension"]!.GetValue<string>().ShouldBe(".cs");

        targets.Select(t => t!["id"]!.GetValue<string>()).ShouldNotContain("glossary");
        targets.Select(t => t!["id"]!.GetValue<string>()).ShouldNotContain("docs");
    }

    // ---- LSP driving (domain-specific; the plumbing lives in WireParityHarness) ----

    // emitTargets is a global capability query: no open document, empty params.
    private static JsonNode LspResult(string method)
    {
        var request = Frame(JsonSerializer.Serialize(new { jsonrpc = "2.0", id = 99, method, @params = new { } }));
        var output = RunSession(Initialize(), request);
        return ResultForId(output, 99)!;
    }
}
