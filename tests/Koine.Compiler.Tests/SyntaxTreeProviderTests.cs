using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for the target-agnostic <see cref="SyntaxTreeProvider"/>: it projects the parsed
/// <see cref="KoineModel"/> (the syntax root) into a serializable <see cref="SyntaxTreeNode"/> DTO
/// tree by recursing the reflection/source-generated child walk — grammar-agnostic, carrying no
/// C#/target concept (only the pure <see cref="SourceSpan"/> position data). Proven over both a
/// clean parse and an error-tolerant (recovered) parse.
/// </summary>
public class SyntaxTreeProviderTests
{
    private const string CleanSource =
        "context Sample {\n" +
        "  value Money {\n" +
        "    amount: Decimal\n" +
        "    invariant amount >= 0   \"a monetary amount cannot be negative\"\n" +
        "  }\n" +
        "  value Email {\n" +
        "    raw: String\n" +
        "  }\n" +
        "}\n";

    // The same representative broken file the resilience suite uses: a typo (`whre`) inside `Money`
    // that ANTLR recovers from, plus a fully-valid sibling `Email`.
    private const string BrokenSource =
        "context Billing {\n" +
        "  value Money { amount: Decimal whre amount >= 0 }\n" +
        "  value Email { address: String }\n" +
        "}\n";

    [Fact]
    public void Build_projects_the_model_root_with_a_nested_value_object_in_child_order()
    {
        var (model, _) = new KoineCompiler().Parse(CleanSource);
        model.ShouldNotBeNull();

        SyntaxTreeNode root = SyntaxTreeProvider.Build(model!, CleanSource);

        // Root is the syntax root: the KoineModel itself, a composite (so no Leaf), clean of errors.
        root.Kind.ShouldBe("KoineModel");
        root.IsMissing.ShouldBeFalse();
        root.IsError.ShouldBeFalse();
        root.Leaf.ShouldBeNull();

        // The model's only child is the bounded context.
        SyntaxTreeNode context = root.Children.ShouldHaveSingleItem();
        context.Kind.ShouldBe("ContextNode");

        // The context's children are its two value objects, in source order (child-order contract).
        context.Children.Select(c => c.Kind).ShouldBe(new[] { "ValueObjectDecl", "ValueObjectDecl" });
        context.Children.Select(c => c.Name).ShouldBe(new[] { "Money", "Email" });

        // The nested `Money` value object: Name is read from the NameSpan slice of the source, its
        // Span is a real (non-empty) range pointing at the declaration, and its children are the
        // field then the invariant — in that order.
        SyntaxTreeNode money = context.Children[0];
        money.Name.ShouldBe("Money");
        money.Span.IsNone.ShouldBeFalse();
        CleanSource.Substring(money.Span.Offset, money.Span.Length).ShouldContain("value Money");
        money.Children.Select(c => c.Kind).ShouldBe(new[] { "Member", "Invariant" });
        money.Children[0].Name.ShouldBe("amount");

        // The Leaf contract holds throughout: a node has a (non-null) Leaf exactly when it is childless.
        foreach (SyntaxTreeNode n in Flatten(root))
        {
            (n.Leaf is not null).ShouldBe(n.Children.Count == 0);
        }
    }

    [Fact]
    public void Build_over_an_error_tolerant_parse_surfaces_an_error_node()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(BrokenSource);
        model.ShouldNotBeNull();
        diagnostics.ShouldNotBeEmpty();   // the typo produced syntax diagnostics (recovered parse)

        SyntaxTreeNode root = SyntaxTreeProvider.Build(model!, BrokenSource);

        // The provider runs over the error-tolerant tree, so a recovered ErrorNode surfaces as a
        // node flagged IsError (the "red layer" is indexed for free by the reflection child walk).
        SyntaxTreeNode error = Flatten(root).First(n => n.IsError);
        error.Kind.ShouldBe("ErrorNode");

        // The good sibling still recovers intact alongside the error.
        Flatten(root).ShouldContain(n => n.Kind == "ValueObjectDecl" && n.Name == "Email");
    }

    private static IEnumerable<SyntaxTreeNode> Flatten(SyntaxTreeNode node)
    {
        yield return node;
        foreach (SyntaxTreeNode child in node.Children)
        {
            foreach (SyntaxTreeNode d in Flatten(child))
            {
                yield return d;
            }
        }
    }
}
