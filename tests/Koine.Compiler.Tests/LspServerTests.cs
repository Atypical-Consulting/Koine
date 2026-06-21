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
        new KoineCompiler().Diagnose(TestSupport.BillingFixture).ShouldBeEmpty();
    }

    [Fact]
    public void Diagnose_reports_syntax_errors()
    {
        var diags = new KoineCompiler().Diagnose("context C {\n  value {\n  }\n}\n");
        diags.ShouldNotBeEmpty();
        diags[0].Line.ShouldBe(2);
    }

    [Fact]
    public void Diagnose_reports_semantic_errors()
    {
        var diags = new KoineCompiler().Diagnose("context C {\n  value V { x: Nope }\n}\n");
        diags.ShouldContain(d => d.Message.Contains("unknown type 'Nope'"));
    }

    // ---- LSP message loop -------------------------------------------------

    [Fact]
    public void Publishes_diagnostics_on_didOpen_with_invalid_model()
    {
        const string badDoc = "context C {\n  value V { x: Nope }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", badDoc));

        output.ShouldContain("textDocument/publishDiagnostics");
        output.ShouldContain("unknown type 'Nope'");
        output.ShouldContain("\"severity\":1"); // Error
    }

    [Fact]
    public void Publishes_empty_diagnostics_for_valid_model()
    {
        var output = RunSession(
            Initialize(),
            DidOpen("file:///ok.koi", TestSupport.BillingFixture));

        output.ShouldContain("publishDiagnostics");
        output.ShouldContain("\"diagnostics\":[]");
    }

    [Fact]
    public void Initialize_advertises_incremental_sync()
    {
        var output = RunSession(Initialize());
        output.ShouldContain("\"textDocumentSync\":2");
        output.ShouldContain("\"name\":\"koine\"");
    }

    [Fact]
    public void Unknown_request_gets_method_not_found()
    {
        var unknown = Frame("{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"textDocument/foo\",\"params\":{}}");
        var output = RunSession(Initialize(), unknown);
        output.ShouldContain("-32601");   // method-not-found, so the client doesn't hang
    }

    [Fact]
    public void ToRange_underlines_the_offending_token()
    {
        var lines = LspServer.SplitLines("context C {\n  value V { x: Nope }\n}\n");
        var (line, start, endLine, end) = LspServer.ToRange(Diagnostic.Error(DiagnosticCodes.UnknownType, "unknown type 'Nope'", 2, 16), lines);
        line.ShouldBe(1);            // 0-based line 1 == source line 2
        start.ShouldBe(15);          // 0-based col
        endLine.ShouldBe(1);         // single-line fallback ends on the same line
        end.ShouldBe(19);            // spans "Nope"
    }

    [Fact]
    public void ToRange_uses_the_carried_end_when_known()
    {
        // A diagnostic built from a node span carries an exact end; no forward scan needed.
        var lines = LspServer.SplitLines("context C {\n  value V { x: Nope }\n}\n");
        var span = new SourceSpan(2, 16, 2, 20, 0, 0); // 1-based start col 16, end-exclusive col 20
        var (line, start, endLine, end) = LspServer.ToRange(
            Diagnostic.FromSpan(DiagnosticCodes.UnknownType, "unknown type 'Nope'", span), lines);
        line.ShouldBe(1);            // 0-based line 1
        start.ShouldBe(15);          // 0-based start col
        endLine.ShouldBe(1);         // 0-based end line
        end.ShouldBe(19);            // 0-based end-exclusive col -> spans "Nope"
    }

    [Fact]
    public void ToRange_supports_multi_line_spans()
    {
        var lines = LspServer.SplitLines("context C {\n  value V {\n  }\n}\n");
        // A span that opens on line 2 and closes on line 3.
        var span = new SourceSpan(2, 3, 3, 4, 0, 0);
        var (line, start, endLine, end) = LspServer.ToRange(
            Diagnostic.FromSpan(DiagnosticCodes.DuplicateMember, "dup", span), lines);
        line.ShouldBe(1);            // start line 0-based
        start.ShouldBe(2);           // start col 0-based
        endLine.ShouldBe(2);         // end line 0-based (source line 3)
        end.ShouldBe(3);             // end col 0-based
    }

    [Fact]
    public void FromSpan_leaves_end_unknown_for_zero_width_point()
    {
        var d = Diagnostic.FromSpan(DiagnosticCodes.UnknownType, "x", new SourceSpan(2, 16));
        d.HasEnd.ShouldBeFalse();
        d.EndLine.ShouldBe(0);
        d.EndColumn.ShouldBe(0);

        // Falls back to the forward scan when the end is unknown.
        var lines = LspServer.SplitLines("context C {\n  value V { x: Nope }\n}\n");
        var (line, start, endLine, end) = LspServer.ToRange(d, lines);
        line.ShouldBe(1);
        start.ShouldBe(15);
        endLine.ShouldBe(1);
        end.ShouldBe(19);            // forward scan still spans "Nope"
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
        output.ShouldContain("file:///catalog.koi");
        output.ShouldContain("\"range\"");
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

            output.ShouldContain("catalog.koi"); // resolved via the on-disk workspace scan
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

            output.ShouldContain("Widget");                 // open (edited) version wins
            output.ShouldNotContain("identity of Product");
        }
        finally { dir.Delete(recursive: true); }
    }

    [Fact]
    public void Initialize_advertises_intellisense_capabilities()
    {
        var output = RunSession(Initialize());
        output.ShouldContain("\"completionProvider\"");
        output.ShouldContain("\"hoverProvider\":true");
        output.ShouldContain("\"definitionProvider\":true");
    }

    [Fact]
    public void Completion_request_returns_items()
    {
        var doc = "context C {\n  value V { x:  }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Completion("file:///t.koi", 1, 14));
        output.ShouldContain("\"items\"");
        output.ShouldContain("Decimal");
    }

    [Fact]
    public void Hover_request_returns_markdown()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Hover("file:///t.koi", 2, 23));
        output.ShouldContain("\"kind\":\"markdown\"");
        output.ShouldContain("Money");
    }

    [Fact]
    public void Definition_request_returns_a_range()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Definition("file:///t.koi", 2, 23));
        output.ShouldContain("\"range\"");
        output.ShouldContain("file:///t.koi");
    }

    [Fact]
    public void Definition_range_spans_the_target_name_not_zero_width()
    {
        // line 1 (0-based): "  value Money { amount: Decimal }" — `Money` at chars 8..13.
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Definition("file:///t.koi", 2, 23));

        // The range is the real identifier range: start char 8, end char 13 on line 1.
        output.ShouldContain("\"start\":{\"line\":1,\"character\":8}");
        output.ShouldContain("\"end\":{\"line\":1,\"character\":13}");
    }

    [Fact]
    public void Definition_inside_a_spec_body_resolves_to_the_field()
    {
        // Spec-body navigation: clicking `amount` inside the spec body lands on the field name.
        // line 1: "  value Money { amount: Decimal }" — field `amount` at chars 16..22.
        // line 2: "  spec Positive on Money = amount > 0" — `amount` operand at char 27.
        var doc = "context C {\n  value Money { amount: Decimal }\n  spec Positive on Money = amount > 0\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Definition("file:///t.koi", 2, 28));

        output.ShouldContain("\"start\":{\"line\":1,\"character\":16}");
        output.ShouldContain("\"end\":{\"line\":1,\"character\":22}");
    }

    [Fact]
    public void DocumentSymbol_selectionRange_is_the_name_and_range_is_the_full_decl()
    {
        // line 1: "  value Money { amount: Decimal }" — full decl chars 2..33, name `Money` 8..13.
        var doc = "context Shop {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), DocumentSymbol("file:///t.koi"));

        // The Money symbol's selectionRange is the identifier; its range is the whole declaration.
        output.ShouldContain("\"selectionRange\":{\"start\":{\"line\":1,\"character\":8},\"end\":{\"line\":1,\"character\":13}}");
        output.ShouldContain("\"range\":{\"start\":{\"line\":1,\"character\":2}");
    }

    [Fact]
    public void Completion_for_unopened_document_returns_no_items()
    {
        var output = RunSession(Initialize(), Completion("file:///never-opened.koi", 0, 0));
        output.ShouldNotContain("\"items\"");
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

        output.ShouldContain("unknown type 'Nope'"); // error streamed after the breaking edit
        output.ShouldContain("\"diagnostics\":[]");   // cleared after the fixing edit
    }

    [Fact]
    public void Completion_offers_field_names_inside_an_invariant()
    {
        var doc = "context C {\n  value Money {\n    amount: Decimal\n    invariant amount >= am\n  }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Completion("file:///t.koi", 3, 26));
        output.ShouldContain("\"items\"");
        output.ShouldContain("amount");
        output.ShouldContain("\"kind\":5"); // CompletionItemKind.Field
    }

    // ---- New capabilities -------------------------------------------------

    [Fact]
    public void Initialize_advertises_new_capabilities()
    {
        var output = RunSession(Initialize());
        output.ShouldContain("\"documentFormattingProvider\":true");
        output.ShouldContain("\"documentSymbolProvider\":true");
        output.ShouldContain("\"referencesProvider\":true");
        output.ShouldContain("\"renameProvider\":{\"prepareProvider\":true}");
        // codeActionProvider is now an object advertising the supported code-action kinds (so
        // editors surface the refactors), not a bare boolean.
        output.ShouldContain("\"codeActionProvider\":{\"codeActionKinds\":[\"quickfix\",\"refactor\",\"refactor.extract\"]}");
    }

    [Fact]
    public void Formatting_returns_a_full_document_edit()
    {
        // Messy indentation/spacing the formatter will canonicalize.
        var doc = "context C {\n    value V {x:String}\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Formatting("file:///t.koi"));
        output.ShouldContain("\"newText\"");
        output.ShouldContain("x: String"); // canonical "name: Type" spacing
    }

    [Fact]
    public void Formatting_already_canonical_returns_no_edits()
    {
        var doc = "context C {\n  value V {\n    x: String\n  }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Formatting("file:///t.koi"));
        output.ShouldContain("\"result\":[]"); // nothing to change
    }

    [Fact]
    public void DocumentSymbol_returns_a_hierarchy()
    {
        var doc = "context Shop {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), DocumentSymbol("file:///t.koi"));
        output.ShouldContain("\"name\":\"Shop\"");
        output.ShouldContain("\"name\":\"Money\"");
        output.ShouldContain("\"name\":\"amount\"");
        output.ShouldContain("\"children\"");
    }

    [Fact]
    public void References_returns_locations()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), References("file:///t.koi", 2, 23));
        output.ShouldContain("\"range\"");
        output.ShouldContain("file:///t.koi");
    }

    [Fact]
    public void Rename_returns_a_workspace_edit()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n  value Line { price: Money }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Rename("file:///t.koi", 1, 9, "Cash"));
        output.ShouldContain("\"changes\"");
        output.ShouldContain("\"newText\":\"Cash\"");
    }

    [Fact]
    public void Rename_with_invalid_identifier_returns_null_result()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), Rename("file:///t.koi", 1, 9, "1Bad"));
        output.ShouldContain("\"result\":null,\"id\":23"); // no WorkspaceEdit produced
        output.ShouldNotContain("\"changes\"");
    }

    [Fact]
    public void CodeAction_surfaces_a_did_you_mean_quickfix()
    {
        // A diagnostic carrying the STRUCTURED suggestion (data.suggestion) — exactly as the server
        // round-trips it through publishDiagnostics — yields a "Change to 'String'" quickfix. The
        // replacement comes from data.suggestion, NOT the message prose (the message is irrelevant).
        var diag = new object[]
        {
            new
            {
                range = new { start = new { line = 1, character = 15 }, end = new { line = 1, character = 19 } },
                severity = 1,
                code = "KOI0101",
                message = "unknown type 'Strng' — did you mean 'String'?",
                data = new { suggestion = "String" },
            },
        };
        var doc = "context C {\n  value V { x: Strng }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), CodeAction("file:///t.koi", diag));
        output.ShouldContain("\"title\":\"Change to 'String'\"");
        output.ShouldContain("\"kind\":\"quickfix\"");
        output.ShouldContain("\"newText\":\"String\"");
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
        output.ShouldContain("\"kind\":\"refactor.extract\"");
        output.ShouldContain("\"edit\":");
        output.ShouldContain("\"changes\":");
        output.ShouldContain("value ExtractedValue");
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
        output.ShouldNotContain("\"kind\":\"refactor.extract\"");
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
        output.ShouldNotContain("\"kind\":\"refactor.extract\"");
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
        output.ShouldContain("\"kind\":\"refactor.extract\"");
        output.ShouldContain("value ExtractedValue");
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
        output.ShouldContain("file:///ordering.koi");
        output.ShouldContain("\"diagnostics\":[]");
    }

    // ---- Semantic tokens --------------------------------------------------

    [Fact]
    public void Initialize_advertises_semantic_tokens_with_a_legend()
    {
        var output = RunSession(Initialize());
        output.ShouldContain("\"semanticTokensProvider\"");
        output.ShouldContain("\"legend\"");
        output.ShouldContain("\"tokenTypes\":[\"type\",\"enum\",\"enumMember\",\"property\",\"keyword\",\"parameter\"]");
        output.ShouldContain("\"tokenModifiers\":[\"declaration\"]");
        output.ShouldContain("\"full\":true");
    }

    [Fact]
    public void SemanticTokens_full_returns_encoded_data_for_a_sample_model()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), SemanticTokensFull("file:///t.koi"));
        output.ShouldContain("\"data\":[");
        output.ShouldNotContain("\"data\":[]"); // a parsing model produces tokens
    }

    [Fact]
    public void SemanticTokens_full_degrades_to_empty_for_a_broken_document()
    {
        var doc = "context C {\n  value {\n  }\n}\n"; // unnamed value: does not parse
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", doc), SemanticTokensFull("file:///t.koi"));
        output.ShouldContain("\"data\":[]");
    }

    [Fact]
    public void SemanticTokens_full_for_unopened_document_returns_empty_data()
    {
        var output = RunSession(Initialize(), SemanticTokensFull("file:///never-opened.koi"));
        output.ShouldContain("\"data\":[]");
    }

    [Fact]
    public void CodeAction_quickfix_ignores_the_message_prose_and_reads_the_structured_suggestion()
    {
        // Proof the prose is no longer scraped: a BLANK message with only data.suggestion still yields
        // the correct fix, and a diagnostic carrying no data.suggestion yields no quickfix even though
        // its message contains the legacy "did you mean" marker.
        var withData = new object[]
        {
            new
            {
                range = new { start = new { line = 1, character = 15 }, end = new { line = 1, character = 19 } },
                severity = 1,
                code = "KOI0101",
                message = "",
                data = new { suggestion = "String" },
            },
        };
        var doc = "context C {\n  value V { x: Strng }\n}\n";
        var withDataOutput = RunSession(Initialize(), DidOpen("file:///t.koi", doc), CodeAction("file:///t.koi", withData));
        withDataOutput.ShouldContain("\"title\":\"Change to 'String'\"");
        withDataOutput.ShouldContain("\"newText\":\"String\"");

        var proseOnly = new object[]
        {
            new
            {
                range = new { start = new { line = 1, character = 15 }, end = new { line = 1, character = 19 } },
                severity = 1,
                code = "KOI0101",
                message = "unknown type 'Strng' — did you mean 'String'?",
            },
        };
        var proseOutput = RunSession(Initialize(), DidOpen("file:///t.koi", doc), CodeAction("file:///t.koi", proseOnly));
        proseOutput.ShouldNotContain("\"title\":\"Change to");
    }

    // ---- Custom koine/* requests ----

    private static byte[] EmitPreview(string uri, string? target) =>
        Frame(JsonSerializer.Serialize(target is null
            // The two ternary branches are distinct anonymous types, so the cast to object is required
            // for type inference (CS0411 without it) — the "redundant cast" hint is a false positive.
            // ReSharper disable once RedundantCast
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

    private static byte[] Model(string uri, string? qualifiedName = null) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 32,
            method = "koine/model",
            @params = new { textDocument = new { uri }, qualifiedName },
        }));

    private static byte[] ModelMembers(string uri, string qualifiedName) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 33,
            method = "koine/modelMembers",
            @params = new { textDocument = new { uri }, qualifiedName },
        }));

    private static byte[] EmitKoine(string uri, object edit) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 34,
            method = "koine/emitKoine",
            @params = new { textDocument = new { uri }, edit },
        }));

    private static byte[] ApplyModelEdit(string uri, object edit) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 35,
            method = "koine/applyModelEdit",
            @params = new { textDocument = new { uri }, edit },
        }));

    // ---- koine/model* (round-trip seam, #91) ----

    private const string ModelDoc = "context C {\n  value Money { amount: Decimal }\n  enum Currency { EUR, USD }\n}\n";

    [Fact]
    public void Model_returns_the_structured_tree()
    {
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", ModelDoc), Model("file:///t.koi"));

        output.ShouldContain("\"kind\":\"model\"");
        output.ShouldContain("\"qualifiedName\":\"C.Money\"");
        output.ShouldContain("\"kind\":\"value\"");
        output.ShouldContain("\"id\":32");
    }

    [Fact]
    public void Model_scoped_by_qualified_name_returns_the_subtree()
    {
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", ModelDoc), Model("file:///t.koi", "C.Money"));

        output.ShouldContain("\"qualifiedName\":\"C.Money\"");
        output.ShouldContain("\"name\":\"amount\"");
        output.ShouldNotContain("\"qualifiedName\":\"C.Currency\"");
    }

    [Fact]
    public void ModelMembers_lists_a_nodes_children()
    {
        var output = RunSession(
            Initialize(), DidOpen("file:///t.koi", ModelDoc), ModelMembers("file:///t.koi", "C.Currency"));

        output.ShouldContain("\"members\":[");
        output.ShouldContain("\"name\":\"EUR\"");
        output.ShouldContain("\"name\":\"USD\"");
        output.ShouldContain("\"id\":33");
    }

    [Fact]
    public void EmitKoine_returns_canonical_koi_for_a_legal_edit()
    {
        var edit = new { kind = "addField", target = "C.Money", name = "tax", type = "Decimal" };
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", ModelDoc), EmitKoine("file:///t.koi", edit));

        output.ShouldContain("\"koine\":");
        output.ShouldContain("tax: Decimal");
        output.ShouldContain("\"diagnostics\":[]");
        output.ShouldContain("\"id\":34");
    }

    [Fact]
    public void EmitKoine_returns_diagnostics_for_an_illegal_edit()
    {
        var edit = new { kind = "changeFieldType", target = "C.Money.amount", type = "Nope" };
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", ModelDoc), EmitKoine("file:///t.koi", edit));

        output.ShouldContain("\"koine\":null");
        output.ShouldContain("KOI0101");   // unknown type
    }

    [Fact]
    public void ApplyModelEdit_returns_a_scoped_text_edit()
    {
        var edit = new { kind = "addField", target = "C.Money", name = "tax", type = "Decimal" };
        var output = RunSession(Initialize(), DidOpen("file:///t.koi", ModelDoc), ApplyModelEdit("file:///t.koi", edit));

        output.ShouldContain("\"uri\":\"file:///t.koi\"");
        output.ShouldContain("\"edits\":[");
        output.ShouldNotContain("\"edits\":[]");
        output.ShouldContain("\"newText\":");
        output.ShouldContain("\"id\":35");
    }

    // ---- koine/glossaryModel ----

    [Fact]
    public void GlossaryModel_returns_structured_entries_for_open_model()
    {
        var doc = "/// The C context.\ncontext C {\n  value Money { amount: Decimal }\n  enum Currency { EUR, USD }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            GlossaryModel("file:///t.koi"));

        output.ShouldContain("\"entries\":[");
        output.ShouldContain("\"qualifiedName\":\"C.Money\"");
        output.ShouldContain("\"kind\":\"value\"");
        output.ShouldContain("\"kind\":\"enum\"");
        output.ShouldContain("\"id\":30");
    }

    [Fact]
    public void GlossaryModel_reports_undocumented_entries_with_null_doc()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            GlossaryModel("file:///t.koi"));

        output.ShouldContain("\"doc\":null");
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

        output.ShouldContain("\"edits\":[");
        output.ShouldNotContain("\"edits\":[]");
        output.ShouldContain("/// A monetary amount.");
        output.ShouldContain("\"uri\":\"file:///t.koi\"");
        output.ShouldContain("\"id\":30");
    }

    [Fact]
    public void SetDoc_unknown_id_returns_no_edits()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            SetDoc("file:///t.koi", "C.Nope", "x"));

        output.ShouldContain("\"edits\":[]");
        output.ShouldContain("\"id\":30");
    }

    private static byte[] Docs(string uri) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            id = 31,
            method = "koine/docs",
            @params = new { textDocument = new { uri } },
        }));

    // ---- koine/emitPreview ----

    [Fact]
    public void EmitPreview_default_target_emits_csharp_files()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", target: null));

        output.ShouldContain("\"target\":\"csharp\"");
        output.ShouldContain("\"files\":[");
        output.ShouldNotContain("\"files\":[]");
        output.ShouldContain(".cs");
        output.ShouldContain("Money");
        output.ShouldContain("\"error\":null");
    }

    [Fact]
    public void EmitPreview_typescript_target_emits_ts_files()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", "typescript"));

        output.ShouldContain("\"target\":\"typescript\"");
        output.ShouldContain(".ts");
        output.ShouldNotContain("\"files\":[]");
        output.ShouldContain("\"error\":null");
    }

    [Fact]
    public void EmitPreview_python_target_emits_py_files()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", "python"));

        output.ShouldContain("\"target\":\"python\"");
        output.ShouldContain(".py");
        output.ShouldNotContain("\"files\":[]");
        output.ShouldContain("\"error\":null");
    }

    [Fact]
    public void EmitPreview_unknown_target_returns_error_result_not_throw()
    {
        var doc = "context C {\n  value Money { amount: Decimal }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", "ruby"));

        output.ShouldContain("unknown target 'ruby'");
        output.ShouldContain("\"files\":[]");
        output.ShouldNotContain("-32601"); // a normal result, not a JSON-RPC error
        output.ShouldContain("\"id\":30");     // response correlated to the request id
    }

    [Fact]
    public void EmitPreview_model_with_errors_yields_empty_files_plus_diagnostics()
    {
        var doc = "context C {\n  value V { x: Nope }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            EmitPreview("file:///t.koi", "csharp"));

        output.ShouldContain("\"files\":[]");
        output.ShouldContain("unknown type 'Nope'");
        output.ShouldContain("\"severity\":1");
        output.ShouldContain("\"error\":null");
        output.ShouldContain("file:///t.koi"); // per-diagnostic uri
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
            output.ShouldContain("namespace Acme.Billing;");
            output.ShouldNotContain("namespace Billing;");
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

        output.ShouldContain("\"markdown\":");
        output.ShouldContain("# Ubiquitous Language Glossary");
        output.ShouldContain("## C");
        output.ShouldContain("Money");
        output.ShouldContain("\"id\":30");
        output.ShouldNotContain("\"markdown\":\"\"");
    }

    [Fact]
    public void Glossary_null_model_returns_empty_markdown()
    {
        var badDoc = "context C {\n  value {\n  }\n}\n"; // unnamed value: does not parse
        var output = RunSession(
            Initialize(),
            DidOpen("file:///bad.koi", badDoc),
            Glossary("file:///bad.koi"));

        output.ShouldContain("\"markdown\":\"\"");
        output.ShouldContain("\"id\":30");
        output.ShouldNotContain("Ubiquitous Language Glossary");
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

        output.ShouldContain("## Catalog");
        output.ShouldContain("## Sales");
        output.ShouldContain("Product");
        output.ShouldContain("Order");
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

        output.ShouldContain("\"contexts\":[");
        output.ShouldContain("Catalog");
        output.ShouldContain("Sales");
        output.ShouldContain("\"upstream\":\"Catalog\"");
        output.ShouldContain("\"downstream\":\"Sales\"");
        output.ShouldContain("\"kind\":\"Conformist\"");
        output.ShouldContain("\"bidirectional\":false");
        output.ShouldNotContain("\"relations\":[]");
    }

    [Fact]
    public void ContextMap_with_no_map_returns_contexts_and_empty_relations()
    {
        var doc = "context Catalog {\n  value Product { sku: String }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///nomap.koi", doc),
            ContextMap("file:///nomap.koi"));

        output.ShouldContain("Catalog");
        output.ShouldContain("\"relations\":[]");
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

        output.ShouldContain("\"kind\":\"Partnership\"");
        output.ShouldContain("\"bidirectional\":true");
        output.ShouldContain("\"upstream\":\"A\"");
        output.ShouldContain("\"downstream\":\"B\"");
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

        output.ShouldContain("\"kind\":\"SharedKernel\"");
        output.ShouldContain("\"sharedTypes\":[\"Money\"]");
        output.ShouldContain("\"bidirectional\":true");
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

        output.ShouldContain("\"kind\":\"AntiCorruptionLayer\"");
        output.ShouldContain("\"upstreamContext\":\"Legacy\"");
        output.ShouldContain("\"upstreamType\":\"Account\"");
        output.ShouldContain("\"localContext\":\"Billing\"");
        output.ShouldContain("\"localType\":\"Customer\"");
    }

    [Fact]
    public void ContextMap_malformed_request_without_uri_returns_empty_dto()
    {
        // A request with no textDocument.uri must degrade to the empty DTO, not throw.
        var noUri = Frame("{\"jsonrpc\":\"2.0\",\"id\":30,\"method\":\"koine/contextMap\",\"params\":{}}");
        var output = RunSession(Initialize(), noUri);

        output.ShouldContain("\"contexts\":[]");
        output.ShouldContain("\"relations\":[]");
        output.ShouldNotContain("-32601"); // a normal result, not a JSON-RPC error
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

            output.ShouldContain("\"hasBreakingChanges\":true");
            output.ShouldContain("KOI1510");
            output.ShouldContain("\"impact\":\"Breaking\"");
            output.ShouldContain("OrderPlaced");
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

            output.ShouldContain("\"hasBreakingChanges\":false");
            output.ShouldContain("\"changes\":[]");
            output.ShouldNotContain("\"impact\":\"Breaking\"");
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

        output.ShouldContain("\"error\":\"baseline path is required\"");
        output.ShouldContain("\"hasBreakingChanges\":false");
        output.ShouldNotContain("-32601");
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

            output.ShouldContain("baseline failed to parse");
            output.ShouldContain("\"hasBreakingChanges\":false");
            output.ShouldNotContain("\"impact\":\"Breaking\"");
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

            output.ShouldContain("no .koi files found");
            output.ShouldContain("\"hasBreakingChanges\":false");
            output.ShouldNotContain("-32601");
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

        output.ShouldContain("cannot read baseline");
        output.ShouldContain("\"hasBreakingChanges\":false");
        output.ShouldNotContain("-32601");
    }

    // ---- koine/docs ----

    [Fact]
    public void Docs_returns_mermaid_files_for_open_model()
    {
        // A state machine produces a Mermaid stateDiagram in the context's docs file.
        var doc = "context C {\n"
                + "  aggregate Order root Order {\n"
                + "    enum OrderStatus { Draft, Placed }\n"
                + "    entity Order identified by OrderId {\n"
                + "      status: OrderStatus = Draft\n"
                + "      states status { Draft -> Placed }\n"
                + "    }\n"
                + "  }\n"
                + "}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", doc),
            Docs("file:///t.koi"));

        output.ShouldContain("\"files\":[");
        output.ShouldNotContain("\"files\":[]");
        output.ShouldContain("docs/C.md");   // one page per bounded context
        output.ShouldContain("docs/index.md");
        output.ShouldContain("mermaid");      // inline Mermaid diagram fences
        output.ShouldContain("\"id\":31");
    }

    [Fact]
    public void Docs_null_model_returns_empty_files()
    {
        var badDoc = "context C {\n  value {\n  }\n}\n"; // unnamed value: does not parse
        var output = RunSession(
            Initialize(),
            DidOpen("file:///bad.koi", badDoc),
            Docs("file:///bad.koi"));

        output.ShouldContain("\"files\":[]");
        output.ShouldContain("\"id\":31");
        output.ShouldNotContain("-32601"); // a normal result, not a JSON-RPC error
    }

    // ---- capability discovery ----

    [Fact]
    public void Initialize_advertises_custom_requests_under_experimental()
    {
        var output = RunSession(Initialize());
        output.ShouldContain("\"experimental\"");
        output.ShouldContain("\"koineEmitPreview\":true");
        output.ShouldContain("\"koineGlossary\":true");
        output.ShouldContain("\"koineContextMap\":true");
        output.ShouldContain("\"koineDocs\":true");
        output.ShouldContain("\"koineCheck\":true");
        // Additive — existing capabilities unchanged.
        output.ShouldContain("\"hoverProvider\":true");
        output.ShouldContain("\"textDocumentSync\":2");
    }

    // ---- Incremental sync tests -------------------------------------------

    private static byte[] DidChangeIncremental(string uri, int startLine, int startChar, int endLine, int endChar, string newText) =>
        Frame(JsonSerializer.Serialize(new
        {
            jsonrpc = "2.0",
            method = "textDocument/didChange",
            @params = new
            {
                textDocument = new { uri, version = 2 },
                contentChanges = new[]
                {
                    new
                    {
                        range = new
                        {
                            start = new { line = startLine, character = startChar },
                            end = new { line = endLine, character = endChar },
                        },
                        text = newText,
                    },
                },
            },
        }));

    [Fact]
    public void IncrementalChange_produces_same_diagnostics_as_full_open()
    {
        // Open a valid doc, then apply an incremental change that introduces an error.
        // The result must equal opening the invalid version directly (full open).
        const string t0 = "context C {\n  value V { x: String }\n}\n";
        // Change "String" (line 1, chars 15..21) to "Nope"
        var incrementalOutput = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", t0),
            DidChangeIncremental("file:///t.koi", 1, 15, 1, 21, "Nope"));

        // Full-open equivalent: open the already-broken version directly.
        const string t1 = "context C {\n  value V { x: Nope }\n}\n";
        var fullOutput = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", t1));

        // Both must produce the same unknown-type diagnostic.
        incrementalOutput.ShouldContain("unknown type 'Nope'");
        fullOutput.ShouldContain("unknown type 'Nope'");
    }

    [Fact]
    public void IncrementalChange_fix_clears_diagnostics()
    {
        // Open an invalid doc, then incrementally fix it; final diagnostics must be empty.
        const string broken = "context C {\n  value V { x: Nope }\n}\n";
        // Change "Nope" (line 1, chars 15..19) back to "String"
        var output = RunSession(
            Initialize(),
            DidOpen("file:///t.koi", broken),
            DidChangeIncremental("file:///t.koi", 1, 15, 1, 19, "String"));

        // After the fix, the last publishDiagnostics for this uri should have no errors.
        output.ShouldContain("unknown type 'Nope'");    // published after didOpen
        output.ShouldContain("\"diagnostics\":[]");      // published after incremental fix
    }

    [Fact]
    public void DidClose_clears_diagnostics_for_uri()
    {
        // Open an invalid doc (diagnostics published), then close it.
        // A publishDiagnostics with an empty array must be sent for that uri.
        const string badDoc = "context C {\n  value V { x: Nope }\n}\n";
        var output = RunSession(
            Initialize(),
            DidOpen("file:///close-test.koi", badDoc),
            Frame(JsonSerializer.Serialize(new
            {
                jsonrpc = "2.0",
                method = "textDocument/didClose",
                @params = new { textDocument = new { uri = "file:///close-test.koi" } },
            })));

        // The file had errors after open.
        output.ShouldContain("unknown type 'Nope'");

        // After close, a publishDiagnostics with empty array must appear for the same uri.
        // Check both the uri and the empty-array clearing notification are present.
        output.ShouldContain("file:///close-test.koi");
        output.ShouldContain("\"diagnostics\":[]");
    }
}
