using System.Text.Json;
using System.Text.Json.Nodes;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the scenario runner (#149, <c>koine/runScenario</c>). The same
/// <see cref="Koine.Compiler.Services.ScenarioService"/> must produce <b>byte-for-byte identical</b>
/// JSON over the stdio LSP server (<see cref="LspServer"/>) and the in-browser WASM JSExport surface
/// (<see cref="Koine.Wasm.CompilerInterop"/>). Parity is non-negotiable: the Studio scenario panel is
/// written against one response shape and must behave the same whether it runs on the Tauri (CLI) or
/// browser (WASM) backend. This is the automated form of "verify against both backends".
/// </summary>
public class ScenarioWireParityTests
{
    private const string Fixture = """
        context Ordering {
          enum OrderStatus { Draft, Placed, Shipped }
          aggregate Sales root Order {
            event OrderPlaced { orderId: OrderId  lineCount: Int }
            value OrderLine { product: ProductId  quantity: Int }
            entity Order identified by OrderId {
              lines:  List<OrderLine>
              status: OrderStatus = Draft
              invariant status == Draft when lines.isEmpty
              states status { Draft -> Placed  Placed -> Shipped }
              command place {
                requires status == Draft   "only a draft order can be placed"
                requires !lines.isEmpty    "cannot place an empty order"
                status -> Placed
                emit OrderPlaced(orderId: id, lineCount: lines.count)
              }
            }
          }
        }
        """;

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = "file:///t.koi", text = Fixture } });

    // CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary, but
    // their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmRunScenario(string target, string operation, object given, object args, bool execute = false) =>
        CompilerInterop.RunScenario(
            FilesJson(), target, operation, JsonSerializer.Serialize(given), JsonSerializer.Serialize(args), execute);
#pragma warning restore CA1416

    [Fact]
    public void Placing_a_draft_order_is_identical_across_backends()
    {
        var given = new { status = "Draft", lines = new[] { new { product = "P1", quantity = 2 } } };
        object args = new { };

        JsonNode lsp = LspResult("koine/runScenario", new { target = "Order", operation = "place", given, args });
        JsonNode wasm = JsonNode.Parse(WasmRunScenario("Order", "place", given, args))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract the panel relies on.
        wasm["ok"]!.GetValue<bool>().ShouldBeTrue();
        Canonical(wasm).ShouldContain("OrderPlaced");
        // Both backends label the engine that produced the answer (#236) — and neither interprets in secret.
        wasm["mode"]!.GetValue<string>().ShouldBe("interpreted");
    }

    [Fact]
    public void Rejecting_a_non_draft_order_is_identical_across_backends()
    {
        var given = new { status = "Placed", lines = new[] { new { product = "P1", quantity = 1 } } };
        object args = new { };

        JsonNode lsp = LspResult("koine/runScenario", new { target = "Order", operation = "place", given, args });
        JsonNode wasm = JsonNode.Parse(WasmRunScenario("Order", "place", given, args))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        wasm["ok"]!.GetValue<bool>().ShouldBeFalse();
        wasm["mode"]!.GetValue<string>().ShouldBe("interpreted");
    }

    /// <summary>
    /// Executed mode (#236) needs a process to sandbox into (ADR 0011), which the browser host does not
    /// have. Asking for it there must not silently return an interpreted answer dressed as an executed
    /// one: the browser backend answers the SAME shape, still labelled <c>interpreted</c>, with one extra
    /// note saying execution was unavailable. Degraded, and clearly labelled as such.
    /// </summary>
    [Fact]
    public void The_wasm_backend_answers_an_execute_request_as_interpreted_and_says_why()
    {
        var given = new { status = "Draft", lines = new[] { new { product = "P1", quantity = 2 } } };
        object args = new { };

        JsonNode plain = JsonNode.Parse(WasmRunScenario("Order", "place", given, args))!;
        JsonNode asked = JsonNode.Parse(WasmRunScenario("Order", "place", given, args, execute: true))!;

        asked["mode"]!.GetValue<string>().ShouldBe("interpreted");
        asked["ok"]!.GetValue<bool>().ShouldBeTrue();
        Canonical(asked["notes"]).ShouldContain("not available on this host");

        // Identical otherwise: only the notes differ, so the panel renders it exactly like any other run.
        plain.AsObject().Remove("notes");
        asked.AsObject().Remove("notes");
        Canonical(asked).ShouldBe(Canonical(plain));
    }

    // ---- LSP driving (domain-specific; the plumbing lives in WireParityHarness) ----

    // Merges `textDocument = { uri }` into the request params and returns the `result` object.
    private static JsonNode LspResult(string method, object extraParams) =>
        WireParityHarness.LspResult("file:///t.koi", Fixture, method, extraParams)!;
}
