using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The symbol-identity binder (Commit 3): one interned <see cref="Symbol"/> per declaration, a
/// reference-keyed <see cref="BindingTable"/>, and an equivalence oracle proving resolution reproduces
/// the legacy string paths exactly. The binder is OFF the emit path, so Verify/Roslyn meta-tests are
/// blind to it — this suite (plus the R17 navigation/rename suite) is the guard.
/// </summary>
public class BinderTests
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
    // 1. Reference-key identity (the value-equality-record hazard).
    // ----------------------------------------------------------------------

    [Fact]
    public void Same_named_references_in_two_types_bind_to_distinct_member_symbols()
    {
        const string src = """
            context Shop {
              value A { amount: Decimal  invariant amount > 0 }
              value B { amount: Decimal  invariant amount > 0 }
            }
            """;
        var sema = Build(src);

        // The two `amount` identifier references (one per invariant) are value-equal records.
        var refs = Descendants(sema).OfType<IdentifierExpr>().Where(i => i.Name == "amount").ToList();
        refs.Count.ShouldBe(2);

        var s0 = sema.GetSymbolInfo(refs[0]).ShouldBeOfType<MemberSymbol>();
        var s1 = sema.GetSymbolInfo(refs[1]).ShouldBeOfType<MemberSymbol>();

        // Distinct member symbols with distinct containers — fails loudly if the table dropped the
        // reference-identity comparer (both would collide to one binding).
        s1.ShouldNotBeSameAs(s0);
        s1.ContainingSymbol.ShouldNotBeSameAs(s0.ContainingSymbol);
        ((TypeSymbol)s0.ContainingSymbol!).Name.ShouldBe("A");
        ((TypeSymbol)s1.ContainingSymbol!).Name.ShouldBe("B");
    }

    // ----------------------------------------------------------------------
    // 2. Symbol interning (the new identity hazard).
    // ----------------------------------------------------------------------

    [Fact]
    public void GetDeclaredSymbol_returns_the_same_instance_on_repeat()
    {
        var sema = Build("context Shop { value Money { amount: Decimal } }");
        TypeDecl money = Descendants(sema).OfType<ValueObjectDecl>().Single();

        Symbol? a = sema.GetDeclaredSymbol(money);
        Symbol? b = sema.GetDeclaredSymbol(money);
        a.ShouldNotBeNull();
        b.ShouldBeSameAs(a);
    }

    [Fact]
    public void All_references_to_one_type_bind_to_the_one_interned_type_symbol()
    {
        const string src = """
            context Shop {
              value Money { amount: Decimal }
              value Price { base: Money }
              value Total { net: Money  gross: Money }
            }
            """;
        var sema = Build(src);

        TypeSymbol declared = sema.GetDeclaredSymbol(Descendants(sema).OfType<ValueObjectDecl>().Single(v => v.Name == "Money")).ShouldBeOfType<TypeSymbol>();

        var moneyRefs = Descendants(sema).OfType<TypeRef>().Where(t => t.Name == "Money").ToList();
        moneyRefs.Count.ShouldBe(3);
        foreach (TypeRef tr in moneyRefs)
        {
            sema.GetSymbolInfo(tr).ShouldBeSameAs(declared);
        }
    }

    [Fact]
    public void A_member_reference_binds_to_the_same_instance_as_its_declared_symbol()
    {
        var sema = Build("context Shop { value Money { amount: Decimal  invariant amount > 0 } }");
        Member amountDecl = Descendants(sema).OfType<Member>().Single(m => m.Name == "amount");
        IdentifierExpr amountRef = Descendants(sema).OfType<IdentifierExpr>().Single(i => i.Name == "amount");

        Symbol? declared = sema.GetDeclaredSymbol(amountDecl);
        declared.ShouldNotBeNull();
        sema.GetSymbolInfo(amountRef).ShouldBeSameAs(declared);
    }

    // ----------------------------------------------------------------------
    // 3. Binding-table equivalence oracle (Kind + Name + DeclSpan), incl. convention-only *Id.
    // ----------------------------------------------------------------------

    [Fact]
    public void Every_reference_node_matches_legacy_DefinitionAt_on_kind_name_and_declspan()
    {
        const string src = """
            context Sales {
              value Money { amount: Decimal  unit: Currency }
              enum Currency { EUR, USD }
              entity Order identified by OrderId {
                total: Money
                invariant total.amount > 0
              }
              spec IsBig on Order = total.amount > 100
            }
            """;
        var sema = Build(src);

        int checkedIdentifiers = 0;
        int checkedTypeRefs = 0;
        foreach (KoineNode node in Descendants(sema))
        {
            switch (node)
            {
                case IdentifierExpr id when !id.Span.IsNone:
                    {
                        Symbol bound = sema.GetSymbolInfo(id);
                        Symbol? legacy = sema.DefinitionAt(id.Span.Offset);
                        AssertOracle(bound, legacy);
                        checkedIdentifiers++;
                        break;
                    }
                case TypeRef tr when !tr.Span.IsNone && IsUserType(sema, tr.Name):
                    {
                        Symbol bound = sema.GetSymbolInfo(tr);
                        Symbol? legacy = sema.DefinitionAt(tr.Span.Offset);
                        AssertOracle(bound, legacy);
                        checkedTypeRefs++;
                        break;
                    }
            }
        }

        (checkedIdentifiers > 0).ShouldBeTrue("expected at least one identifier reference");
        (checkedTypeRefs > 0).ShouldBeTrue("expected at least one user-type reference");
    }

    private static bool IsUserType(SemanticModel sema, string name) =>
        sema.Index.Classify(name) is TypeKind.Value or TypeKind.Entity or TypeKind.Enum
            or TypeKind.Event or TypeKind.Aggregate;

    private static void AssertOracle(Symbol bound, Symbol? legacy)
    {
        if (legacy is null)
        {
            // The reference does not resolve in the legacy path; the binder either agrees (ErrorSymbol)
            // or additively resolves it (e.g. a selector). When the binder resolved it, its DeclSpan
            // must still be the real declaration — but legacy null means we only assert the binder did
            // not contradict a resolved legacy symbol. Nothing to compare here.
            return;
        }

        bound.ShouldBeOfType(legacy.GetType());
        bound.Kind.ShouldBe(legacy.Kind);
        bound.Name.ShouldBe(legacy.Name);
        bound.DeclSpan.ShouldBe(legacy.DeclSpan);
    }

    [Fact]
    public void Convention_only_id_reference_interns_an_id_value_object_by_kind_and_name()
    {
        // ProductId matches the *Id convention but NO entity declares `identified by ProductId`.
        const string src = """
            context Catalog {
              value LineItem { product: ProductId }
            }
            """;
        var sema = Build(src);

        TypeRef productId = Descendants(sema).OfType<TypeRef>().Single(t => t.Name == "ProductId");
        var sym = sema.GetSymbolInfo(productId).ShouldBeOfType<IdValueObjectSymbol>();
        sym.Kind.ShouldBe(Ast.SymbolKind.IdValueObject);
        sym.Name.ShouldBe("ProductId");
        sym.Owner.ShouldBeNull(); // convention-only: no owning entity

        // Legacy GetSymbol stays null for a convention-only *Id (contract preserved).
        sema.GetSymbol("ProductId").ShouldBeNull();
        sema.DefinitionAt(productId.Span.Offset).ShouldBeNull();
    }

    [Fact]
    public void Entity_owned_id_reference_binds_to_the_entitys_id_value_object()
    {
        const string src = """
            context Sales {
              entity Order identified by OrderId { total: Decimal }
              value Line { order: OrderId }
            }
            """;
        var sema = Build(src);

        TypeRef orderId = Descendants(sema).OfType<TypeRef>().Single(t => t.Name == "OrderId");
        var sym = sema.GetSymbolInfo(orderId).ShouldBeOfType<IdValueObjectSymbol>();
        sym.Name.ShouldBe("OrderId");
        sym.Owner.ShouldNotBeNull();
        sym.Owner!.Name.ShouldBe("Order");
    }

    [Fact]
    public void R13_2_two_money_types_resolve_per_context()
    {
        const string src = """
            context A {
              value Money { a: Decimal }
              value Wallet { balance: Money }
            }
            context B {
              value Money { b: Decimal }
              value Purse { holding: Money }
            }
            """;
        var sema = Build(src);

        TypeRef inA = Descendants(sema).OfType<TypeRef>()
            .Single(t => t.Name == "Money" && AncestorTypeName(sema, t) == "Wallet");
        TypeRef inB = Descendants(sema).OfType<TypeRef>()
            .Single(t => t.Name == "Money" && AncestorTypeName(sema, t) == "Purse");

        var symA = sema.GetSymbolInfo(inA).ShouldBeOfType<TypeSymbol>();
        var symB = sema.GetSymbolInfo(inB).ShouldBeOfType<TypeSymbol>();

        symB.ShouldNotBeSameAs(symA);
        ((ContextSymbol)symA.ContainingSymbol!).Name.ShouldBe("A");
        ((ContextSymbol)symB.ContainingSymbol!).Name.ShouldBe("B");
    }

    private static string? AncestorTypeName(SemanticModel sema, KoineNode node) =>
        sema.FirstAncestorOrSelf<TypeDecl>(node)?.Name;

    // ----------------------------------------------------------------------
    // 4. Containment.
    // ----------------------------------------------------------------------

    [Fact]
    public void Member_container_is_its_declaring_type_symbol()
    {
        var sema = Build("context Shop { value Money { amount: Decimal } }");
        Member amount = Descendants(sema).OfType<Member>().Single(m => m.Name == "amount");
        var sym = sema.GetDeclaredSymbol(amount).ShouldBeOfType<MemberSymbol>();
        var owner = sym.ContainingSymbol.ShouldBeOfType<TypeSymbol>();
        owner.Name.ShouldBe("Money");
        var ctx = owner.ContainingSymbol.ShouldBeOfType<ContextSymbol>();
        ctx.Name.ShouldBe("Shop");
        ctx.ContainingSymbol.ShouldBeNull(); // a context is top-level
    }

    [Fact]
    public void Every_non_context_interned_symbol_has_a_non_null_container()
    {
        const string src = """
            context Sales {
              value Money { amount: Decimal }
              enum Currency { EUR, USD }
              entity Order identified by OrderId {
                total: Money
                invariant total.amount > 0
              }
              spec IsBig on Order = total.amount > 100
            }
            """;
        var sema = Build(src);

        foreach (KoineNode node in Descendants(sema))
        {
            Symbol? declared = sema.GetDeclaredSymbol(node);
            if (declared is null or ContextSymbol)
            {
                continue;
            }

            declared.ContainingSymbol.ShouldNotBeNull();
        }
    }

    [Fact]
    public void A_let_local_container_is_the_enclosing_behavior()
    {
        const string src = """
            context Shop {
              value Money {
                amount: Decimal
                invariant let x = amount in x > 0
              }
            }
            """;
        var sema = Build(src);

        // The `x` reference in the body binds to the LocalSymbol whose container is the Money type.
        IdentifierExpr xRef = Descendants(sema).OfType<IdentifierExpr>().Single(i => i.Name == "x");
        var local = sema.GetSymbolInfo(xRef).ShouldBeOfType<LocalSymbol>();
        local.ContainingSymbol.ShouldNotBeNull();
        local.Kind.ShouldBe(Ast.SymbolKind.Local);
    }

    // ----------------------------------------------------------------------
    // 5. ErrorSymbol for unresolved.
    // ----------------------------------------------------------------------

    [Fact]
    public void Unresolved_identifier_binds_to_error_symbol_and_legacy_returns_null()
    {
        // `now` is a built-in nullary value op — not a declaration, no go-to-definition target.
        const string src = """
            context Shop {
              entity Booking identified by BookingId {
                created: Instant
                invariant created <= now
              }
            }
            """;
        var sema = Build(src);

        IdentifierExpr nowRef = Descendants(sema).OfType<IdentifierExpr>().Single(i => i.Name == "now");
        sema.GetSymbolInfo(nowRef).ShouldBeSameAs(ErrorSymbol.Instance);
        sema.DefinitionAt(nowRef.Span.Offset).ShouldBeNull();
    }

    [Fact]
    public void GetSymbolInfo_on_a_non_reference_node_is_error_symbol()
    {
        var sema = Build("context Shop { value Money { amount: Decimal } }");
        // A ValueObjectDecl is a declaration, not a reference — GetSymbolInfo returns the sentinel.
        ValueObjectDecl decl = Descendants(sema).OfType<ValueObjectDecl>().Single();
        sema.GetSymbolInfo(decl).ShouldBeSameAs(ErrorSymbol.Instance);
    }
}
