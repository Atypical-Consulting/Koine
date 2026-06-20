using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Thread C of issue #73 — completing the symbol graph: downward navigation
/// (<see cref="TypeSymbol.Members"/> / <see cref="ContextSymbol.Types"/>), parameter interning,
/// member-access selector binding, and the identity-keyed reverse reference index. The graph is OFF
/// the emit path, so Verify/Roslyn meta-tests are blind to it — this suite is the guard.
/// </summary>
public class SymbolGraphTests
{
    private static SemanticModel Build(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model!);
    }

    private static IEnumerable<KoineNode> Descendants(SemanticModel sema) =>
        NodeWalker.Descendants(sema.Model);

    // ----------------------------------------------------------------------
    // C1 — downward navigation + SymbolEqualityComparer.
    // ----------------------------------------------------------------------

    [Fact]
    public void SymbolGraph_TypeSymbol_EnumeratesItsMembers()
    {
        var sema = Build("context Shop { value Money { amount: Decimal  currency: String } }");

        var money = sema.GetDeclaredSymbol(Descendants(sema).OfType<ValueObjectDecl>().Single())
            .ShouldBeOfType<TypeSymbol>();

        money.Members.Select(m => m.Name).ShouldBe(new[] { "amount", "currency" });
        money.Members.ShouldAllBe(m => m is MemberSymbol);
        // The member's upward pointer is the convenience typed view of ContainingSymbol.
        ((MemberSymbol)money.Members[0]).ContainingType.ShouldBeSameAs(money);
    }

    [Fact]
    public void ContextSymbol_ListsItsTypes()
    {
        var sema = Build("context Shop { value Money { amount: Decimal } enum Currency { EUR, USD } }");

        var ctx = sema.GetDeclaredSymbol(Descendants(sema).OfType<ContextNode>().Single())
            .ShouldBeOfType<ContextSymbol>();

        ctx.Types.Select(t => t.Name).ShouldBe(new[] { "Money", "Currency" }, ignoreOrder: true);
        ctx.Types.ShouldAllBe(t => ReferenceEquals(t.ContainingSymbol, ctx));
    }

    [Fact]
    public void SymbolEqualityComparer_Is_Reference_Identity()
    {
        var sema = Build("context Shop { value Money { amount: Decimal } }");
        var money = sema.GetDeclaredSymbol(Descendants(sema).OfType<ValueObjectDecl>().Single())
            .ShouldBeOfType<TypeSymbol>();

        var cmp = SymbolEqualityComparer.Default;
        cmp.Equals(money, money).ShouldBeTrue();
        cmp.Equals(money, ErrorSymbol.Instance).ShouldBeFalse();
        cmp.GetHashCode(money).ShouldBe(cmp.GetHashCode(money));

        // Usable as a dictionary key comparer keyed by interned identity.
        var set = new HashSet<Symbol>(cmp) { money };
        set.Contains(money).ShouldBeTrue();
    }
}
