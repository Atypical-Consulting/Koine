using System.Text;
using System.Text.Json;
using Koine.Cli;
using Koine.Compiler.Ast;
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
        var (line, start, endLine, end) = LspServer.ToRange(Diagnostic.Error(DiagnosticCodes.UnknownType, "unknown type 'Nope'", 2, 16), lines);
        Assert.Equal(1, line);            // 0-based line 1 == source line 2
        Assert.Equal(15, start);          // 0-based col
        Assert.Equal(1, endLine);         // single-line fallback ends on the same line
        Assert.Equal(19, end);            // spans "Nope"
    }

    [Fact]
    public void ToRange_uses_the_carried_end_when_known()
    {
        // A diagnostic built from a node span carries an exact end; no forward scan needed.
        var lines = LspServer.SplitLines("context C {\n  value V { x: Nope }\n}\n");
        var span = new SourceSpan(2, 16, 2, 20, 0, 0); // 1-based start col 16, end-exclusive col 20
        var (line, start, endLine, end) = LspServer.ToRange(
            Diagnostic.FromSpan(DiagnosticCodes.UnknownType, "unknown type 'Nope'", span), lines);
        Assert.Equal(1, line);            // 0-based line 1
        Assert.Equal(15, start);          // 0-based start col
        Assert.Equal(1, endLine);         // 0-based end line
        Assert.Equal(19, end);            // 0-based end-exclusive col -> spans "Nope"
    }

    [Fact]
    public void ToRange_supports_multi_line_spans()
    {
        var lines = LspServer.SplitLines("context C {\n  value V {\n  }\n}\n");
        // A span that opens on line 2 and closes on line 3.
        var span = new SourceSpan(2, 3, 3, 4, 0, 0);
        var (line, start, endLine, end) = LspServer.ToRange(
            Diagnostic.FromSpan(DiagnosticCodes.DuplicateMember, "dup", span), lines);
        Assert.Equal(1, line);            // start line 0-based
        Assert.Equal(2, start);           // start col 0-based
        Assert.Equal(2, endLine);         // end line 0-based (source line 3)
        Assert.Equal(3, end);             // end col 0-based
    }

    [Fact]
    public void FromSpan_leaves_end_unknown_for_zero_width_point()
    {
        var d = Diagnostic.FromSpan(DiagnosticCodes.UnknownType, "x", new SourceSpan(2, 16));
        Assert.False(d.HasEnd);
        Assert.Equal(0, d.EndLine);
        Assert.Equal(0, d.EndColumn);

        // Falls back to the forward scan when the end is unknown.
        var lines = LspServer.SplitLines("context C {\n  value V { x: Nope }\n}\n");
        var (line, start, endLine, end) = LspServer.ToRange(d, lines);
        Assert.Equal(1, line);
        Assert.Equal(15, start);
        Assert.Equal(1, endLine);
        Assert.Equal(19, end);            // forward scan still spans "Nope"
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

    private static byte[] Formatting(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 20,
            method = "textDocument/formatting",
            @params = new { textDocument = new { uri }, options = new { tabSize = 2, insertSpaces = true } },
        }));

    private static byte[] DocumentSymbol(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 21,
            method = "textDocument/documentSymbol",
            @params = new { textDocument = new { uri } },
        }));

    private static byte[] References(string uri, int line, int character) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 22,
            method = "textDocument/references",
            @params = new { textDocument = new { uri }, position = new { line, character }, context = new { includeDeclaration = true } },
        }));

    private static byte[] Rename(string uri, int line, int character, string newName) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 23,
            method = "textDocument/rename",
            @params = new { textDocument = new { uri }, position = new { line, character }, newName },
        }));

    private static byte[] CodeAction(string uri, object[] diagnostics) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 24,
            method = "textDocument/codeAction",
            @params = new
            {
                textDocument = new { uri },
                range = new { start = new { line = 0, character = 0 }, end = new { line = 0, character = 0 } },
                context = new { diagnostics },
            },
        }));

    private static byte[] CodeActionRange(string uri, int startLine, int startChar, int endLine, int endChar) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 24,
            method = "textDocument/codeAction",
            @params = new
            {
                textDocument = new { uri },
                range = new
                {
                    start = new { line = startLine, character = startChar },
                    end = new { line = endLine, character = endChar },
                },
                context = new { diagnostics = Array.Empty<object>() },
            },
        }));

    private static byte[] CodeActionRangeOnly(string uri, int startLine, int startChar, int endLine, int endChar, string[] only) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 24,
            method = "textDocument/codeAction",
            @params = new
            {
                textDocument = new { uri },
                range = new
                {
                    start = new { line = startLine, character = startChar },
                    end = new { line = endLine, character = endChar },
                },
                context = new { diagnostics = Array.Empty<object>(), only },
            },
        }));

    private static byte[] SemanticTokensFull(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 25,
            method = "textDocument/semanticTokens/full",
            @params = new { textDocument = new { uri } },
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
    public void Definition_range_spans_the_target_name_not_zero_width()
    {
        // line 1 (0-based): "  value Money { amount: Decimal }" — `Money` at chars 8..13.
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Definition("file:///t.koi", 2, 23));

        // The range is the real identifier range: start char 8, end char 13 on line 1.
        Assert.Contains("\"start\":{\"line\":1,\"character\":8}", output);
        Assert.Contains("\"end\":{\"line\":1,\"character\":13}", output);
    }

    [Fact]
    public void Definition_inside_a_spec_body_resolves_to_the_field()
    {
        // Spec-body navigation: clicking `amount` inside the spec body lands on the field name.
        // line 1: "  value Money { amount: Decimal }" — field `amount` at chars 16..22.
        // line 2: "  spec Positive on Money = amount > 0" — `amount` operand at char 27.
        var doc = "context C {\n  value Money { amount: Decimal }\n  spec Positive on Money = amount > 0\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Definition("file:///t.koi", 2, 28));

        Assert.Contains("\"start\":{\"line\":1,\"character\":16}", output);
        Assert.Contains("\"end\":{\"line\":1,\"character\":22}", output);
    }

    [Fact]
    public void DocumentSymbol_selectionRange_is_the_name_and_range_is_the_full_decl()
    {
        // line 1: "  value Money { amount: Decimal }" — full decl chars 2..33, name `Money` 8..13.
        var doc = "context Shop {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), DocumentSymbol("file:///t.koi"));

        // The Money symbol's selectionRange is the identifier; its range is the whole declaration.
        Assert.Contains("\"selectionRange\":{\"start\":{\"line\":1,\"character\":8},\"end\":{\"line\":1,\"character\":13}}", output);
        Assert.Contains("\"range\":{\"start\":{\"line\":1,\"character\":2}", output);
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

    // ---- New capabilities -------------------------------------------------

    [Fact]
    public void Initialize_advertises_new_capabilities()
    {
        var output = RunSession(Initialize());
        Assert.Contains("\"documentFormattingProvider\":true", output);
        Assert.Contains("\"documentSymbolProvider\":true", output);
        Assert.Contains("\"referencesProvider\":true", output);
        Assert.Contains("\"renameProvider\":{\"prepareProvider\":true}", output);
        // codeActionProvider is now an object advertising the supported code-action kinds (so
        // editors surface the refactors), not a bare boolean.
        Assert.Contains("\"codeActionProvider\":{\"codeActionKinds\":[\"quickfix\",\"refactor\",\"refactor.extract\"]}", output);
    }

    [Fact]
    public void Formatting_returns_a_full_document_edit()
    {
        // Messy indentation/spacing the formatter will canonicalize.
        var doc = "context C {\n    value V {x:String}\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Formatting("file:///t.koi"));
        Assert.Contains("\"newText\"", output);
        Assert.Contains("x: String", output); // canonical "name: Type" spacing
    }

    [Fact]
    public void Formatting_already_canonical_returns_no_edits()
    {
        var doc = "context C {\n  value V {\n    x: String\n  }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Formatting("file:///t.koi"));
        Assert.Contains("\"result\":[]", output); // nothing to change
    }

    [Fact]
    public void DocumentSymbol_returns_a_hierarchy()
    {
        var doc = "context Shop {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), DocumentSymbol("file:///t.koi"));
        Assert.Contains("\"name\":\"Shop\"", output);
        Assert.Contains("\"name\":\"Money\"", output);
        Assert.Contains("\"name\":\"amount\"", output);
        Assert.Contains("\"children\"", output);
    }

    [Fact]
    public void References_returns_locations()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), References("file:///t.koi", 2, 23));
        Assert.Contains("\"range\"", output);
        Assert.Contains("file:///t.koi", output);
    }

    [Fact]
    public void Rename_returns_a_workspace_edit()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Rename("file:///t.koi", 1, 9, "Cash"));
        Assert.Contains("\"changes\"", output);
        Assert.Contains("\"newText\":\"Cash\"", output);
    }

    [Fact]
    public void Rename_with_invalid_identifier_returns_null_result()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Rename("file:///t.koi", 1, 9, "1Bad"));
        Assert.Contains("\"result\":null,\"id\":23", output); // no WorkspaceEdit produced
        Assert.DoesNotContain("\"changes\"", output);
    }

    [Fact]
    public void CodeAction_surfaces_a_did_you_mean_quickfix()
    {
        // A synthetic diagnostic carrying a "did you mean 'String'?" message yields a quickfix.
        var diag = new object[]
        {
            new
            {
                range = new { start = new { line = 1, character = 15 }, end = new { line = 1, character = 19 } },
                severity = 1,
                code = "KOI0101",
                message = "unknown type 'Strng' — did you mean 'String'?",
            },
        };
        var doc = "context C {\n  value V { x: Strng }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), CodeAction("file:///t.koi", diag));
        Assert.Contains("\"title\":\"Change to 'String'\"", output);
        Assert.Contains("\"kind\":\"quickfix\"", output);
        Assert.Contains("\"newText\":\"String\"", output);
    }

    [Fact]
    public void CodeAction_over_a_field_range_offers_an_extract_value_object_refactor()
    {
        // Selecting the `street` field of an Address value object should offer the extract refactor
        // with a non-empty WorkspaceEdit. Line 2 (0-based): "  value Address { street: String }".
        var doc = "context C {\n  value Address { street: String }\n}\n";
        // "street" begins at character 18 and ends at 24 on line 1 (0-based).
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            CodeActionRange("file:///t.koi", 1, 18, 1, 24));
        Assert.Contains("\"kind\":\"refactor.extract\"", output);
        Assert.Contains("\"edit\":", output);
        Assert.Contains("\"changes\":", output);
        Assert.Contains("value ExtractedValue", output);
    }

    [Fact]
    public void CodeAction_over_a_non_field_range_offers_no_refactor()
    {
        // A selection on the `value` keyword (not on a field) yields no extract refactor.
        var doc = "context C {\n  value Address { street: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            CodeActionRange("file:///t.koi", 1, 2, 1, 7)); // the "value" keyword
        // The capabilities response advertises "refactor.extract" as a supported kind, so assert
        // the absence of an emitted action (which carries a "kind":"refactor.extract" property).
        Assert.DoesNotContain("\"kind\":\"refactor.extract\"", output);
    }

    [Fact]
    public void CodeAction_with_only_quickfix_does_not_return_the_extract_refactor()
    {
        // context.only = ["quickfix"] scopes the request to quickfixes; the extract refactor
        // (kind "refactor.extract") must NOT be offered, even though the selection lands on a field.
        var doc = "context C {\n  value Address { street: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            CodeActionRangeOnly("file:///t.koi", 1, 18, 1, 24, new[] { "quickfix" }));
        Assert.DoesNotContain("\"kind\":\"refactor.extract\"", output);
    }

    [Fact]
    public void CodeAction_with_only_refactor_returns_the_extract_refactor()
    {
        // context.only = ["refactor"] admits "refactor.extract" by hierarchical prefix match.
        var doc = "context C {\n  value Address { street: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            CodeActionRangeOnly("file:///t.koi", 1, 18, 1, 24, new[] { "refactor" }));
        Assert.Contains("\"kind\":\"refactor.extract\"", output);
        Assert.Contains("value ExtractedValue", output);
    }

    [Fact]
    public void Workspace_diagnostics_surface_cross_file_errors()
    {
        // Ordering references ProductId, but no entity declares it and no Catalog defines it,
        // unless catalog.koi is in the workspace. Here we feed a cross-file scenario where the
        // referenced type only resolves because both files are diagnosed together.
        var ordering = "context Ordering {\n  import Catalog.{ Product }\n  value Line { item: Product }\n}\n";
        var catalog = "context Catalog {\n  value Product { sku: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///catalog.koi", catalog),
            DidOpen("file:///ordering.koi", ordering));
        // With both files merged, Ordering's reference to the imported Product resolves: no error.
        Assert.Contains("file:///ordering.koi", output);
        Assert.Contains("\"diagnostics\":[]", output);
    }

    // ---- Semantic tokens --------------------------------------------------

    [Fact]
    public void Initialize_advertises_semantic_tokens_with_a_legend()
    {
        var output = RunSession(Initialize());
        Assert.Contains("\"semanticTokensProvider\"", output);
        Assert.Contains("\"legend\"", output);
        Assert.Contains("\"tokenTypes\":[\"type\",\"enum\",\"enumMember\",\"property\",\"keyword\",\"parameter\"]", output);
        Assert.Contains("\"tokenModifiers\":[\"declaration\"]", output);
        Assert.Contains("\"full\":true", output);
    }

    [Fact]
    public void SemanticTokens_full_returns_encoded_data_for_a_sample_model()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), SemanticTokensFull("file:///t.koi"));
        Assert.Contains("\"data\":[", output);
        Assert.DoesNotContain("\"data\":[]", output); // a parsing model produces tokens
    }

    [Fact]
    public void SemanticTokens_full_degrades_to_empty_for_a_broken_document()
    {
        var doc = "context C {\n  value {\n  }\n}\n"; // unnamed value: does not parse
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), SemanticTokensFull("file:///t.koi"));
        Assert.Contains("\"data\":[]", output);
    }

    [Fact]
    public void SemanticTokens_full_for_unopened_document_returns_empty_data()
    {
        var output = RunSession(Initialize(), SemanticTokensFull("file:///never-opened.koi"));
        Assert.Contains("\"data\":[]", output);
    }

    [Fact]
    public void ExtractSuggestion_parses_the_did_you_mean_marker()
    {
        Assert.Equal("String", LspServer.ExtractSuggestion("unknown type 'Strng' — did you mean 'String'?"));
        Assert.Null(LspServer.ExtractSuggestion("unknown type 'Strng'"));
    }

    // ---- Custom koine/* requests ----

    private static byte[] EmitPreview(string uri, string? target) =>
        Frame(JsonSerializer.Serialize(target is null
            ? (object)new
            {
                jsonrpc = "2.0",
                id = 30,
                method = "koine/emitPreview",
                @params = new { textDocument = new { uri } },
            }
            : new
            {
                jsonrpc = "2.0",
                id = 30,
                method = "koine/emitPreview",
                @params = new { textDocument = new { uri }, target },
            }));

    private static byte[] Glossary(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 30,
            method = "koine/glossary",
            @params = new { textDocument = new { uri } },
        }));

    private static byte[] ContextMap(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 30,
            method = "koine/contextMap",
            @params = new { textDocument = new { uri } },
        }));

    private static byte[] Check(string uri, string baseline) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 30,
            method = "koine/check",
            @params = new { textDocument = new { uri }, baseline },
        }));

    private static byte[] GlossaryModel(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 30,
            method = "koine/glossaryModel",
            @params = new { textDocument = new { uri } },
        }));

    private static byte[] SetDoc(string uri, string id, string text) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 30,
            method = "koine/setDoc",
            @params = new { textDocument = new { uri }, id, text },
        }));

    // ---- koine/glossaryModel ----

    [Fact]
    public void GlossaryModel_returns_structured_entries_for_open_model()
    {
        var doc = "/// The C context.\ncontext C {\n  value Money { amount: Decimal }\n  enum Currency { EUR, USD }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            GlossaryModel("file:///t.koi"));

        Assert.Contains("\"entries\":[", output);
        Assert.Contains("\"qualifiedName\":\"C.Money\"", output);
        Assert.Contains("\"kind\":\"value\"", output);
        Assert.Contains("\"kind\":\"enum\"", output);
        Assert.Contains("\"id\":30", output);
    }

    [Fact]
    public void GlossaryModel_reports_undocumented_entries_with_null_doc()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            GlossaryModel("file:///t.koi"));

        Assert.Contains("\"doc\":null", output);
    }

    // ---- koine/setDoc ----

    [Fact]
    public void SetDoc_returns_edits_for_a_known_declaration()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            SetDoc("file:///t.koi", "C.Money", "A monetary amount."));

        Assert.Contains("\"edits\":[", output);
        Assert.DoesNotContain("\"edits\":[]", output);
        Assert.Contains("/// A monetary amount.", output);
        Assert.Contains("\"uri\":\"file:///t.koi\"", output);
        Assert.Contains("\"id\":30", output);
    }

    [Fact]
    public void SetDoc_unknown_id_returns_no_edits()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            SetDoc("file:///t.koi", "C.Nope", "x"));

        Assert.Contains("\"edits\":[]", output);
        Assert.Contains("\"id\":30", output);
    }

    // ---- koine/emitPreview ----

    [Fact]
    public void EmitPreview_default_target_emits_csharp_files()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", target: null));

        Assert.Contains("\"target\":\"csharp\"", output);
        Assert.Contains("\"files\":[", output);
        Assert.DoesNotContain("\"files\":[]", output);
        Assert.Contains(".cs", output);
        Assert.Contains("Money", output);
        Assert.Contains("\"error\":null", output);
    }

    [Fact]
    public void EmitPreview_typescript_target_emits_ts_files()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", "typescript"));

        Assert.Contains("\"target\":\"typescript\"", output);
        Assert.Contains(".ts", output);
        Assert.DoesNotContain("\"files\":[]", output);
        Assert.Contains("\"error\":null", output);
    }

    [Fact]
    public void EmitPreview_unknown_target_returns_error_result_not_throw()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", "rust"));

        Assert.Contains("unknown target 'rust'", output);
        Assert.Contains("\"files\":[]", output);
        Assert.DoesNotContain("-32601", output); // a normal result, not a JSON-RPC error
        Assert.Contains("\"id\":30", output);     // response correlated to the request id
    }

    [Fact]
    public void EmitPreview_model_with_errors_yields_empty_files_plus_diagnostics()
    {
        var doc = "context C {\n  value V { x: Nope }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", "csharp"));

        Assert.Contains("\"files\":[]", output);
        Assert.Contains("unknown type 'Nope'", output);
        Assert.Contains("\"severity\":1", output);
        Assert.Contains("\"error\":null", output);
        Assert.Contains("file:///t.koi", output); // per-diagnostic uri
    }

    [Fact]
    public void EmitPreview_honors_koine_config_so_it_matches_the_build()
    {
        // The preview must resolve the SAME per-target options the build does (R16.1 namespace
        // remap), so a configured workspace previews byte-identically to `koine build`. Discovery
        // is anchored on the previewed document's path, so the .koi lives on disk beside the config.
        var dir = Directory.CreateTempSubdirectory("koi-cfg-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "koine.config"),
                "target = csharp\ntargets.csharp.namespaces.Billing = Acme.Billing\n");
            var koiPath = Path.Combine(dir.FullName, "billing.koi");
            const string doc = "context Billing {\n  value Money { amount: Decimal }\n}\n";
            File.WriteAllText(koiPath, doc);

            var rootUri = new Uri(dir.FullName).AbsoluteUri;
            var koiUri = new Uri(koiPath).AbsoluteUri;

            var output = RunSession(
                InitializeWithRoot(rootUri),
                DidOpen(koiUri, doc),
                EmitPreview(koiUri, "csharp"));

            // The configured namespace remap is applied — exactly as the build would emit it.
            Assert.Contains("namespace Acme.Billing;", output);
            Assert.DoesNotContain("namespace Billing;", output);
        }
        finally { dir.Delete(recursive: true); }
    }

    // ---- koine/glossary ----

    [Fact]
    public void Glossary_returns_markdown_for_open_model()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            Glossary("file:///t.koi"));

        Assert.Contains("\"markdown\":", output);
        Assert.Contains("# Ubiquitous Language Glossary", output);
        Assert.Contains("## C", output);
        Assert.Contains("Money", output);
        Assert.Contains("\"id\":30", output);
        Assert.DoesNotContain("\"markdown\":\"\"", output);
    }

    [Fact]
    public void Glossary_null_model_returns_empty_markdown()
    {
        var badDoc = "context C {\n  value {\n  }\n}\n"; // unnamed value: does not parse
        var output = RunSession(
            Initialize(),
            DidOpen("file:///bad.koi", badDoc),
            Glossary("file:///bad.koi"));

        Assert.Contains("\"markdown\":\"\"", output);
        Assert.Contains("\"id\":30", output);
        Assert.DoesNotContain("Ubiquitous Language Glossary", output);
    }

    [Fact]
    public void Glossary_merges_whole_workspace_across_open_files()
    {
        var catalog = "context Catalog {\n  value Product { sku: String }\n}\n";
        var sales = "context Sales {\n  value Order { total: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///catalog.koi", catalog),
            DidOpen("file:///sales.koi", sales),
            Glossary("file:///catalog.koi"));

        Assert.Contains("## Catalog", output);
        Assert.Contains("## Sales", output);
        Assert.Contains("Product", output);
        Assert.Contains("Order", output);
    }

    // ---- koine/contextMap ----

    [Fact]
    public void ContextMap_request_returns_contexts_and_relations()
    {
        var doc = "context Catalog {\n  entity Product identified by ProductId { sku: String }\n}\n"
                + "context Sales {\n  value Order { ref: String }\n}\n"
                + "contextmap {\n  Catalog -> Sales : conformist\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///cm.koi", doc),
            ContextMap("file:///cm.koi"));

        Assert.Contains("\"contexts\":[", output);
        Assert.Contains("Catalog", output);
        Assert.Contains("Sales", output);
        Assert.Contains("\"upstream\":\"Catalog\"", output);
        Assert.Contains("\"downstream\":\"Sales\"", output);
        Assert.Contains("\"kind\":\"Conformist\"", output);
        Assert.Contains("\"bidirectional\":false", output);
        Assert.DoesNotContain("\"relations\":[]", output);
    }

    [Fact]
    public void ContextMap_with_no_map_returns_contexts_and_empty_relations()
    {
        var doc = "context Catalog {\n  value Product { sku: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///nomap.koi", doc),
            ContextMap("file:///nomap.koi"));

        Assert.Contains("Catalog", output);
        Assert.Contains("\"relations\":[]", output);
    }

    [Fact]
    public void ContextMap_bidirectional_partnership_marks_bidirectional_true()
    {
        var doc = "context A {\n  value X { v: String }\n}\n"
                + "context B {\n  value Y { v: String }\n}\n"
                + "contextmap {\n  A <-> B : partnership\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///part.koi", doc),
            ContextMap("file:///part.koi"));

        Assert.Contains("\"kind\":\"Partnership\"", output);
        Assert.Contains("\"bidirectional\":true", output);
        Assert.Contains("\"upstream\":\"A\"", output);
        Assert.Contains("\"downstream\":\"B\"", output);
    }

    [Fact]
    public void ContextMap_shared_kernel_relation_exposes_shared_types()
    {
        // A shared-kernel relation carries the shared type names; the DTO must surface them in
        // `sharedTypes` (empty for every other relation kind).
        var doc = "context Sales {\n  value Money { amount: Decimal }\n}\n"
                + "context Shipping {\n  value Money { amount: Decimal }\n}\n"
                + "contextmap {\n  Sales <-> Shipping : shared-kernel { Money }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///sk.koi", doc),
            ContextMap("file:///sk.koi"));

        Assert.Contains("\"kind\":\"SharedKernel\"", output);
        Assert.Contains("\"sharedTypes\":[\"Money\"]", output);
        Assert.Contains("\"bidirectional\":true", output);
    }

    [Fact]
    public void ContextMap_anti_corruption_layer_relation_exposes_acl_mappings()
    {
        // An anti-corruption-layer relation carries Upstream.Type -> Local.Type mappings; the DTO
        // must surface each as an `acl` entry with the four qualified parts.
        var doc = "context Legacy {\n  value Account { id: String }\n  value Charge { id: String }\n}\n"
                + "context Billing {\n  value Customer { id: String }\n  value Invoice { id: String }\n}\n"
                + "contextmap {\n  Legacy -> Billing : anti-corruption-layer\n"
                + "    acl { Legacy.Account -> Billing.Customer\n"
                + "          Legacy.Charge  -> Billing.Invoice }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///acl.koi", doc),
            ContextMap("file:///acl.koi"));

        Assert.Contains("\"kind\":\"AntiCorruptionLayer\"", output);
        Assert.Contains("\"upstreamContext\":\"Legacy\"", output);
        Assert.Contains("\"upstreamType\":\"Account\"", output);
        Assert.Contains("\"localContext\":\"Billing\"", output);
        Assert.Contains("\"localType\":\"Customer\"", output);
    }

    [Fact]
    public void ContextMap_malformed_request_without_uri_returns_empty_dto()
    {
        // A request with no textDocument.uri must degrade to the empty DTO, not throw.
        var noUri = Frame("{\"jsonrpc\":\"2.0\",\"id\":30,\"method\":\"koine/contextMap\",\"params\":{}}");
        var output = RunSession(Initialize(), noUri);

        Assert.Contains("\"contexts\":[]", output);
        Assert.Contains("\"relations\":[]", output);
        Assert.DoesNotContain("-32601", output); // a normal result, not a JSON-RPC error
    }

    // ---- koine/check ----

    [Fact]
    public void Check_reports_a_breaking_change_against_a_baseline()
    {
        var dir = Directory.CreateTempSubdirectory("koi-check-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "baseline.koi"),
                "context Sales {\n  integration event OrderPlaced {\n    orderId: OrderId\n    total:   Decimal\n    note:    String?\n  }\n}\n");

            var output = RunSession(
                Initialize(),
                DidOpen("file:///current.koi", "context Sales { }"),
                Check("file:///current.koi", dir.FullName));

            Assert.Contains("\"hasBreakingChanges\":true", output);
            Assert.Contains("KOI1510", output);
            Assert.Contains("\"impact\":\"Breaking\"", output);
            Assert.Contains("OrderPlaced", output);
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Check_reports_no_breaking_changes_for_identical_model()
    {
        const string source = "context Sales {\n  integration event OrderPlaced {\n    orderId: OrderId\n    total:   Decimal\n    note:    String?\n  }\n}\n";
        var dir = Directory.CreateTempSubdirectory("koi-check-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "baseline.koi"), source);

            var output = RunSession(
                Initialize(),
                DidOpen("file:///current.koi", source),
                Check("file:///current.koi", dir.FullName));

            Assert.Contains("\"hasBreakingChanges\":false", output);
            Assert.Contains("\"changes\":[]", output);
            Assert.DoesNotContain("\"impact\":\"Breaking\"", output);
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Check_with_missing_baseline_param_returns_error_result()
    {
        var source = "context Sales {\n  integration event OrderPlaced { orderId: OrderId }\n}\n";
        var noBaseline = Frame("{\"jsonrpc\":\"2.0\",\"id\":30,\"method\":\"koine/check\",\"params\":{\"textDocument\":{\"uri\":\"file:///current.koi\"}}}");
        var output = RunSession(
            Initialize(),
            DidOpen("file:///current.koi", source),
            noBaseline);

        Assert.Contains("\"error\":\"baseline path is required\"", output);
        Assert.Contains("\"hasBreakingChanges\":false", output);
        Assert.DoesNotContain("-32601", output);
    }

    [Fact]
    public void Check_with_unparseable_baseline_returns_error_with_message()
    {
        var dir = Directory.CreateTempSubdirectory("koi-check-");
        try
        {
            File.WriteAllText(Path.Combine(dir.FullName, "baseline.koi"),
                "context Sales {\n  value {\n  }\n}\n"); // syntactically broken

            var output = RunSession(
                Initialize(),
                DidOpen("file:///current.koi", "context Sales {\n  integration event OrderPlaced { orderId: OrderId }\n}\n"),
                Check("file:///current.koi", dir.FullName));

            Assert.Contains("baseline failed to parse", output);
            Assert.Contains("\"hasBreakingChanges\":false", output);
            Assert.DoesNotContain("\"impact\":\"Breaking\"", output);
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Check_with_empty_baseline_dir_returns_no_koi_files_error()
    {
        // An existing directory with no .koi files is the "nothing to compare" branch.
        var dir = Directory.CreateTempSubdirectory("koi-check-");
        try
        {
            var output = RunSession(
                Initialize(),
                DidOpen("file:///current.koi", "context Sales { }"),
                Check("file:///current.koi", dir.FullName));

            Assert.Contains("no .koi files found", output);
            Assert.Contains("\"hasBreakingChanges\":false", output);
            Assert.DoesNotContain("-32601", output);
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Check_with_nonexistent_baseline_path_returns_error_not_throw()
    {
        // A path that does not exist surfaces as a structured error result, never a throw.
        var missing = Path.Combine(Path.GetTempPath(), "koi-check-does-not-exist-9d3f", "baseline");
        var output = RunSession(
            Initialize(),
            DidOpen("file:///current.koi", "context Sales { }"),
            Check("file:///current.koi", missing));

        Assert.Contains("cannot read baseline", output);
        Assert.Contains("\"hasBreakingChanges\":false", output);
        Assert.DoesNotContain("-32601", output);
    }

    // ---- capability discovery ----

    [Fact]
    public void Initialize_advertises_custom_requests_under_experimental()
    {
        var output = RunSession(Initialize());
        Assert.Contains("\"experimental\"", output);
        Assert.Contains("\"koineEmitPreview\":true", output);
        Assert.Contains("\"koineGlossary\":true", output);
        Assert.Contains("\"koineContextMap\":true", output);
        Assert.Contains("\"koineCheck\":true", output);
        // Additive — existing capabilities unchanged.
        Assert.Contains("\"hoverProvider\":true", output);
        Assert.Contains("\"textDocumentSync\":1", output);
    }
}
