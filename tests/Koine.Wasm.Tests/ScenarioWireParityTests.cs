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

    /// <summary>A model the parser rejects outright — the WASM backend's "the model has errors" branch,
    /// which answers with the not-ok ERROR tree instead of running anything.</summary>
    private const string BrokenFixture = """
        context Ordering {
          value {
          }
        }
        """;

    /// <summary>The same command recording BOTH kinds of event (R19, #1796): an intra-aggregate
    /// <c>emit</c> and a published-language <c>publish</c>, so the discriminator that tells them apart
    /// on the wire is exercised across both backends.</summary>
    private const string PublishingFixture = """
        context Ordering {
          publishes OrderPlaced
          integration event OrderPlaced { orderId: OrderId  lineCount: Int }

          aggregate Sales root Order {
            event OrderDrafted { orderId: OrderId }
            entity Order identified by OrderId {
              lineCount: Int = 0
              command place {
                lineCount -> 1
                emit OrderDrafted(orderId: id)
                publish OrderPlaced(orderId: id, lineCount: lineCount)
              }
            }
          }
        }
        """;

    private static string FilesJson(string text = Fixture) =>
        JsonSerializer.Serialize(new[] { new { uri = "file:///t.koi", text } });

    // CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary, but
    // their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmRunScenario(
        string target, string operation, object given, object args, bool execute = false, string text = Fixture) =>
        CompilerInterop.RunScenario(
            FilesJson(text), target, operation, JsonSerializer.Serialize(given), JsonSerializer.Serialize(args), execute);
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

    /// <summary>
    /// The same promise on the FAILURE paths. A browser user who ticks "execute generated code" and hits
    /// a broken model gets the not-ok ERROR tree — and it must still say that execution was unavailable
    /// here, or the one hint the success path gives silently disappears exactly when the run went wrong.
    /// </summary>
    [Fact]
    public void The_wasm_error_tree_still_says_execution_was_unavailable()
    {
        object given = new { };
        object args = new { };

        JsonNode plain = JsonNode.Parse(WasmRunScenario("Order", "place", given, args, text: BrokenFixture))!;
        JsonNode asked = JsonNode.Parse(
            WasmRunScenario("Order", "place", given, args, execute: true, text: BrokenFixture))!;

        plain["ok"]!.GetValue<bool>().ShouldBeFalse();
        asked["ok"]!.GetValue<bool>().ShouldBeFalse();
        asked["mode"]!.GetValue<string>().ShouldBe("interpreted");

        // Both explain the failure; only the one that ASKED to execute is also told why it could not.
        Canonical(plain["notes"]).ShouldContain("The model has errors");
        Canonical(plain["notes"]).ShouldNotContain("not available on this host");
        Canonical(asked["notes"]).ShouldContain("The model has errors");
        Canonical(asked["notes"]).ShouldContain("not available on this host");

        // Identical otherwise — the extra note is the ONLY difference.
        plain.AsObject().Remove("notes");
        asked.AsObject().Remove("notes");
        Canonical(asked).ShouldBe(Canonical(plain));
    }

    /// <summary>
    /// R19 (#1796): a <c>publish</c> must be distinguishable from an <c>emit</c> on the wire, identically
    /// on both backends. It stays <c>kind: "emit"</c> — the shape every existing client switches on — and
    /// carries a <c>published: true</c> flag written ONLY when it is one, so a domain event's step object
    /// is byte-identical to what it was before the clause existed.
    /// </summary>
    [Fact]
    public void A_published_integration_event_is_flagged_identically_across_backends()
    {
        object given = new { lineCount = 0 };
        object args = new { };

        JsonNode lsp = WireParityHarness.LspResult(
            "file:///t.koi", PublishingFixture, "koine/runScenario",
            new { target = "Order", operation = "place", given, args })!;
        JsonNode wasm = JsonNode.Parse(WasmRunScenario("Order", "place", given, args, text: PublishingFixture))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));

        JsonArray steps = wasm["steps"]!.AsArray();
        JsonNode[] recorded = steps.Where(s => s!["kind"]!.GetValue<string>() == "emit").Select(s => s!).ToArray();
        recorded.Length.ShouldBe(2);

        // The domain event keeps exactly its pre-#1796 shape: no `published` key at all, not `false`.
        recorded[0]["event"]!.GetValue<string>().ShouldBe("OrderDrafted");
        recorded[0]!.AsObject().ContainsKey("published").ShouldBeFalse();

        // The publication is the same `emit` kind, flagged.
        recorded[1]["event"]!.GetValue<string>().ShouldBe("OrderPlaced");
        recorded[1]["kind"]!.GetValue<string>().ShouldBe("emit");
        recorded[1]["published"]!.GetValue<bool>().ShouldBeTrue();
    }

    // ---- LSP driving (domain-specific; the plumbing lives in WireParityHarness) ----

    // Merges `textDocument = { uri }` into the request params and returns the `result` object.
    private static JsonNode LspResult(string method, object extraParams) =>
        WireParityHarness.LspResult("file:///t.koi", Fixture, method, extraParams)!;
}
