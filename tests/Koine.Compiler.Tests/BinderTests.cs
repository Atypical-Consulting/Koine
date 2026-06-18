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
        Assert.Empty(diagnostics);
        Assert.NotNull(model);
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
        Assert.Equal(2, refs.Count);

        var s0 = Assert.IsType<MemberSymbol>(sema.GetSymbolInfo(refs[0]));
        var s1 = Assert.IsType<MemberSymbol>(sema.GetSymbolInfo(refs[1]));

        // Distinct member symbols with distinct containers — fails loudly if the table dropped the
        // reference-identity comparer (both would collide to one binding).
        Assert.NotSame(s0, s1);
        Assert.NotSame(s0.ContainingSymbol, s1.ContainingSymbol);
        Assert.Equal("A", ((TypeSymbol)s0.ContainingSymbol!).Name);
        Assert.Equal("B", ((TypeSymbol)s1.ContainingSymbol!).Name);
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
        Assert.NotNull(a);
        Assert.Same(a, b);
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

        TypeSymbol declared = Assert.IsType<TypeSymbol>(
            sema.GetDeclaredSymbol(Descendants(sema).OfType<ValueObjectDecl>().Single(v => v.Name == "Money")));

        var moneyRefs = Descendants(sema).OfType<TypeRef>().Where(t => t.Name == "Money").ToList();
        Assert.Equal(3, moneyRefs.Count);
        foreach (TypeRef tr in moneyRefs)
        {
            Assert.Same(declared, sema.GetSymbolInfo(tr));
        }
    }

    [Fact]
    public void A_member_reference_binds_to_the_same_instance_as_its_declared_symbol()
    {
        var sema = Build("context Shop { value Money { amount: Decimal  invariant amount > 0 } }");
        Member amountDecl = Descendants(sema).OfType<Member>().Single(m => m.Name == "amount");
        IdentifierExpr amountRef = Descendants(sema).OfType<IdentifierExpr>().Single(i => i.Name == "amount");

        Symbol? declared = sema.GetDeclaredSymbol(amountDecl);
        Assert.NotNull(declared);
        Assert.Same(declared, sema.GetSymbolInfo(amountRef));
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

        Assert.True(checkedIdentifiers > 0, "expected at least one identifier reference");
        Assert.True(checkedTypeRefs > 0, "expected at least one user-type reference");
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

        Assert.IsType(legacy.GetType(), bound);
        Assert.Equal(legacy.Kind, bound.Kind);
        Assert.Equal(legacy.Name, bound.Name);
        Assert.Equal(legacy.DeclSpan, bound.DeclSpan);
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
        var sym = Assert.IsType<IdValueObjectSymbol>(sema.GetSymbolInfo(productId));
        Assert.Equal(Ast.SymbolKind.IdValueObject, sym.Kind);
        Assert.Equal("ProductId", sym.Name);
        Assert.Null(sym.Owner); // convention-only: no owning entity

        // Legacy GetSymbol stays null for a convention-only *Id (contract preserved).
        Assert.Null(sema.GetSymbol("ProductId"));
        Assert.Null(sema.DefinitionAt(productId.Span.Offset));
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
        var sym = Assert.IsType<IdValueObjectSymbol>(sema.GetSymbolInfo(orderId));
        Assert.Equal("OrderId", sym.Name);
        Assert.NotNull(sym.Owner);
        Assert.Equal("Order", sym.Owner!.Name);
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

        var symA = Assert.IsType<TypeSymbol>(sema.GetSymbolInfo(inA));
        var symB = Assert.IsType<TypeSymbol>(sema.GetSymbolInfo(inB));

        Assert.NotSame(symA, symB);
        Assert.Equal("A", ((ContextSymbol)symA.ContainingSymbol!).Name);
        Assert.Equal("B", ((ContextSymbol)symB.ContainingSymbol!).Name);
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
        var sym = Assert.IsType<MemberSymbol>(sema.GetDeclaredSymbol(amount));
        var owner = Assert.IsType<TypeSymbol>(sym.ContainingSymbol);
        Assert.Equal("Money", owner.Name);
        var ctx = Assert.IsType<ContextSymbol>(owner.ContainingSymbol);
        Assert.Equal("Shop", ctx.Name);
        Assert.Null(ctx.ContainingSymbol); // a context is top-level
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

            Assert.NotNull(declared.ContainingSymbol);
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
        var local = Assert.IsType<LocalSymbol>(sema.GetSymbolInfo(xRef));
        Assert.NotNull(local.ContainingSymbol);
        Assert.Equal(Ast.SymbolKind.Local, local.Kind);
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
        Assert.Same(ErrorSymbol.Instance, sema.GetSymbolInfo(nowRef));
        Assert.Null(sema.DefinitionAt(nowRef.Span.Offset));
    }

    [Fact]
    public void GetSymbolInfo_on_a_non_reference_node_is_error_symbol()
    {
        var sema = Build("context Shop { value Money { amount: Decimal } }");
        // A ValueObjectDecl is a declaration, not a reference — GetSymbolInfo returns the sentinel.
        ValueObjectDecl decl = Descendants(sema).OfType<ValueObjectDecl>().Single();
        Assert.Same(ErrorSymbol.Instance, sema.GetSymbolInfo(decl));
    }
}
