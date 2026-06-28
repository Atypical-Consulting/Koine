using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The precise position→node map (#4, Phase 4): <see cref="SemanticModel.NodeAt"/> returns the
/// innermost node whose span contains a 0-based offset, and <see cref="SemanticModel.DefinitionAt"/>
/// resolves the name-bearing node there through the Symbol layer — including spec bodies, which
/// had no navigation target before.
/// </summary>
public class NodeAtNavigationTests
{
    private static SemanticModel Build(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    private const string Src =
        "context Shop {\n" +
        "  value Money { amount: Decimal }\n" +
        "  spec Positive on Money = amount > 0\n" +
        "}\n";

    [Fact]
    public void NodeAt_returns_the_innermost_node_containing_the_offset()
    {
        var sema = Build(Src);
        // Offset of "amount" inside the spec body.
        var offset = Src.IndexOf("amount > 0", StringComparison.Ordinal);
        var node = sema.NodeAt(offset);
        var id = node.ShouldBeOfType<IdentifierExpr>();
        id.Name.ShouldBe("amount");
    }

    [Fact]
    public void NodeAt_returns_null_outside_any_node()
    {
        var sema = Build(Src);
        sema.NodeAt(int.MaxValue).ShouldBeNull();
    }

    [Fact]
    public void DefinitionAt_inside_a_spec_body_resolves_to_the_field()
    {
        var sema = Build(Src);
        var offset = Src.IndexOf("amount > 0", StringComparison.Ordinal);
        var sym = sema.DefinitionAt(offset).ShouldBeOfType<MemberSymbol>();
        sym.Name.ShouldBe("amount");
        sym.OwnerType.ShouldBe("Money");
        // Lands on the field's NAME (line 2, 1-based).
        sym.DeclSpan.Line.ShouldBe(2);
    }

    [Fact]
    public void DefinitionAt_inside_a_let_binding_value_resolves_to_the_field()
    {
        // The reference lives inside a `let` binding's value; the walk must descend into
        // LetBinding (a KoineNode) for the field to be navigable.
        var src =
            "context Shop {\n" +
            "  value Money { amount: Decimal }\n" +
            "  spec Positive on Money = let half = amount / 2 in half > 0\n" +
            "}\n";
        var sema = Build(src);
        var off = src.IndexOf("amount / 2", StringComparison.Ordinal);
        var sym = sema.DefinitionAt(off).ShouldBeOfType<MemberSymbol>();
        sym.Name.ShouldBe("amount");
        sym.OwnerType.ShouldBe("Money");
    }

    [Fact]
    public void DefinitionAt_on_a_field_type_reference_resolves_to_the_type()
    {
        var src =
            "context C {\n" +
            "  value Money { amount: Decimal }\n" +
            "  value Line { price: Money }\n" +
            "}\n";
        var sema = Build(src);
        var off = src.IndexOf("price: Money", StringComparison.Ordinal) + "price: ".Length;
        var sym = sema.DefinitionAt(off).ShouldBeOfType<TypeSymbol>();
        sym.Name.ShouldBe("Money");
    }
}
