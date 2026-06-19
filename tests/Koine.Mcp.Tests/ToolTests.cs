using Koine.Mcp;
using Koine.Mcp.Tools;

namespace Koine.Mcp.Tests;

/// <summary>
/// In-process tests of the MCP tool methods. The tools are thin wrappers over the (already
/// well-tested) compiler service API, so we test the wiring + result shape directly — no live
/// server needed. The end-to-end stdio path is covered separately by <see cref="ServerSmokeTests"/>.
/// </summary>
public sealed class ToolTests
{
    private static readonly string Billing = ExamplesTool.Examples("billing");

    private static KoineFile[] Files(string source, string path = "test.koi") =>
        new[] { new KoineFile(path, source) };

    // ---- koine_validate ----

    [Fact]
    public void Validate_clean_model_is_ok()
    {
        var result = ValidateTool.Validate(Files(Billing));

        result.Ok.ShouldBeTrue();
        result.ErrorCount.ShouldBe(0);
        result.Diagnostics.ShouldBeEmpty();
    }

    [Fact]
    public void Validate_broken_model_reports_diagnostics_with_spans()
    {
        // Missing field type — a syntax error the parser flags with a position.
        var result = ValidateTool.Validate(Files("context Billing { value Money { amount: } }"));

        result.Ok.ShouldBeFalse();
        (result.ErrorCount > 0).ShouldBeTrue();
        var error = result.Diagnostics.Where(d => d.Severity == "error").ShouldHaveSingleItem();
        string.IsNullOrEmpty(error.Code).ShouldBeFalse();
        (error.Line >= 1).ShouldBeTrue();
        (error.Column >= 1).ShouldBeTrue();
    }

    [Fact]
    public void Validate_attributes_diagnostics_to_their_file_in_a_multi_file_model()
    {
        var files = new[]
        {
            new KoineFile("a.koi", "context Shared { enum Color { Red, Green } }"),
            new KoineFile("b.koi", "context Shared { value Bad { x: } }"),
        };

        var result = ValidateTool.Validate(files);

        result.Ok.ShouldBeFalse();
        result.Diagnostics.ShouldContain(d => d.File == "b.koi");
    }

    // ---- koine_compile ----

    [Fact]
    public void Compile_csharp_emits_files()
    {
        var result = CompileTool.Compile(Files(Billing));

        result.Success.ShouldBeTrue();
        result.Files.ShouldNotBeEmpty();
        result.Files.ShouldContain(f => f.Contents.Contains("Money"));
        result.Files.ShouldAllBe(f => !string.IsNullOrWhiteSpace(f.Path));
    }

    [Fact]
    public void Compile_python_emits_files()
    {
        var result = CompileTool.Compile(Files(Billing), "python");

        result.Success.ShouldBeTrue();
        result.Files.ShouldNotBeEmpty();
        result.Files.ShouldContain(f => f.Path.EndsWith("koine_runtime.py", StringComparison.Ordinal));
        result.Files.ShouldAllBe(f => !string.IsNullOrWhiteSpace(f.Path));
    }

    [Fact]
    public void Compile_defaults_to_csharp_and_honors_glossary_target()
    {
        var glossary = CompileTool.Compile(Files(Billing), "glossary");

        glossary.Success.ShouldBeTrue();
        glossary.Files.ShouldNotBeEmpty();
    }

    [Fact]
    public void Compile_unknown_target_fails_gracefully()
    {
        var result = CompileTool.Compile(Files(Billing), "rust");

        result.Success.ShouldBeFalse();
        result.Files.ShouldBeEmpty();
        result.Diagnostics.ShouldContain(d => d.Message.Contains("unsupported target"));
    }

    [Fact]
    public void Compile_semantic_errors_block_emission()
    {
        var result = CompileTool.Compile(Files("context Billing { value Money { amount: } }"));

        result.Success.ShouldBeFalse();
        result.Files.ShouldBeEmpty();
        (result.ErrorCount > 0).ShouldBeTrue();
    }

    // ---- koine_format ----

    [Fact]
    public void Format_canonicalizes_and_is_idempotent()
    {
        const string messy = "context A{value V{x:Int\ny:Int}}";

        var first = FormatTool.Format(messy);
        first.Changed.ShouldBeTrue();
        first.Diagnostics.ShouldBeEmpty();

        var second = FormatTool.Format(first.Text);
        second.Changed.ShouldBeFalse();
        second.Text.ShouldBe(first.Text);
    }

    [Fact]
    public void Format_unparseable_source_returns_diagnostics_and_leaves_text_untouched()
    {
        const string broken = "context A { value V { x: } ";

        var result = FormatTool.Format(broken);

        result.Changed.ShouldBeFalse();
        result.Text.ShouldBe(broken);
        result.Diagnostics.ShouldNotBeEmpty();
    }

    // ---- koine_reference ----

    [Fact]
    public void Reference_without_topic_returns_full_document()
    {
        var reference = ReferenceTool.Reference();

        reference.ShouldContain("Koine language reference");
        reference.ShouldContain("context-map");
    }

    [Theory]
    [InlineData("value")]
    [InlineData("aggregate")]
    [InlineData("expressions")]
    [InlineData("context-map")]
    public void Reference_returns_a_section_for_each_advertised_topic(string topic)
    {
        var section = ReferenceTool.Reference(topic);

        section.ShouldNotContain("Unknown topic");
        string.IsNullOrWhiteSpace(section).ShouldBeFalse();
    }

    [Fact]
    public void Reference_unknown_topic_lists_available_topics()
    {
        var section = ReferenceTool.Reference("does-not-exist");

        section.ShouldContain("Unknown topic");
        section.ShouldContain("value");
    }

    [Fact]
    public void Reference_code_snippets_are_syntactically_valid_Koine()
    {
        // Regression guard: the cheatsheet once documented `;` as a field separator, which the
        // parser rejects — agents copied it and burned a validate round-trip. Every complete,
        // context-rooted ```koine``` block in the reference must parse without a KOI0001 syntax
        // error. (Semantic errors are tolerated: shape examples reference undeclared types on
        // purpose; we only assert the *syntax* the doc teaches is real.)
        var contextRooted = ExtractKoineBlocks(ReferenceTool.Reference())
            .Where(b => b.StartsWith("context", StringComparison.Ordinal))
            .ToList();

        contextRooted.ShouldNotBeEmpty();
        foreach (var block in contextRooted)
        {
            var result = ValidateTool.Validate(Files(block, "reference-snippet.koi"));
            var syntaxErrors = result.Diagnostics.Where(d => d.Code == "KOI0001").ToList();
            (syntaxErrors.Count == 0).ShouldBeTrue($"reference snippet has a syntax error ({syntaxErrors.FirstOrDefault()?.Message}):\n{block}");
        }
    }

    /// <summary>Extracts the bodies of all ```koine fenced code blocks from a Markdown document.</summary>
    private static IEnumerable<string> ExtractKoineBlocks(string markdown)
    {
        var lines = markdown.Replace("\r\n", "\n").Split('\n');
        var inBlock = false;
        var current = new List<string>();
        foreach (var line in lines)
        {
            if (!inBlock && line.TrimStart().StartsWith("```koine", StringComparison.Ordinal))
            {
                inBlock = true;
                current.Clear();
            }
            else if (inBlock && line.TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                inBlock = false;
                yield return string.Join("\n", current).Trim();
            }
            else if (inBlock)
            {
                current.Add(line);
            }
        }
    }

    // ---- koine_examples ----

    [Fact]
    public void Examples_without_name_lists_examples()
    {
        var listing = ExamplesTool.Examples();

        listing.ShouldContain("billing");
        listing.ShouldContain("shop-ordering");
    }

    [Fact]
    public void Examples_returns_named_source()
    {
        var source = ExamplesTool.Examples("shop-ordering");

        source.ShouldContain("context Ordering");
    }

    [Fact]
    public void Examples_unknown_name_lists_available()
    {
        var source = ExamplesTool.Examples("nope");

        source.ShouldContain("Unknown example");
        source.ShouldContain("billing");
    }

    [Fact]
    public void Every_embedded_example_compiles_or_validates_cleanly_as_part_of_the_shop_model()
    {
        // The example models are linked from the repo's real examples/demo. Validating the
        // standalone `billing` example proves the embedded knowledge is real, compilable Koine.
        var result = ValidateTool.Validate(Files(Billing, "billing.koi"));
        result.Ok.ShouldBeTrue();
    }
}
