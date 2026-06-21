using Antlr4.Runtime;
using Antlr4.Runtime.Atn;
using Koine.Compiler.Ast;
using Koine.Compiler.Grammar;
using Koine.Compiler.Parsing;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Oracle test for the production source-reconstruction child walk. <see cref="ReconstructionWalker"/>
/// is backed by the source-GENERATED <c>ChildNodes.Of</c>; the reflection-based
/// <see cref="NodeWalker.ReconstructionChildren"/> is the independent oracle. The two must agree
/// element-for-element (reference identity, in order) for every node — so the formatter /
/// <see cref="KoineNode.ToFullString"/> reconstruction path can drop reflection without changing a
/// single byte of emitted source. Mirrors the existing generated-vs-NodeWalker oracle in
/// <see cref="SyntaxVisitorTests"/>.
/// </summary>
public class ReconstructionChildrenTests
{
    // A slot-shape-complete well-formed model: required/optional/list children, enums, computed
    // members, a spec — the full variety of composite nodes the reconstruction walk recurses into.
    private const string WellFormedSrc =
        "context Shop {\n" +
        "  value Money { amount: Decimal\n" +
        "    invariant amount > 0 \"must be positive\"\n" +
        "  }\n" +
        "  enum Currency { EUR(\"€\", 2), USD(\"$\", 2) }\n" +
        "  value OrderLine {\n" +
        "    unitPrice: Decimal\n" +
        "    quantity: Int\n" +
        "    subtotal: Decimal = unitPrice * quantity\n" +
        "  }\n" +
        "  spec Positive on Money = amount > 0\n" +
        "}\n";

    // One typo'd token with a fully-valid sibling: ANTLR recovery surfaces ErrorNode markers in the
    // tree (e.g. ContextNode.Errors), exercising the ErrorNode-exclusion branch on a real model.
    private const string TypoSrc =
        "context Billing {\n" +
        "  value Money { amount: Decimal whre amount >= 0 }\n" +
        "  value Email { address: String }\n" +
        "}\n";

    private static KoineModel ParseClean(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return model;
    }

    /// <summary>Replicates the LL + DefaultErrorStrategy recovery parse so the tree carries ErrorNodes.</summary>
    private static KoineModel ParseRecovered(string src, string file = "test.koi")
    {
        var input = new AntlrInputStream(src);
        var lexer = new KoineLexer(input);
        var tokens = new CommonTokenStream(lexer);
        var parser = new KoineParser(tokens);
        parser.ErrorHandler = new DefaultErrorStrategy();
        parser.Interpreter.PredictionMode = PredictionMode.LL;
        return new KoineModelBuilderVisitor(tokens, file).BuildModel(parser.program());
    }

    public static IEnumerable<object[]> Models() =>
        new[]
        {
            new object[] { ParseClean(WellFormedSrc) },
            new object[] { ParseClean(TestSupport.BillingFixture) },
            new object[] { ParseRecovered(TypoSrc) },
        };

    [Theory]
    [MemberData(nameof(Models))]
    public void Production_reconstruction_children_match_the_reflection_oracle(KoineModel model)
    {
        foreach (KoineNode node in NodeWalker.Descendants(model))
        {
            List<KoineNode> oracle = NodeWalker.ReconstructionChildren(node).ToList();
            List<KoineNode> generated = ReconstructionWalker.Children(node).ToList();

            generated.Count.ShouldBe(oracle.Count,
                $"reconstruction child count mismatch for {node.GetType().Name}");
            for (int i = 0; i < oracle.Count; i++)
            {
                ReferenceEquals(generated[i], oracle[i]).ShouldBeTrue(
                    $"reconstruction child {i} of {node.GetType().Name} differs from the reflection oracle");
            }
        }
    }

    [Fact]
    public void Reconstruction_excludes_error_markers_on_a_recovered_tree()
    {
        KoineModel model = ParseRecovered(TypoSrc);

        // Precondition: the recovered tree really does carry ErrorNode markers somewhere.
        NodeWalker.Descendants(model).OfType<ErrorNode>().ShouldNotBeEmpty();

        // No node's reconstruction children ever include an ErrorNode (they are a side-channel).
        foreach (KoineNode node in NodeWalker.Descendants(model))
        {
            ReconstructionWalker.Children(node).ShouldNotContain(c => c is ErrorNode);
        }
    }
}
