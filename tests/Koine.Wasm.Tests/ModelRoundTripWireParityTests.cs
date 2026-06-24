using System.Text.Json;
using System.Text.Json.Nodes;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the model→<c>.koi</c> round-trip seam (#91). The same
/// <see cref="Koine.Compiler.Services.ModelRoundTripService"/> must serialize <b>field-for-field
/// identically</b> over the stdio LSP server (<see cref="LspServer"/>, hand-written camelCase dict
/// keys) and the in-browser WASM JSExport surface (<see cref="Koine.Wasm.CompilerInterop"/>,
/// source-gen CamelCase DTOs). Parity is non-negotiable: an unhandled or divergent WASM request
/// silently breaks the browser. This suite pins the contract the Studio editors are written against.
/// </summary>
public class ModelRoundTripWireParityTests
{
    private const string Fixture = """
        context Ordering {
          value Money { amount: Decimal }
          enum OrderStatus { Draft, Placed, Shipped }

          aggregate Order root Order {
            entity Order identified by OrderId {
              status: OrderStatus = Draft
              states status {
                Draft -> Placed
                Placed -> Shipped
              }
            }
          }
        }
        """;

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = "file:///t.koi", text = Fixture } });

    // The CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary,
    // but their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmModel(string? qn) => CompilerInterop.Model(FilesJson(), qn);
    private static string WasmModelMembers(string qn) => CompilerInterop.ModelMembers(FilesJson(), qn);
    private static string WasmEmitKoine(string editJson) => CompilerInterop.EmitKoine(FilesJson(), editJson);
    private static string WasmApplyModelEdit(string editJson) => CompilerInterop.ApplyModelEdit(FilesJson(), editJson);
#pragma warning restore CA1416

    [Fact]
    public void Model_tree_is_identical_across_backends()
    {
        JsonNode lsp = LspModel(null);
        JsonNode wasm = JsonNode.Parse(WasmModel(null))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract the editors rely on.
        lsp["kind"]!.GetValue<string>().ShouldBe("model");
        Canonical(lsp).ShouldContain("Ordering.Money");
        Canonical(lsp).ShouldContain("Ordering.Order.Order.states.status");
    }

    [Fact]
    public void Scoped_model_node_is_identical_across_backends()
    {
        JsonNode lsp = LspModel("Ordering.Money");
        JsonNode wasm = JsonNode.Parse(WasmModel("Ordering.Money"))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["qualifiedName"]!.GetValue<string>().ShouldBe("Ordering.Money");
    }

    [Fact]
    public void Model_members_are_identical_across_backends()
    {
        JsonNode lsp = LspResult("koine/modelMembers", new { qualifiedName = "Ordering.OrderStatus" });
        JsonNode wasm = JsonNode.Parse(WasmModelMembers("Ordering.OrderStatus"))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("Draft");
    }

    [Fact]
    public void EmitKoine_is_identical_across_backends_for_a_legal_edit()
    {
        var edit = new { kind = "addField", target = "Ordering.Money", name = "tax", type = "Decimal" };
        JsonNode lsp = LspResult("koine/emitKoine", new { edit });
        JsonNode wasm = JsonNode.Parse(WasmEmitKoine(JsonSerializer.Serialize(edit)))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("tax: Decimal");
    }

    [Fact]
    public void EmitKoine_is_identical_across_backends_for_an_illegal_edit()
    {
        var edit = new { kind = "changeFieldType", target = "Ordering.Money.amount", type = "Nope" };
        JsonNode lsp = LspResult("koine/emitKoine", new { edit });
        JsonNode wasm = JsonNode.Parse(WasmEmitKoine(JsonSerializer.Serialize(edit)))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["koine"].ShouldBeNull();
        Canonical(wasm).ShouldContain("KOI0101");
    }

    [Fact]
    public void ApplyModelEdit_is_identical_across_backends()
    {
        var edit = new { kind = "addField", target = "Ordering.Money", name = "tax", type = "Decimal" };
        JsonNode lsp = LspResult("koine/applyModelEdit", new { edit });
        JsonNode wasm = JsonNode.Parse(WasmApplyModelEdit(JsonSerializer.Serialize(edit)))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["uri"]!.GetValue<string>().ShouldBe("file:///t.koi");
        wasm["edits"]!.AsArray().Count.ShouldBe(1);
    }

    // ---- LSP driving (domain-specific; the plumbing lives in WireParityHarness) ----

    private static JsonNode LspModel(string? qualifiedName) =>
        LspResult("koine/model", qualifiedName is null ? new { } : new { qualifiedName });

    // Merges `textDocument = { uri }` into the request params and returns the `result` object.
    private static JsonNode LspResult(string method, object extraParams) =>
        WireParityHarness.LspResult("file:///t.koi", Fixture, method, extraParams)!;
}
