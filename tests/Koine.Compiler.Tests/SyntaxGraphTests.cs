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
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return model!;
    }

    private const string Src =
        "context Shop {\n" +
        "  value Money { amount: Decimal }\n" +
        "  spec Positive on Money = amount > 0\n" +
        "}\n";

    // The InExpressionNavigationTests fixture: a field referenced inside an invariant body.
    private const string InvariantSrc =
        "context Shop {\n" +
        "  value Money {\n" +
        "    amount: Decimal\n" +
        "    invariant amount > 0\n" +
        "  }\n" +
        "}\n";

    // Resolves a named corpus entry to its source. Kept lazy (vs a static dictionary) so the
    // billing fixture's file read happens inside the test, not at type-load / test-discovery.
    private static string SourceFor(string key) => key switch
    {
        "inline" => Src,
        "invariant" => InvariantSrc,
        "billing" => TestSupport.BillingFixture,
        _ => throw new ArgumentOutOfRangeException(nameof(key), key, "unknown oracle corpus source")
    };

    // The corpus the FullSpan-descent lookup is proven equivalent against: the two inline nav
    // fixtures plus billing.koi (contexts, value objects, enums, entities, aggregates, invariants,
    // a regex `matches`, computed fields, defaults, List&lt;&gt;) — far more node shapes, nesting
    // depth, and span adjacency than the original single 4-line source exercised.
    public static IEnumerable<object[]> OracleCorpus() =>
        new[] { new object[] { "inline" }, new object[] { "invariant" }, new object[] { "billing" } };

    [Fact]
    public void Parent_uses_reference_identity_not_value_equality()
    {
        // Two value-EQUAL IdentifierExpr("x") with DIFFERENT parents. A value-keyed map would
        // collapse them to one entry; reference identity keeps them distinct.
        var idA = new IdentifierExpr("x");
        var idB = new IdentifierExpr("x");
        idB.ShouldBe(idA);                 // value equality holds...
        idB.ShouldNotBeSameAs(idA);               // ...but they are distinct instances

        var lit0 = new LiteralExpr(LiteralKind.Int, "0");
        var lit9 = new LiteralExpr(LiteralKind.Int, "9");
        var gt = new BinaryExpr(BinaryOp.Gt, idA, lit0);
        var lt = new BinaryExpr(BinaryOp.Lt, idB, lit9);
        var root = new BinaryExpr(BinaryOp.And, gt, lt);

        var graph = new SyntaxGraph(root);

        graph.Parent(idA).ShouldBeSameAs(gt);
        graph.Parent(idB).ShouldBeSameAs(lt);
        graph.Parent(root).ShouldBeNull();
    }

    [Fact]
    public void Ancestors_are_nearest_first_and_AncestorsAndSelf_starts_with_self()
    {
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        // The "amount" identifier inside the spec body.
        var id = NodeWalker.Descendants(model).OfType<IdentifierExpr>().Single(n => n.Name == "amount");

        var ancestors = graph.Ancestors(id).ToList();
        ancestors.ShouldNotContain(id);
        ancestors[^1].ShouldBeSameAs(model);                       // walk terminates at the root

        var withSelf = graph.AncestorsAndSelf(id).ToList();
        withSelf[0].ShouldBeSameAs(id);                            // self first
        withSelf.Skip(1).ToList().ShouldBe(ancestors);      // then the ancestors, in order
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
        spec.ShouldNotBeNull();
        spec!.Name.ShouldBe("Positive");
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

            (ancestor.Span.Offset <= node.Span.Offset).ShouldBeTrue();
            (ancestor.Span.Offset + ancestor.Span.Length >= node.Span.Offset + node.Span.Length).ShouldBeTrue();
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

    [Theory]
    [MemberData(nameof(OracleCorpus))]
    public void FindNode_matches_the_brute_force_scan_for_every_offset(string source)
    {
        var src = SourceFor(source);
        var model = Parse(src);
        var graph = new SyntaxGraph(model);

        for (var offset = 0; offset <= src.Length; offset++)
        {
            graph.FindNode(offset).ShouldBeSameAs(BruteInnermost(model, offset, useNameSpan: false));
        }
    }

    [Theory]
    [MemberData(nameof(OracleCorpus))]
    public void FindNameNode_matches_the_brute_force_scan_for_every_offset(string source)
    {
        var src = SourceFor(source);
        var model = Parse(src);
        var graph = new SyntaxGraph(model);

        for (var offset = 0; offset <= src.Length; offset++)
        {
            graph.FindNameNode(offset).ShouldBeSameAs(BruteInnermost(model, offset, useNameSpan: true));
        }
    }

    [Fact]
    public void FindNode_returns_null_outside_any_positioned_node()
    {
        var graph = new SyntaxGraph(Parse(Src));
        graph.FindNode(int.MaxValue).ShouldBeNull();
        graph.FindNode(-1).ShouldBeNull();
    }

    [Fact]
    public void FindNameNode_lands_on_named_declaration_for_declaration_name_offset()
    {
        // Guard for the NameSpan ⊆ Span invariant: FindNameNode routes top-down descent by
        // each node's FullSpan (Span-derived). If a future node were to set NameSpan while
        // leaving Span.None, the descent would never enter that subtree and FindNameNode
        // would silently miss the name. This test pins the happy path to catch that regression.
        var model = Parse(Src);
        var graph = new SyntaxGraph(model);

        // "Money" first appears as the ValueObjectDecl name in "value Money { amount: Decimal }".
        var offset = Src.IndexOf("Money", StringComparison.Ordinal);
        var node = graph.FindNameNode(offset);

        node.ShouldNotBeNull();
        var voDecl = node.ShouldBeOfType<ValueObjectDecl>();
        voDecl.Name.ShouldBe("Money");
    }
}
