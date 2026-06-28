using Koine.Compiler.Ast;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Tree-driven reconstruction (#B, Task 6): <see cref="AstPrinter"/> composes a node's text from the
/// tree (leaf text + trivia + child recursion), so it can print a subtree that was synthesized in
/// memory and never parsed from a source string — the precondition for AST-level refactors/codemods
/// that splice freshly-built subtrees while preserving comments and whitespace.
/// </summary>
public class AstPrinterSynthesizedTests
{
    [Fact]
    public void Prints_a_synthesized_leaf_with_no_source_in_hand()
    {
        // Built entirely in memory; the printer has no source string.
        var leaf = new IdentifierExpr("amount")
        {
            LeafText = "amount",
            LeadingTrivia = [new SyntaxTrivia(SyntaxTriviaKind.Whitespace, "  ", SourceSpan.None)],
            TrailingTrivia = [new SyntaxTrivia(SyntaxTriviaKind.LineComment, " // kept", SourceSpan.None)],
        };

        new AstPrinter().Print(leaf).ShouldBe("  amount // kept");
        // The sourceless printer agrees with the node's own tree-driven ToFullString().
        new AstPrinter().Print(leaf).ShouldBe(leaf.ToFullString());
    }

    [Fact]
    public void Prints_a_synthesized_composite_by_recursing_children_in_source_order()
    {
        // A composite with no LeafText and no source recurses into its children, ordered by offset.
        // (Spans: Line, Column, EndLine, EndColumn, Offset, Length.)
        var left = new IdentifierExpr("a") { LeafText = "a", Span = new SourceSpan(1, 1, 1, 2, 0, 1) };
        var right = new IdentifierExpr("b")
        {
            LeafText = "b",
            Span = new SourceSpan(1, 3, 1, 4, 2, 1),
            LeadingTrivia = [new SyntaxTrivia(SyntaxTriviaKind.Whitespace, " ", SourceSpan.None)],
        };
        var sum = new BinaryExpr(BinaryOp.Add, left, right) { Span = new SourceSpan(1, 1, 1, 4, 0, 3) };

        // Children emit in offset order, preserving the right operand's leading whitespace trivia.
        // (The "+" is a structural token, not a node — the documented SyntaxToken boundary.)
        new AstPrinter().Print(sum).ShouldBe("a b");
    }

    [Fact]
    public void Splicing_a_synthesized_leaf_into_a_parsed_subtree_prints_correctly_without_source()
    {
        // Parse a real subtree, then mutate it in memory (splice a freshly-built identifier with a
        // trailing comment) and print with a sourceless printer — the synthesized leaf and the
        // original leaf both reconstruct from the tree, comment preserved.
        var (model, diagnostics) = new KoineCompiler()
            .Parse("context C {\n  value Money {\n    amount: Decimal\n    doubled: Decimal = amount\n  }\n}\n");
        diagnostics.ShouldBeEmpty();

        IdentifierExpr original = NodeWalker.Descendants(model!).OfType<IdentifierExpr>().Single();
        IdentifierExpr spliced = original with
        {
            Name = "balance",
            LeafText = "balance",
            TrailingTrivia = [new SyntaxTrivia(SyntaxTriviaKind.LineComment, " // renamed", SourceSpan.None)],
        };

        // Sourceless printer reconstructs the mutated leaf from the tree: original leading space +
        // new leaf text + the spliced trailing comment.
        new AstPrinter().Print(spliced).ShouldBe(" balance // renamed");
    }
}
