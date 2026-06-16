using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Direct unit tests for <see cref="SyntaxGraph"/>: the reference-keyed parent map (records use
/// value equality, so identity is mandatory), the upward-navigation API, and the FullSpan-descent
/// position lookup (equivalence with the previous full-tree scan).
/// </summary>
public class SyntaxGraphTests
{
    private static KoineModel Parse(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        Assert.Empty(diagnostics);
        Assert.NotNull(model);
        return model!;
    }

    private const string Src =
        "context Shop {\n" +
        "  value Money { amount: Decimal }\n" +
        "  spec Positive on Money = amount > 0\n" +
        "}\n";

    [Fact]
    public void Parent_uses_reference_identity_not_value_equality()
    {
        // Two value-EQUAL IdentifierExpr("x") with DIFFERENT parents. A value-keyed map would
        // collapse them to one entry; reference identity keeps them distinct.
        var idA = new IdentifierExpr("x");
        var idB = new IdentifierExpr("x");
        Assert.Equal(idA, idB);                 // value equality holds...
        Assert.NotSame(idA, idB);               // ...but they are distinct instances

        var lit0 = new LiteralExpr(LiteralKind.Int, "0");
        var lit9 = new LiteralExpr(LiteralKind.Int, "9");
        var gt = new BinaryExpr(BinaryOp.Gt, idA, lit0);
        var lt = new BinaryExpr(BinaryOp.Lt, idB, lit9);
        var root = new BinaryExpr(BinaryOp.And, gt, lt);

        var graph = new SyntaxGraph(root);

        Assert.Same(gt, graph.Parent(idA));
        Assert.Same(lt, graph.Parent(idB));
        Assert.Null(graph.Parent(root));
    }

    [Fact]
    public void Ancestors_are_nearest_first_and_AncestorsAndSelf_starts_with_self()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        // The "amount" identifier inside the spec body.
        var id = NodeWalker.Descendants(model).OfType<IdentifierExpr>().Single(n => n.Name == "amount");

        var ancestors = graph.Ancestors(id).ToList();
        Assert.DoesNotContain(id, ancestors);
        Assert.Same(model, ancestors[^1]);                       // walk terminates at the root

        var withSelf = graph.AncestorsAndSelf(id).ToList();
        Assert.Same(id, withSelf[0]);                            // self first
        Assert.Equal(ancestors, withSelf.Skip(1).ToList());      // then the ancestors, in order
    }

    [Fact]
    public void FirstAncestorOrSelf_finds_the_enclosing_spec()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);
        var id = NodeWalker.Descendants(model).OfType<IdentifierExpr>().Single(n => n.Name == "amount");

        // The "amount" reference here lives inside the spec body (`spec Positive on Money = amount > 0`),
        // so the nearest enclosing declaration is the SpecDecl — not the Money value object, which the
        // spec targets by name but does not lexically nest.
        var spec = graph.FirstAncestorOrSelf<SpecDecl>(id);
        Assert.NotNull(spec);
        Assert.Equal("Positive", spec!.Name);
    }

    [Fact]
    public void Parent_span_contains_child_span_for_positioned_nodes()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        foreach (var node in NodeWalker.Descendants(model))
        {
            if (node.Span.Length <= 0)
            {
                continue;
            }

            // Find the nearest ancestor that itself has a real span and assert containment.
            var ancestor = graph.Ancestors(node).FirstOrDefault(a => a.Span.Length > 0);
            if (ancestor is null)
            {
                continue;
            }

            Assert.True(ancestor.Span.Offset <= node.Span.Offset);
            Assert.True(ancestor.Span.Offset + ancestor.Span.Length >= node.Span.Offset + node.Span.Length);
        }
    }

    // Brute-force oracle: the previous behavior — smallest positioned span containing the offset,
    // first in pre-order on ties. FindNode must match this for every offset.
    private static KoineNode? BruteInnermost(KoineModel model, int offset, bool useNameSpan)
    {
        KoineNode? best = null;
        var bestLength = int.MaxValue;
        foreach (var node in NodeWalker.Descendants(model))
        {
            var span = useNameSpan ? node.NameSpan : node.Span;
            if (span.Length > 0
                && offset >= span.Offset && offset < span.Offset + span.Length
                && span.Length < bestLength)
            {
                best = node;
                bestLength = span.Length;
            }
        }

        return best;
    }

    [Fact]
    public void FindNode_matches_the_brute_force_scan_for_every_offset()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        for (var offset = 0; offset <= Src.Length; offset++)
        {
            Assert.Same(BruteInnermost(model, offset, useNameSpan: false), graph.FindNode(offset));
        }
    }

    [Fact]
    public void FindNameNode_matches_the_brute_force_scan_for_every_offset()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        for (var offset = 0; offset <= Src.Length; offset++)
        {
            Assert.Same(BruteInnermost(model, offset, useNameSpan: true), graph.FindNameNode(offset));
        }
    }

    [Fact]
    public void FindNode_returns_null_outside_any_positioned_node()
    {
        var graph = new SyntaxGraph(Parse(Src));
        Assert.Null(graph.FindNode(int.MaxValue));
        Assert.Null(graph.FindNode(-1));
    }
}
