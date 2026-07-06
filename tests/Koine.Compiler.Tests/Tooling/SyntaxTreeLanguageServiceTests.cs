using System.Text;
using System.Text.Json;
using Koine.Cli;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Task 2 of the Studio syntax-tree panel (issue #890): the testable core that projects a warm
/// <see cref="KoineCompilation"/>'s ACTIVE buffer into a <see cref="SyntaxTreeNode"/> tree
/// (<see cref="KoineLanguageService.SyntaxTree(KoineCompilation, string)"/>), plus the desktop
/// <c>koine/syntaxTree</c> LSP handler that serializes the same camelCase wire shape the browser
/// <c>[JSExport] SyntaxTree</c> emits. Kept in <c>Koine.Compiler.Tests</c> so it runs on desktop
/// .NET with no wasm build.
/// </summary>
public class SyntaxTreeLanguageServiceTests
{
    private static readonly KoineLanguageService Svc = new();

    private const string OrderingUri = "file:///ordering.koi";
    private const string CatalogUri = "file:///catalog.koi";

    private const string Ordering =
        "context Ordering {\n" +
        "  value Money { amount: Decimal }\n" +
        "  enum OrderStatus { Draft, Placed }\n" +
        "}\n";

    private const string Catalog =
        "context Catalog {\n" +
        "  value Sku { code: String }\n" +
        "}\n";

    private static KoineCompilation Workspace() =>
        KoineCompilation.Create(new[]
        {
            new SourceFile(OrderingUri, Ordering),
            new SourceFile(CatalogUri, Catalog),
        });

    [Fact]
    public void SyntaxTree_projects_the_active_buffer_root_and_its_children()
    {
        SyntaxTreeNode? root = Svc.SyntaxTree(Workspace(), OrderingUri);

        root.ShouldNotBeNull();
        root!.Kind.ShouldBe("KoineModel");
        root.IsError.ShouldBeFalse();

        // Active-buffer ONLY: the tree is the Ordering file, not the merged two-file workspace.
        SyntaxTreeNode context = root.Children.ShouldHaveSingleItem();
        context.Kind.ShouldBe("ContextNode");
        context.Name.ShouldBe("Ordering");

        // Its children are the two declarations in source order.
        context.Children.Select(c => c.Name).ShouldBe(new[] { "Money", "OrderStatus" });
        context.Children[0].Kind.ShouldBe("ValueObjectDecl");
    }

    [Fact]
    public void SyntaxTree_selects_the_other_active_buffer_over_the_same_workspace()
    {
        // The SAME warm compilation, a DIFFERENT active uri, projects that file's tree only.
        SyntaxTreeNode? root = Svc.SyntaxTree(Workspace(), CatalogUri);

        SyntaxTreeNode context = root.ShouldNotBeNull().Children.ShouldHaveSingleItem();
        context.Name.ShouldBe("Catalog");
        context.Children.ShouldHaveSingleItem().Name.ShouldBe("Sku");
    }

    [Fact]
    public void SyntaxTree_returns_null_for_an_unknown_uri()
    {
        // An unknown active uri is absent, not an exception (empty/absent result contract).
        Svc.SyntaxTree(Workspace(), "file:///nope.koi").ShouldBeNull();
    }

    // ---- desktop LSP handler (koine/syntaxTree) — same camelCase wire shape as the wasm export ----

    [Fact]
    public void Lsp_koine_syntaxTree_returns_the_active_buffer_tree_in_camelCase()
    {
        var output = RunSession(
            Initialize(),
            DidOpen(OrderingUri, Ordering),
            SyntaxTreeRequest(OrderingUri));

        TryResultForId(output, 88, out var result).ShouldBeTrue();

        // Node keys: kind/name/span/isMissing/isError/leaf/children.
        result.GetProperty("kind").GetString().ShouldBe("KoineModel");
        result.GetProperty("isMissing").GetBoolean().ShouldBeFalse();
        result.GetProperty("isError").GetBoolean().ShouldBeFalse();

        var context = result.GetProperty("children").EnumerateArray().Single();
        context.GetProperty("kind").GetString().ShouldBe("ContextNode");
        context.GetProperty("name").GetString().ShouldBe("Ordering");

        // Span keys: line/column/endLine/endColumn/offset/length/file.
        var span = context.GetProperty("span");
        foreach (var key in new[] { "line", "column", "endLine", "endColumn", "offset", "length", "file" })
        {
            span.TryGetProperty(key, out _).ShouldBeTrue($"span is missing '{key}'");
        }
        span.GetProperty("line").GetInt32().ShouldBe(1); // the `context Ordering` line (1-based)
    }

    [Fact]
    public void Lsp_koine_syntaxTree_root_span_is_a_non_null_all_zero_object()
    {
        // The root (KoineModel) node carries the all-zero SourceSpan.None sentinel. It MUST serialize
        // as a NON-NULL object exposing all seven span keys — with line == 0 and file == JSON null —
        // NOT collapse to JSON null the way an absent diagram span does. Studio's panel relies on this
        // (`span.line > 0` root guard in SyntaxTreePanel.tsx / inspectorController.tsx). Pins the wire
        // contract across the SyntaxSpanJson → shared span-fields builder consolidation (#1099).
        var output = RunSession(
            Initialize(),
            DidOpen(OrderingUri, Ordering),
            SyntaxTreeRequest(OrderingUri));

        TryResultForId(output, 88, out var result).ShouldBeTrue();

        var span = result.GetProperty("span");
        span.ValueKind.ShouldBe(JsonValueKind.Object); // a non-null object, never JSON null
        foreach (var key in new[] { "line", "column", "endLine", "endColumn", "offset", "length", "file" })
        {
            span.TryGetProperty(key, out _).ShouldBeTrue($"root span is missing '{key}'");
        }
        span.GetProperty("line").GetInt32().ShouldBe(0);                 // all-zero root sentinel
        span.GetProperty("file").ValueKind.ShouldBe(JsonValueKind.Null); // file: null on the root
    }

    [Fact]
    public void Lsp_koine_syntaxTree_returns_null_for_an_unopened_uri()
    {
        var output = RunSession(Initialize(), SyntaxTreeRequest("file:///never-opened.koi"));

        TryResultForId(output, 88, out var result).ShouldBeTrue();
        result.ValueKind.ShouldBe(JsonValueKind.Null);
    }

    [Fact]
    public void Initialize_advertises_koine_syntaxTree_under_experimental()
    {
        RunSession(Initialize()).ShouldContain("\"koineSyntaxTree\":true");
    }

    // ---- minimal LSP session harness (self-contained; mirrors LspServerTests) ---------------------

    private static string RunSession(params byte[][] messages)
    {
        var input = new MemoryStream(messages.SelectMany(m => m).ToArray());
        var output = new MemoryStream();
        new LspServer(input, output).Loop();
        return Encoding.UTF8.GetString(output.ToArray());
    }

    private static byte[] Frame(string json)
    {
        var body = Encoding.UTF8.GetBytes(json);
        var header = Encoding.ASCII.GetBytes($"Content-Length: {body.Length}\r\n\r\n");
        return header.Concat(body).ToArray();
    }

    private static byte[] Initialize() =>
        Frame("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}");

    private static byte[] DidOpen(string uri, string text) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "textDocument/didOpen",
            @params = new { textDocument = new { uri, languageId = "koine", version = 1, text } },
        }));

    private static byte[] SyntaxTreeRequest(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 88,
            method = "koine/syntaxTree",
            @params = new { textDocument = new { uri } },
        }));

    private static bool TryResultForId(string output, int id, out JsonElement result)
    {
        foreach (var body in TestSupport.JsonRpcFrames(output))
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            if (root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number && idEl.GetInt32() == id
                && root.TryGetProperty("result", out var r))
            {
                result = r.Clone();
                return true;
            }
        }

        result = default;
        return false;
    }
}
