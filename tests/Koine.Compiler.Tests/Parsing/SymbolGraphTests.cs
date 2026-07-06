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
        return new SemanticModel(model);
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

    // ----------------------------------------------------------------------
    // C2 — interned behavior parameters.
    // ----------------------------------------------------------------------

    private const string CommandSrc = """
        context C {
          entity E identified by EId {
            n: Int
            command setN(v: Int) {
              requires v > 0 "positive"
              n -> v
            }
          }
        }
        """;

    [Fact]
    public void SymbolTable_InternsCommandParameters()
    {
        var sema = Build(CommandSrc);

        Param vParam = Descendants(sema).OfType<Param>().Single(p => p.Name == "v");
        var sym = sema.GetDeclaredSymbol(vParam).ShouldBeOfType<ParameterSymbol>();

        sym.Name.ShouldBe("v");
        sym.Kind.ShouldBe(Ast.SymbolKind.Parameter);
        sym.ContainingType.ShouldNotBeNull();
        sym.ContainingType!.Name.ShouldBe("E");

        // The interned symbol is stable, and the entity's downward Members now include it.
        sema.GetDeclaredSymbol(vParam).ShouldBeSameAs(sym);
        sema.GetDeclaredSymbol(Descendants(sema).OfType<EntityDecl>().Single())
            .ShouldBeOfType<TypeSymbol>()
            .Members.ShouldContain(sym);
    }

    // ----------------------------------------------------------------------
    // C3 — member-access selector binding + parameter references.
    // ----------------------------------------------------------------------

    [Fact]
    public void Binder_BindsMemberAccessSelector()
    {
        const string src = """
            context Sales {
              value Money { amount: Decimal }
              entity Order identified by OrderId {
                total: Money
                invariant total.amount > 0
              }
            }
            """;
        var sema = Build(src);

        // `total.amount` — the selector binds to the interned member of Money, not ErrorSymbol.
        MemberAccessExpr access = Descendants(sema).OfType<MemberAccessExpr>().Single(m => m.MemberName == "amount");
        var sym = sema.GetSymbolInfo(access).ShouldBeOfType<MemberSymbol>();
        sym.Name.ShouldBe("amount");
        sym.OwnerType.ShouldBe("Money");
        // It is the SAME interned symbol as the member's declaration.
        Member amountDecl = Descendants(sema).OfType<Member>().Single(m => m.Name == "amount");
        sema.GetSymbolInfo(access).ShouldBeSameAs(sema.GetDeclaredSymbol(amountDecl));
    }

    [Fact]
    public void MemberOf_BindsAFieldButLeavesAnEnumSelectorUnbound()
    {
        // Exercises SymbolTable.MemberOf's two arms: a field-bearing kind (Money) surfaces its member,
        // while a non-field-bearing kind (the enum Phase) hits the `_ => null` arm — so the selector
        // stays unbound (ErrorSymbol) rather than binding to a fabricated member.
        const string src = """
            context C {
              value Money { amount: Decimal }
              enum Phase { Draft, Active }
              entity Order identified by OrderId {
                total: Money
                phase: Phase
                invariant total.amount > 0
                invariant phase.rank > 0
              }
            }
            """;
        var sema = Build(src);

        MemberAccessExpr amount = Descendants(sema).OfType<MemberAccessExpr>().Single(m => m.MemberName == "amount");
        var member = sema.GetSymbolInfo(amount).ShouldBeOfType<MemberSymbol>();
        member.Name.ShouldBe("amount");
        member.OwnerType.ShouldBe("Money");

        MemberAccessExpr enumSelector = Descendants(sema).OfType<MemberAccessExpr>().Single(m => m.MemberName == "rank");
        sema.GetSymbolInfo(enumSelector).ShouldBeSameAs(ErrorSymbol.Instance);
    }

    [Fact]
    public void Binder_BindsCommandParameterReference()
    {
        var sema = Build(CommandSrc);

        // `v` occurs in `requires v > 0` and `n -> v`; every reference binds to the interned parameter.
        Param vParam = Descendants(sema).OfType<Param>().Single(p => p.Name == "v");
        Symbol declared = sema.GetDeclaredSymbol(vParam).ShouldBeOfType<ParameterSymbol>();

        var vRefs = Descendants(sema).OfType<IdentifierExpr>().Where(i => i.Name == "v").ToList();
        vRefs.Count.ShouldBeGreaterThanOrEqualTo(1);
        foreach (IdentifierExpr r in vRefs)
        {
            sema.GetSymbolInfo(r).ShouldBeSameAs(declared);
        }
    }

    // ----------------------------------------------------------------------
    // C4 — identity-based reverse reference index.
    // ----------------------------------------------------------------------

    [Fact]
    public void FindReferences_AcrossMemberChain()
    {
        // Lines (1-based): 1 `context`, 2 `value Money { amount }`, 4 `total: Money`, 5 `invariant total.amount`.
        const string src = """
            context Sales {
              value Money { amount: Decimal }
              entity Order identified by OrderId {
                total: Money
                invariant total.amount > 0
              }
            }
            """;
        var index = new WorkspaceIndex(new Dictionary<string, string> { ["m.koi"] = src });

        // Cursor on the `amount` field declaration in Money.
        int declOffset = src.IndexOf("amount: Decimal", StringComparison.Ordinal);
        IReadOnlyList<Reference> refs = index.FindReferences("m.koi", "amount", declOffset);

        var lines = refs.Select(r => r.Line).ToHashSet();
        lines.ShouldContain(2);  // the declaration itself
        lines.ShouldContain(5);  // the `total.amount` member-access selector — the case the old code could not reach
    }

    [Fact]
    public void FindReferences_Parameter()
    {
        // Lines: 4 `command setN(v: Int)`, 5 `requires v > 0`, 6 `n -> v`.
        var index = new WorkspaceIndex(new Dictionary<string, string> { ["c.koi"] = CommandSrc });

        int declOffset = CommandSrc.IndexOf("v: Int", StringComparison.Ordinal);
        IReadOnlyList<Reference> refs = index.FindReferences("c.koi", "v", declOffset);

        var lines = refs.Select(r => r.Line).ToHashSet();
        lines.ShouldContain(5);  // `requires v > 0`
        lines.ShouldContain(6);  // `n -> v`
        refs.Count.ShouldBeGreaterThanOrEqualTo(2);
    }
}
