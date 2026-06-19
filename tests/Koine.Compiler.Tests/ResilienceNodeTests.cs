using Koine.Compiler.Ast;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for the resilient-syntax marker node kinds added to <c>Ast/</c>: the target-agnostic
/// <see cref="ErrorNode"/> (a skipped/unexpected token wrapper) and the base-node
/// <see cref="KoineNode.IsMissing"/> / <see cref="KoineNode.LeafText"/> markers. These prove the
/// "red layer" (the reflection <see cref="NodeWalker"/> and the build-once <see cref="SyntaxGraph"/>)
/// indexes and routes to the new kinds for free — no per-kind plumbing required.
/// </summary>
public class ResilienceNodeTests
{
    // A positioned half-open span [offset, offset+length).
    private static SourceSpan SpanAt(int offset, int length) =>
        new(Line: 1, Column: offset + 1, EndLine: 1, EndColumn: offset + 1 + length, Offset: offset, Length: length);

    [Fact]
    public void ErrorNode_carries_its_skipped_text_and_a_span_via_the_base()
    {
        var error = new ErrorNode("@@@") { Span = SpanAt(4, 3) };

        error.Text.ShouldBe("@@@");
        error.Span.Offset.ShouldBe(4);
        error.Span.Length.ShouldBe(3);
        error.IsMissing.ShouldBeFalse();   // default
        error.LeafText.ShouldBeNull();     // default
    }

    [Fact]
    public void Base_markers_default_to_not_missing_and_no_leaf_text()
    {
        // Any node, exercised through a concrete kind: the new base slots default off.
        var id = new IdentifierExpr("x");
        id.IsMissing.ShouldBeFalse();
        id.LeafText.ShouldBeNull();

        // …and are init-settable for ANTLR-inserted phantom tokens / leaf reconstruction.
        var missing = id with { IsMissing = true, LeafText = "x" };
        missing.IsMissing.ShouldBeTrue();
        missing.LeafText.ShouldBe("x");
    }

    [Fact]
    public void NodeWalker_Descendants_includes_an_ErrorNode_and_a_missing_node()
    {
        // The ErrorNode is the subtree root here (no existing node has a KoineNode-typed slot that
        // would accept a non-Expr/non-TypeDecl child), but the walk reaching it through Descendants
        // is the assertion that matters: the reflection walker enumerates the new kind for free.
        var error = new ErrorNode("?!") { Span = SpanAt(6, 2) };
        NodeWalker.Descendants(error).ShouldContain(error);

        // A phantom (ANTLR-inserted) node is walked exactly like any other node, and it is reachable
        // through a real parent slot (BinaryExpr.Left/Right are Expr-typed; IdentifierExpr is an Expr).
        var missing = new IdentifierExpr("amount") { IsMissing = true, Span = SpanAt(0, 6) };
        var zero = new LiteralExpr(LiteralKind.Int, "0") { Span = SpanAt(9, 1) };
        var root = new BinaryExpr(BinaryOp.Gt, missing, zero) { Span = SpanAt(0, 10) };

        var descendants = NodeWalker.Descendants(root).ToList();
        descendants.ShouldContain(missing);
        descendants.OfType<IdentifierExpr>().Single(n => n.IsMissing).ShouldBeSameAs(missing);
    }

    [Fact]
    public void SyntaxGraph_routes_position_lookup_to_an_ErrorNode_subtree()
    {
        // Build the graph over an ErrorNode root: the generated child enumerator must recognize the
        // new kind (a leaf here, so no children) and the FullSpan-descent FindNode must route to it.
        var error = new ErrorNode("?!") { Span = SpanAt(6, 2) };
        var graph = new SyntaxGraph(error);

        graph.ChildNodes(error).ShouldBeEmpty();          // recognized kind, no children
        graph.FindNode(6).ShouldBeSameAs(error);          // span [6, 8) contains offset 6
        graph.FindNode(7).ShouldBeSameAs(error);
        graph.FindNode(8).ShouldBeNull();                 // half-open: end is exclusive
    }

    [Fact]
    public void SyntaxGraph_indexes_a_missing_node_as_a_child_and_routes_to_it()
    {
        var missing = new IdentifierExpr("amount") { IsMissing = true, Span = SpanAt(0, 6) };
        var zero = new LiteralExpr(LiteralKind.Int, "0") { Span = SpanAt(9, 1) };
        var root = new BinaryExpr(BinaryOp.Gt, missing, zero) { Span = SpanAt(0, 10) };

        var graph = new SyntaxGraph(root);

        // The generated child enumerator (what SyntaxGraph.Build consumes) indexes the phantom child…
        graph.ChildNodes(root).ShouldContain(missing);
        graph.Parent(missing).ShouldBeSameAs(root);
        // …and FullSpan-descent routes a position inside its span to it.
        graph.FindNode(2).ShouldBeSameAs(missing);
    }
}
