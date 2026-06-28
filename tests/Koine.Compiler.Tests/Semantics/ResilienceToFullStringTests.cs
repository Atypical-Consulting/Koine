using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Self-describing tree (#B): every leaf expression node now carries its verbatim <see
/// cref="KoineNode.LeafText"/> and its leading/trailing trivia, and <see cref="KoineNode.ToFullString"/>
/// reconstructs a node's source text <b>from the tree alone</b> — with no access to the original
/// source string. This is the precondition for splicing synthesized subtrees while preserving
/// comments and whitespace.
/// </summary>
public class ResilienceToFullStringTests
{
    [Fact]
    public void ToFullString_reconstructs_a_synthesized_leaf_from_leaf_text_and_trivia_without_source()
    {
        // Built entirely in memory — there is no source string anywhere. ToFullString composes
        // leading trivia + leaf text + trailing trivia purely from the node.
        var node = new IdentifierExpr("amount")
        {
            LeafText = "amount",
            LeadingTrivia = [new SyntaxTrivia(SyntaxTriviaKind.Whitespace, " ", SourceSpan.None)],
            TrailingTrivia = [new SyntaxTrivia(SyntaxTriviaKind.LineComment, "// note", SourceSpan.None)],
        };

        node.ToFullString().ShouldBe(" amount// note");
    }

    [Fact]
    public void ToFullString_composes_a_synthesized_composite_from_its_children_in_source_order()
    {
        // A composite node with no LeafText reconstructs by concatenating its child nodes'
        // ToFullString in ascending-offset order — even when the children are added out of order.
        // (Spans: Line, Column, EndLine, EndColumn, Offset, Length.)
        var later = new IdentifierExpr("b") { LeafText = "b", Span = new SourceSpan(1, 3, 1, 4, 2, 1) };
        var earlier = new IdentifierExpr("a") { LeafText = "a", Span = new SourceSpan(1, 1, 1, 2, 0, 1) };

        // BinaryExpr's children are (Left, Right); we deliberately put the higher-offset node in
        // Left to prove ToFullString orders by Span.Offset, not by declaration order.
        var composite = new BinaryExpr(BinaryOp.Add, later, earlier) { Span = new SourceSpan(1, 1, 1, 4, 0, 3) };

        // Children emit in offset order ("a" then "b"). NOTE the documented boundary: the "+"
        // operator is a structural token, not a node, so a pure tree walk cannot reproduce it —
        // byte-perfect rendering of such composites needs the source (AstPrinter's fallback) or the
        // SyntaxToken escalation. This is the leaf-text-first step, asserted honestly.
        composite.ToFullString().ShouldBe("ab");
    }

    [Fact]
    public void A_parsed_expression_leaf_carries_its_verbatim_leaf_text()
    {
        var src = "context C {\n  value Money {\n    amount: Decimal\n    doubled: Decimal = amount\n  }\n}\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();

        IdentifierExpr id = NodeWalker.Descendants(model!).OfType<IdentifierExpr>().Single();
        id.Name.ShouldBe("amount");
        id.LeafText.ShouldBe("amount");
        // Reconstructed from the tree with no source in hand: the leaf captures the space after
        // `=` as leading whitespace trivia, then its verbatim leaf text.
        id.ToFullString().ShouldBe(" amount");
    }

    [Fact]
    public void A_parsed_expression_now_carries_trivia_where_the_source_had_a_comment()
    {
        // The initializer expression is preceded by a block comment; expressions now capture trivia
        // (previously only declarations/members did), so the leaf reconstructs the comment verbatim.
        var src = "context C {\n  value Money {\n    amount: Decimal\n    doubled: Decimal = /* keep me */ amount\n  }\n}\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();

        IdentifierExpr id = NodeWalker.Descendants(model!).OfType<IdentifierExpr>().Single();
        id.LeadingTrivia.ShouldContain(t => t.Kind == SyntaxTriviaKind.BlockComment && t.Text == "/* keep me */");
        // ToFullString reconstructs the comment + whitespace + identifier straight from the tree.
        id.ToFullString().ShouldContain("/* keep me */");
        id.ToFullString().Trim().ShouldEndWith("amount");
    }
}
