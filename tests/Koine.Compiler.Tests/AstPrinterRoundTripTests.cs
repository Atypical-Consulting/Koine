using Koine.Compiler.Ast;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Lossless trivia (#5): the parser attaches leading/trailing trivia (whitespace, blank lines,
/// comments) to nodes, and <see cref="AstPrinter"/> re-emits a node verbatim. The round-trip
/// property is <c>Print(Parse(src)) == src</c> for the printed node — covering leading/trailing
/// comments, blank-line runs, and irregular indentation.
/// </summary>
public class AstPrinterRoundTripTests
{
    private static ContextNode ParseSingleContext(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        model!.Contexts.ShouldHaveSingleItem();
        return model.Contexts[0];
    }

    private static void AssertRoundTrips(string src)
    {
        ContextNode ctx = ParseSingleContext(src);
        var printed = new AstPrinter(src).Print(ctx);
        printed.ShouldBe(src);
    }

    [Fact]
    public void Round_trips_a_plain_context()
    {
        AssertRoundTrips("context C {\n  value Money { amount: Decimal }\n}\n");
    }

    [Fact]
    public void Round_trips_leading_and_trailing_line_comments()
    {
        const string src =
            "// a leading comment\n" +
            "// second line\n" +
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "}\n" +
            "// a trailing comment\n";
        AssertRoundTrips(src);
    }

    [Fact]
    public void Round_trips_blank_line_runs()
    {
        const string src =
            "\n\n" +
            "context C {\n" +
            "\n\n" +
            "  value Money { amount: Decimal }\n" +
            "\n" +
            "}\n\n\n";
        AssertRoundTrips(src);
    }

    [Fact]
    public void Round_trips_irregular_indentation()
    {
        const string src =
            "context C {\n" +
            "        value   Money    {\n" +
            "  amount:Decimal\n" +
            "            }\n" +
            "}\n";
        AssertRoundTrips(src);
    }

    [Fact]
    public void Round_trips_block_comment_inside_the_context()
    {
        const string src =
            "context C {\n" +
            "  /* a block\n" +
            "     comment */\n" +
            "  value Money { amount: Decimal }\n" +
            "}\n";
        AssertRoundTrips(src);
    }

    [Fact]
    public void Round_trips_doc_comments_with_blank_lines()
    {
        const string src =
            "context C {\n" +
            "  /// the money value object\n" +
            "  value Money { amount: Decimal }\n" +
            "\n" +
            "  /// another value object\n" +
            "  value Price { amount: Decimal }\n" +
            "}\n";
        AssertRoundTrips(src);
    }

    [Fact]
    public void Round_trips_two_top_level_contexts_composed()
    {
        // Composing sibling prints must round-trip: inter-node trivia (the blank line + comment
        // between A and B) has a single owner, so it is emitted exactly once.
        const string src =
            "// preamble\n" +
            "context A {\n  value M { x: Decimal }\n}\n" +
            "\n" +
            "// between\n" +
            "context B {\n  value N { y: Decimal }\n}\n" +
            "// trailer\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        model!.Contexts.Count.ShouldBe(2);

        var printer = new AstPrinter(src);
        var printed = string.Concat(model.Contexts.Select(printer.Print));
        printed.ShouldBe(src);
    }

    [Fact]
    public void Inter_node_trivia_is_not_duplicated_across_siblings()
    {
        const string src =
            "context A {\n  value M { x: Decimal }\n}\n" +
            "// between\n" +
            "context B {\n  value N { y: Decimal }\n}\n";
        var (model, _) = new KoineCompiler().Parse(src);
        ContextNode a = model!.Contexts[0];
        ContextNode b = model.Contexts[1];

        // The between-comment belongs to B's leading trivia only, never A's trailing.
        a.TrailingTrivia.ShouldNotContain(t => t.Kind == SyntaxTriviaKind.LineComment);
        b.LeadingTrivia.ShouldContain(t => t.Kind == SyntaxTriviaKind.LineComment);
    }

    [Fact]
    public void Leading_trivia_carries_blank_line_and_comment_kinds()
    {
        const string src =
            "\n\n" +
            "// header\n" +
            "context C {\n  value Money { amount: Decimal }\n}\n";
        ContextNode ctx = ParseSingleContext(src);

        // The leading trivia of the context includes the blank-line run and the line comment.
        ctx.LeadingTrivia.ShouldContain(t => t.Kind == SyntaxTriviaKind.BlankLine);
        ctx.LeadingTrivia.ShouldContain(t => t.Kind == SyntaxTriviaKind.LineComment);
    }
}
