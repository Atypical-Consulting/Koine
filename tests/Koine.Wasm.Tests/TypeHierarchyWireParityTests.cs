using System.Text.Json;
using System.Text.Json.Nodes;
using static Koine.Wasm.Tests.WireParityHarness;

namespace Koine.Wasm.Tests;

/// <summary>
/// Dual-backend wire parity for the type-hierarchy seam (#331, Task 3): <c>textDocument/prepareTypeHierarchy</c>
/// + <c>typeHierarchy/supertypes</c> + <c>typeHierarchy/subtypes</c>. A minimal super/sub model over the
/// semantic model — supertypes = the declared relationships a type points <i>at</i> (an entity's member
/// value/identity types, a read model's <c>from</c> source); subtypes = the inverse edges — must serialize
/// <b>field-for-field identically</b> over the stdio LSP server (<see cref="LspServer"/>) and the WASM
/// JSExport surface (<see cref="Koine.Wasm.CompilerInterop"/>). Mirrors the call-hierarchy parity contract.
/// </summary>
public class TypeHierarchyWireParityTests
{
    // The spec's Order/OrderId/Money/OrderRow graph: Order (entity) declares Money + Quantity (values);
    // OrderRow (read model) projects `from Order`. So supertypes(Order) ⊇ {Money, Quantity},
    // supertypes(OrderRow) = {Order}, subtypes(Order) = {OrderRow}, subtypes(Money) = {Order}.
    private const string Uri = "file:///t.koi";
    private const string Fixture =
        "context Ordering {\n" +
        "  value Money { amount: Decimal currency: String }\n" +
        "  value Quantity { count: Int }\n" +
        "\n" +
        "  entity Order identified by OrderId {\n" +
        "    total: Money\n" +
        "    quantity: Quantity\n" +
        "  }\n" +
        "\n" +
        "  readmodel OrderRow from Order {\n" +
        "    total\n" +
        "  }\n" +
        "}\n";

    private static string FilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = Uri, text = Fixture } });

    // The CompilerInterop JSExports are [SupportedOSPlatform("browser")] for the JS-interop boundary,
    // but their bodies have no JS interop — safe to call off-browser in a parity test (CA1416 suppressed).
#pragma warning disable CA1416
    private static string WasmPrepare(int line, int character) =>
        CompilerInterop.PrepareTypeHierarchy(FilesJson(), Uri, line, character);

    private static string WasmSupertypes(string itemJson) =>
        CompilerInterop.Supertypes(FilesJson(), itemJson);

    private static string WasmSubtypes(string itemJson) =>
        CompilerInterop.Subtypes(FilesJson(), itemJson);
#pragma warning restore CA1416

    [Fact]
    public void PrepareTypeHierarchy_is_identical_across_backends()
    {
        var (line, character) = PositionOf("Order", "entity Order");

        JsonNode lsp = LspPrepare(line, character);
        JsonNode wasm = JsonNode.Parse(WasmPrepare(line, character))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // And it carries the contract: the entity item + the reconstruction blob.
        Canonical(wasm).ShouldContain("\"name\":\"Order\"");
        Canonical(wasm).ShouldContain("\"thKind\":\"Entity\"");
    }

    [Fact]
    public void Supertypes_are_identical_across_backends()
    {
        var item = PreparedItemJson("Order", "entity Order");

        JsonNode lsp = LspItemResult("typeHierarchy/supertypes", item);
        JsonNode wasm = JsonNode.Parse(WasmSupertypes(item))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // Order points at the declared value types it composes.
        Canonical(wasm).ShouldContain("\"name\":\"Money\"");
        Canonical(wasm).ShouldContain("\"name\":\"Quantity\"");
    }

    [Fact]
    public void Subtypes_are_identical_across_backends()
    {
        // Subtypes of Order = the read model projecting from it (the inverse `from` edge).
        var item = PreparedItemJson("Order", "entity Order");

        JsonNode lsp = LspItemResult("typeHierarchy/subtypes", item);
        JsonNode wasm = JsonNode.Parse(WasmSubtypes(item))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("\"name\":\"OrderRow\"");
    }

    [Fact]
    public void Supertypes_of_a_read_model_follow_the_from_edge()
    {
        var item = PreparedItemJson("OrderRow", "readmodel OrderRow");

        JsonNode lsp = LspItemResult("typeHierarchy/supertypes", item);
        JsonNode wasm = JsonNode.Parse(WasmSupertypes(item))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("\"name\":\"Order\"");
    }

    // ---- helpers -----------------------------------------------------------

    // The canonical item the supertypes/subtypes walks echo back: prepare on a name, take the first item.
    private static string PreparedItemJson(string needle, string after)
    {
        var (line, character) = PositionOf(needle, after);
        return JsonNode.Parse(WasmPrepare(line, character))!.AsArray()[0]!.ToJsonString();
    }

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

    private static JsonNode LspPrepare(int line, int character) =>
        WireParityHarness.LspResult(
            Uri, Fixture, "textDocument/prepareTypeHierarchy", new { position = new { line, character } })!;

    private static JsonNode LspItemResult(string method, string itemJson) =>
        WireParityHarness.LspResult(Uri, Fixture, method, new { item = JsonNode.Parse(itemJson) })!;

    // ---- #389: two-context duplicate-name disambiguation -------------------

    // `Money` is declared in BOTH Billing and Ordering (legal — each context is its own namespace).
    // Billing.Invoice composes Billing.Money; Ordering.Order composes Ordering.Money. Identity is now
    // (context, name): the disambiguating `context` rides the opaque `data` blob, round-tripped
    // field-for-field identically across the stdio LSP and the WASM backend. Without it, both backends
    // would fall back to first-wins-by-name (Billing) and wrongly report Invoice as Ordering.Money's subtype.
    private const string DupUri = "file:///dup.koi";
    private const string DupFixture =
        "context Billing {\n" +
        "  value Money { amount: Decimal currency: String }\n" +
        "  entity Invoice identified by InvoiceId {\n" +
        "    amount: Money\n" +
        "  }\n" +
        "}\n" +
        "\n" +
        "context Ordering {\n" +
        "  value Money { amount: Decimal currency: String }\n" +
        "  entity Order identified by OrderId {\n" +
        "    total: Money\n" +
        "  }\n" +
        "}\n";

    private static string DupFilesJson() =>
        JsonSerializer.Serialize(new[] { new { uri = DupUri, text = DupFixture } });

#pragma warning disable CA1416
    private static string DupWasmPrepare(int line, int character) =>
        CompilerInterop.PrepareTypeHierarchy(DupFilesJson(), DupUri, line, character);

    private static string DupWasmSupertypes(string itemJson) =>
        CompilerInterop.Supertypes(DupFilesJson(), itemJson);

    private static string DupWasmSubtypes(string itemJson) =>
        CompilerInterop.Subtypes(DupFilesJson(), itemJson);
#pragma warning restore CA1416

    private static (int line, int character) DupPositionOf(string needle, string after)
    {
        var anchor = DupFixture.IndexOf(after, StringComparison.Ordinal);
        var index = DupFixture.IndexOf(needle, anchor, StringComparison.Ordinal) + 1;
        var line = 0;
        var lineStart = 0;
        for (var i = 0; i < index; i++)
        {
            if (DupFixture[i] == '\n')
            {
                line++;
                lineStart = i + 1;
            }
        }

        return (line, index - lineStart);
    }

    private static string DupPreparedItemJson(string needle, string after)
    {
        var (line, character) = DupPositionOf(needle, after);
        return JsonNode.Parse(DupWasmPrepare(line, character))!.AsArray()[0]!.ToJsonString();
    }

    private static JsonNode DupLspPrepare(int line, int character) =>
        WireParityHarness.LspResult(
            DupUri, DupFixture, "textDocument/prepareTypeHierarchy", new { position = new { line, character } })!;

    private static JsonNode DupLspItemResult(string method, string itemJson) =>
        WireParityHarness.LspResult(DupUri, DupFixture, method, new { item = JsonNode.Parse(itemJson) })!;

    [Fact]
    public void Prepare_carries_the_bounded_context_identically_across_backends()
    {
        var (line, character) = DupPositionOf("Money", "context Ordering");

        JsonNode lsp = DupLspPrepare(line, character);
        JsonNode wasm = JsonNode.Parse(DupWasmPrepare(line, character))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        // The cursor sits in Ordering, so the item is Ordering.Money — carried in the data blob.
        Canonical(wasm).ShouldContain("\"name\":\"Money\"");
        Canonical(wasm).ShouldContain("\"context\":\"Ordering\"");
    }

    [Fact]
    public void Subtypes_of_a_duplicated_value_are_context_scoped_and_identical()
    {
        // Ordering.Money's only subtype is Ordering.Order — NOT Billing.Invoice. Resolving this right
        // needs the carried context: name-only first-wins would resolve Money to Billing and return Invoice.
        var item = DupPreparedItemJson("Money", "context Ordering");

        JsonNode lsp = DupLspItemResult("typeHierarchy/subtypes", item);
        JsonNode wasm = JsonNode.Parse(DupWasmSubtypes(item))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("\"name\":\"Order\"");
        Canonical(wasm).ShouldContain("\"context\":\"Ordering\"");
        Canonical(wasm).ShouldNotContain("\"name\":\"Invoice\"");
    }

    [Fact]
    public void Supertypes_of_an_entity_resolve_its_own_contexts_value_identically()
    {
        // Billing.Invoice points at Billing.Money (and its InvoiceId) — never Ordering.Money.
        var item = DupPreparedItemJson("Invoice", "entity Invoice");

        JsonNode lsp = DupLspItemResult("typeHierarchy/supertypes", item);
        JsonNode wasm = JsonNode.Parse(DupWasmSupertypes(item))!;

        Canonical(lsp).ShouldBe(Canonical(wasm));
        Canonical(wasm).ShouldContain("\"name\":\"Money\"");
        Canonical(wasm).ShouldContain("\"context\":\"Billing\"");
    }
}
