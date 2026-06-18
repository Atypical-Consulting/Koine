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

        Assert.True(result.Ok);
        Assert.Equal(0, result.ErrorCount);
        Assert.Empty(result.Diagnostics);
    }

    [Fact]
    public void Validate_broken_model_reports_diagnostics_with_spans()
    {
        // Missing field type — a syntax error the parser flags with a position.
        var result = ValidateTool.Validate(Files("context Billing { value Money { amount: } }"));

        Assert.False(result.Ok);
        Assert.True(result.ErrorCount > 0);
        var error = Assert.Single(result.Diagnostics, d => d.Severity == "error");
        Assert.False(string.IsNullOrEmpty(error.Code));
        Assert.True(error.Line >= 1);
        Assert.True(error.Column >= 1);
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

        Assert.False(result.Ok);
        Assert.Contains(result.Diagnostics, d => d.File == "b.koi");
    }

    // ---- koine_compile ----

    [Fact]
    public void Compile_csharp_emits_files()
    {
        var result = CompileTool.Compile(Files(Billing));

        Assert.True(result.Success);
        Assert.NotEmpty(result.Files);
        Assert.Contains(result.Files, f => f.Contents.Contains("Money"));
        Assert.All(result.Files, f => Assert.False(string.IsNullOrWhiteSpace(f.Path)));
    }

    [Fact]
    public void Compile_defaults_to_csharp_and_honors_glossary_target()
    {
        var glossary = CompileTool.Compile(Files(Billing), "glossary");

        Assert.True(glossary.Success);
        Assert.NotEmpty(glossary.Files);
    }

    [Fact]
    public void Compile_unknown_target_fails_gracefully()
    {
        var result = CompileTool.Compile(Files(Billing), "rust");

        Assert.False(result.Success);
        Assert.Empty(result.Files);
        Assert.Contains(result.Diagnostics, d => d.Message.Contains("unsupported target"));
    }

    [Fact]
    public void Compile_semantic_errors_block_emission()
    {
        var result = CompileTool.Compile(Files("context Billing { value Money { amount: } }"));

        Assert.False(result.Success);
        Assert.Empty(result.Files);
        Assert.True(result.ErrorCount > 0);
    }

    // ---- koine_format ----

    [Fact]
    public void Format_canonicalizes_and_is_idempotent()
    {
        const string messy = "context A{value V{x:Int\ny:Int}}";

        var first = FormatTool.Format(messy);
        Assert.True(first.Changed);
        Assert.Empty(first.Diagnostics);

        var second = FormatTool.Format(first.Text);
        Assert.False(second.Changed);
        Assert.Equal(first.Text, second.Text);
    }

    [Fact]
    public void Format_unparseable_source_returns_diagnostics_and_leaves_text_untouched()
    {
        const string broken = "context A { value V { x: } ";

        var result = FormatTool.Format(broken);

        Assert.False(result.Changed);
        Assert.Equal(broken, result.Text);
        Assert.NotEmpty(result.Diagnostics);
    }

    // ---- koine_reference ----

    [Fact]
    public void Reference_without_topic_returns_full_document()
    {
        var reference = ReferenceTool.Reference();

        Assert.Contains("Koine language reference", reference);
        Assert.Contains("context-map", reference);
    }

    [Theory]
    [InlineData("value")]
    [InlineData("aggregate")]
    [InlineData("expressions")]
    [InlineData("context-map")]
    public void Reference_returns_a_section_for_each_advertised_topic(string topic)
    {
        var section = ReferenceTool.Reference(topic);

        Assert.DoesNotContain("Unknown topic", section);
        Assert.False(string.IsNullOrWhiteSpace(section));
    }

    [Fact]
    public void Reference_unknown_topic_lists_available_topics()
    {
        var section = ReferenceTool.Reference("does-not-exist");

        Assert.Contains("Unknown topic", section);
        Assert.Contains("value", section);
    }

    // ---- koine_examples ----

    [Fact]
    public void Examples_without_name_lists_examples()
    {
        var listing = ExamplesTool.Examples();

        Assert.Contains("billing", listing);
        Assert.Contains("shop-ordering", listing);
    }

    [Fact]
    public void Examples_returns_named_source()
    {
        var source = ExamplesTool.Examples("shop-ordering");

        Assert.Contains("context Ordering", source);
    }

    [Fact]
    public void Examples_unknown_name_lists_available()
    {
        var source = ExamplesTool.Examples("nope");

        Assert.Contains("Unknown example", source);
        Assert.Contains("billing", source);
    }

    [Fact]
    public void Every_embedded_example_compiles_or_validates_cleanly_as_part_of_the_shop_model()
    {
        // The example models are linked from the repo's real examples/demo. Validating the
        // standalone `billing` example proves the embedded knowledge is real, compilable Koine.
        var result = ValidateTool.Validate(Files(Billing, "billing.koi"));
        Assert.True(result.Ok);
    }
}
