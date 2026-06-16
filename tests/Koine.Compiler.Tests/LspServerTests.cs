using System.Text;
using System.Text.Json;
using Koine.Cli;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

public class LspServerTests
{
    // ---- KoineCompiler.Diagnose ------------------------------------------

    [Fact]
    public void Diagnose_valid_fixture_is_clean()
    {
        Assert.Empty(new KoineCompiler().Diagnose(TestSupport.BillingFixture));
    }

    [Fact]
    public void Diagnose_reports_syntax_errors()
    {
        var diags = new KoineCompiler().Diagnose("context C {\n  value {\n  }\n}\n");
        Assert.NotEmpty(diags);
        Assert.Equal(2, diags[0].Line);
    }

    [Fact]
    public void Diagnose_reports_semantic_errors()
    {
        var diags = new KoineCompiler().Diagnose("context C {\n  value V { x: Nope }\n}\n");
        Assert.Contains(diags, d => d.Message.Contains("unknown type 'Nope'"));
    }

    // ---- LSP message loop -------------------------------------------------

    [Fact]
    public void Publishes_diagnostics_on_didOpen_with_invalid_model()
    {
        const string badDoc = "context C {\n  value V { x: Nope }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", badDoc));

        Assert.Contains("textDocument/publishDiagnostics", output);
        Assert.Contains("unknown type 'Nope'", output);
        Assert.Contains("\"severity\":1", output); // Error
    }

    [Fact]
    public void Publishes_empty_diagnostics_for_valid_model()
    {
        var output = RunSession(
            Initialize(),
            DidOpen("file:///ok.koi", TestSupport.BillingFixture));

        Assert.Contains("publishDiagnostics", output);
        Assert.Contains("\"diagnostics\":[]", output);
    }

    [Fact]
    public void Initialize_advertises_full_text_sync()
    {
        var output = RunSession(Initialize());
        Assert.Contains("\"textDocumentSync\":1", output);
        Assert.Contains("\"name\":\"koine\"", output);
    }

    [Fact]
    public void Unknown_request_gets_method_not_found()
    {
        var unknown = Frame("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"textDocument/foo\",\"params\":{}}");
        var output = RunSession(Initialize(), unknown);
        Assert.Contains("-32601", output);   // method-not-found, so the client doesn't hang
    }

    [Fact]
    public void ToRange_underlines_the_offending_token()
    {
        var lines = LspServer.SplitLines("context C {\n  value V { x: Nope }\n}\n");
        var (line, start, end) = LspServer.ToRange(Diagnostic.Error(DiagnosticCodes.UnknownType, "unknown type 'Nope'", 2, 16), lines);
        Assert.Equal(1, line);            // 0-based line 1 == source line 2
        Assert.Equal(15, start);          // 0-based col
        Assert.Equal(19, end);            // spans "Nope"
    }

    // ---- helpers ----------------------------------------------------------

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

    private static byte[] DidChange(string uri, string text) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "textDocument/didChange",
            @params = new { textDocument = new { uri, version = 2 }, contentChanges = new[] { new { text } } },
        }));

    private static byte[] Completion(string uri, int line, int character) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 10,
            method = "textDocument/completion",
            @params = new { textDocument = new { uri }, position = new { line, character } },
        }));

    private static byte[] Hover(string uri, int line, int character) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 11,
            method = "textDocument/hover",
            @params = new { textDocument = new { uri }, position = new { line, character } },
        }));

    private static byte[] Definition(string uri, int line, int character) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 12,
            method = "textDocument/definition",
            @params = new { textDocument = new { uri }, position = new { line, character } },
        }));

    private static byte[] InitializeWithRoot(string rootUri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "initialize",
            @params = new { rootUri },
        }));

    [Fact]
    public void Definition_resolves_across_open_files()
    {
        var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
        var catalog = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///ordering.koi", ordering),
            DidOpen("file:///catalog.koi", catalog),
            Definition("file:///ordering.koi", 1, 25)); // on "ProductId"
        Assert.Contains("file:///catalog.koi", output);
        Assert.Contains("\"range\"", output);
    }

    [Fact]
    public void Definition_resolves_into_unopened_workspace_file()
    {
        var dir = Directory.CreateTempSubdirectory("koi-ws-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "catalog.koi"),
                "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n");
            var rootUri = new Uri(dir.FullName).AbsoluteUri;
            var orderingUri = new Uri(Path.Combine(dir.FullName, "ordering.koi")).AbsoluteUri;
            var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";

            var output = RunSession(
                InitializeWithRoot(rootUri),
                DidOpen(orderingUri, ordering),
                Definition(orderingUri, 1, 25)); // on "ProductId"; catalog.koi NOT opened

            Assert.Contains("catalog.koi", output); // resolved via the on-disk workspace scan
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Open_edit_overrides_on_disk_version()
    {
        var dir = Directory.CreateTempSubdirectory("koi-ws-");
        try
        {
            var catalogPath = Path.Combine(dir.FullName, "catalog.koi");
            // On disk the owning entity is named Product.
            File.WriteAllText(catalogPath,
                "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n");
            var rootUri = new Uri(dir.FullName).AbsoluteUri;
            var catalogUri = new Uri(catalogPath).AbsoluteUri;
            var orderingUri = new Uri(Path.Combine(dir.FullName, "ordering.koi")).AbsoluteUri;
            var ordering = "context Ordering {\n  value Line { product: ProductId }\n}\n";
            // The open buffer renames the entity Product -> Widget (unsaved edit).
            var editedCatalog = "context Catalog {\n  entity Widget identified by ProductId { sku: String }\n}\n";

            var output = RunSession(
                InitializeWithRoot(rootUri),
                DidOpen(catalogUri, editedCatalog),
                DidOpen(orderingUri, ordering),
                Hover(orderingUri, 1, 25)); // hover "ProductId" -> owning entity

            Assert.Contains("Widget", output);                 // open (edited) version wins
            Assert.DoesNotContain("identity of Product", output);
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Initialize_advertises_intellisense_capabilities()
    {
        var output = RunSession(Initialize());
        Assert.Contains("\"completionProvider\"", output);
        Assert.Contains("\"hoverProvider\":true", output);
        Assert.Contains("\"definitionProvider\":true", output);
    }

    [Fact]
    public void Completion_request_returns_items()
    {
        var doc = "context C {\n  value V { x:  }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Completion("file:///t.koi", 1, 14));
        Assert.Contains("\"items\"", output);
        Assert.Contains("Decimal", output);
    }

    [Fact]
    public void Hover_request_returns_markdown()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Hover("file:///t.koi", 2, 23));
        Assert.Contains("\"kind\":\"markdown\"", output);
        Assert.Contains("Money", output);
    }

    [Fact]
    public void Definition_request_returns_a_range()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Definition("file:///t.koi", 2, 23));
        Assert.Contains("\"range\"", output);
        Assert.Contains("file:///t.koi", output);
    }

    [Fact]
    public void Completion_for_unopened_document_returns_no_items()
    {
        var output = RunSession(Initialize(), Completion("file:///never-opened.koi", 0, 0));
        Assert.DoesNotContain("\"items\"", output);
    }

    [Fact]
    public void Publishes_diagnostics_on_each_edit()
    {
        // The criterion: diagnostics stream on EVERY edit, not just on open.
        const string valid = "context C {\n  value V { x: String }\n}\n";
        const string broken = "context C {\n  value V { x: Nope }\n}\n";
        const string fixedUp = "context C {\n  value V { x: Int }\n}\n";

        var output = RunSession(
            Initialize(),
            DidOpen("file:///e.koi", valid),
            DidChange("file:///e.koi", broken),   // edit introduces an error
            DidChange("file:///e.koi", fixedUp)); // edit fixes it

        Assert.Contains("unknown type 'Nope'", output); // error streamed after the breaking edit
        Assert.Contains("\"diagnostics\":[]", output);   // cleared after the fixing edit
    }

    [Fact]
    public void Completion_offers_field_names_inside_an_invariant()
    {
        var doc = "context C {\n  value Money {\n    amount: Decimal\n    invariant amount >= am\n  }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Completion("file:///t.koi", 3, 26));
        Assert.Contains("\"items\"", output);
        Assert.Contains("amount", output);
        Assert.Contains("\"kind\":5", output); // CompletionItemKind.Field
    }
}
