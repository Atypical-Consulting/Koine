using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests for the context-map-<b>permit</b> step of
/// <see cref="ModelIndex.TryGetDeclIn(string, string, out TypeDecl)"/> (#1853).
/// </summary>
/// <remarks>
/// <para><c>TryGetDeclIn</c> is the one seam every context-aware caller — the validators, all five
/// code emitters, <c>Classify</c>, <c>TryGetDecl</c>, <c>TryGetMemberType</c> — resolves a type name
/// through. It used to answer only for a <b>local</b> declaration or an <b>unambiguous import</b>, so
/// a type made visible purely by the context map (R14.1: <c>conformist</c>, <c>open-host</c>,
/// <c>published-language</c>, <c>partnership</c>, <c>shared-kernel</c>) with no <c>import</c> line
/// fell through to each caller's flat <c>_byName</c> fallback — the last-declaration-wins table whose
/// answer depends on <b>source order</b>.</para>
/// <para>That is the shared root cause under the per-construct patches #1632, #1711/#1715,
/// #1739/#1797, #1796/#1816, #1834/#1844 and #1849/#1851: each fixed one construct's own resolution
/// while the permit path stayed flat for all of them. Every fixture here therefore ships in
/// <b>both</b> source orders — a fixture that passes in only one order is proving source-order luck,
/// not resolution.</para>
/// </remarks>
public class ModelIndexPermitResolutionTests
{
    private static ModelIndex IndexOf(string source)
    {
        CompileResult result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return new SemanticModel(result.Model!).Index;
    }

    /// <summary>The field name that identifies whose <c>Shipped</c> a resolution actually returned.</summary>
    private static string SoleFieldOf(TypeDecl decl) => ((EventDecl)decl).Members.Select(m => m.Name).First();

    // ---- 1. The permit path itself -------------------------------------------

    /// <summary>
    /// Two contexts declare <c>Shipped</c> with different payloads; a third, <c>Ordering</c>, declares
    /// neither and imports nothing. The map makes exactly one of them visible to it. <c>Sales</c> is
    /// declared FIRST so that <c>Warehouse</c> — the wrong answer — is the one that wins the flat
    /// last-write table, making this the order-sensitive direction.
    /// </summary>
    private const string SalesFirstConformist = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        context Ordering {
          value Note { text: String }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    /// <summary>The identical model with <c>Warehouse</c> declared first — the other source order.</summary>
    private const string WarehouseFirstConformist = """
        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          value Note { text: String }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void A_conformist_permit_visible_type_resolves_to_the_permitting_owner(bool warehouseFirst)
    {
        var index = IndexOf(warehouseFirst ? WarehouseFirstConformist : SalesFirstConformist);

        // `conformist` is one of R14.1's permit kinds, so `Ordering` may reference `Sales.Shipped`
        // without an `import`. Before #1853 this returned false in BOTH orders and every caller fell
        // back to the flat table — which answers Warehouse's payload in one order and Sales's in the
        // other, i.e. the same model was legal or not depending on how the file was laid out.
        index.TryGetDeclIn("Ordering", "Shipped", out TypeDecl decl).ShouldBeTrue();
        SoleFieldOf(decl).ShouldBe("orderId");
    }

    [Theory]
    [InlineData("open-host")]
    [InlineData("published-language")]
    [InlineData("conformist")]
    public void Every_directed_permit_kind_resolves_the_upstream_declaration(string kind)
    {
        var index = IndexOf(SalesFirstConformist.Replace(": conformist", ": " + kind, StringComparison.Ordinal));

        index.TryGetDeclIn("Ordering", "Shipped", out TypeDecl decl).ShouldBeTrue();
        SoleFieldOf(decl).ShouldBe("orderId");
    }

    // ---- 2. Ambiguity resolves to NO answer, never an arbitrary winner --------

    /// <summary>
    /// Both declaring contexts are permitted to <c>Ordering</c>. There is no principled winner, so
    /// resolution must yield nothing rather than pick one — picking would re-introduce exactly the
    /// source-order dependence this change removes, one level up.
    /// </summary>
    private const string TwoPermittedOwners = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        context Ordering {
          value Note { text: String }
        }

        contextmap {
          Sales -> Ordering : conformist
          Warehouse -> Ordering : open-host
        }
        """;

    [Fact]
    public void Two_permitted_owners_resolve_to_nothing()
    {
        var index = IndexOf(TwoPermittedOwners);

        index.TryGetDeclIn("Ordering", "Shipped", out _).ShouldBeFalse();
    }

    // ---- 3. Negatives: a non-permitting relation still resolves nothing -------

    [Theory]
    [InlineData("anti-corruption-layer")]
    [InlineData("customer-supplier")]
    public void A_non_permitting_relation_kind_does_not_make_a_type_visible(string kind)
    {
        // R14.1 lists the permit kinds exhaustively; `anti-corruption-layer` and `customer-supplier`
        // are deliberately NOT among them (an ACL exists precisely so the downstream does NOT speak
        // the upstream's language). Widening `TryGetDeclIn` must not quietly widen visibility.
        var index = IndexOf(SalesFirstConformist.Replace(": conformist", ": " + kind, StringComparison.Ordinal));

        index.TryGetDeclIn("Ordering", "Shipped", out _).ShouldBeFalse();
    }

    [Fact]
    public void An_unrelated_context_resolves_nothing()
    {
        // `Warehouse` has no relation to `Sales` at all, so `Sales.Shipped` stays invisible to it even
        // though a permit exists elsewhere in the same map.
        var index = IndexOf(SalesFirstConformist);

        index.TryGetDeclIn("Warehouse", "Note", out _).ShouldBeFalse();
    }

    /// <summary>
    /// <c>Ordering</c> declares its own <c>Shipped</c> AND is permitted to see <c>Sales</c>'s. The
    /// local declaration wins: the permit step is the last rung of the ladder, below local and import.
    /// </summary>
    private const string LocalShadowsPermit = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          event Shipped { localId: String }
        }

        contextmap {
          Sales -> Ordering : conformist
        }
        """;

    [Fact]
    public void A_local_declaration_shadows_a_permit_visible_one()
    {
        var index = IndexOf(LocalShadowsPermit);

        index.TryGetDeclIn("Ordering", "Shipped", out TypeDecl decl).ShouldBeTrue();
        SoleFieldOf(decl).ShouldBe("localId");
    }

    /// <summary>
    /// An <c>import</c> naming one owner while the map permits another: the import is the modeller's
    /// explicit statement of intent, so it outranks the permit.
    /// </summary>
    private const string ImportOutranksPermit = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Warehouse {
          event Shipped {
            packageId: String
            carrier: String
          }
        }

        context Ordering {
          import Warehouse.{ Shipped }

          value Note { text: String }
        }

        contextmap {
          Sales -> Ordering : conformist
          Warehouse -> Ordering : conformist
        }
        """;

    [Fact]
    public void An_unambiguous_import_outranks_a_permit()
    {
        var index = IndexOf(ImportOutranksPermit);

        // Both owners are permitted — ambiguous on the permit rung alone — but the explicit import
        // pins Warehouse, and it is consulted first.
        index.TryGetDeclIn("Ordering", "Shipped", out TypeDecl decl).ShouldBeTrue();
        SoleFieldOf(decl).ShouldBe("packageId");
    }

    // ---- 4. Bidirectional permits resolve from either side --------------------

    /// <summary>
    /// <c>partnership</c> is declared with <c>&lt;-&gt;</c>, so the permit runs both ways: each side
    /// may reference the other's types without an import.
    /// </summary>
    private const string BidirectionalPartnership = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          value Note { text: String }
        }

        contextmap {
          Sales <-> Ordering : partnership
        }
        """;

    [Fact]
    public void A_partnership_permit_resolves_from_either_side()
    {
        var index = IndexOf(BidirectionalPartnership);

        index.TryGetDeclIn("Ordering", "Shipped", out TypeDecl fromDownstream).ShouldBeTrue();
        SoleFieldOf(fromDownstream).ShouldBe("orderId");

        // ...and back the other way: `Sales` sees `Ordering.Note`.
        index.TryGetDeclIn("Sales", "Note", out TypeDecl fromUpstream).ShouldBeTrue();
        ((ValueObjectDecl)fromUpstream).Members.Select(m => m.Name).ShouldContain("text");
    }

    /// <summary>A <c>shared-kernel</c> relation, likewise bidirectional.</summary>
    private const string BidirectionalSharedKernel = """
        context Sales {
          event Shipped { orderId: String }
        }

        context Ordering {
          value Note { text: String }
        }

        contextmap {
          Sales <-> Ordering : shared-kernel
        }
        """;

    [Fact]
    public void A_shared_kernel_permit_resolves_from_either_side()
    {
        var index = IndexOf(BidirectionalSharedKernel);

        index.TryGetDeclIn("Ordering", "Shipped", out TypeDecl fromDownstream).ShouldBeTrue();
        SoleFieldOf(fromDownstream).ShouldBe("orderId");

        index.TryGetDeclIn("Sales", "Note", out TypeDecl fromUpstream).ShouldBeTrue();
        ((ValueObjectDecl)fromUpstream).Members.Select(m => m.Name).ShouldContain("text");
    }

    // ---- 5. The seam's own consumers inherit the fix --------------------------

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void The_context_aware_consumers_of_the_seam_answer_for_the_permitted_owner(bool warehouseFirst)
    {
        var index = IndexOf(warehouseFirst ? WarehouseFirstConformist : SalesFirstConformist);

        // `Classify`, `TryGetDecl` and `TryGetMemberType` all delegate to `TryGetDeclIn` before
        // falling back to the flat view, so fixing the seam has to move them too — that is the whole
        // point of fixing it here rather than in an eighth per-construct call site.
        index.Classify("Ordering", "Shipped").ShouldBe(TypeKind.Event);

        index.TryGetDecl("Ordering", "Shipped", out TypeDecl decl).ShouldBeTrue();
        SoleFieldOf(decl).ShouldBe("orderId");

        index.TryGetMemberType("Ordering", "Shipped", "orderId", out TypeRef type).ShouldBeTrue();
        type.Name.ShouldBe("String");
        index.TryGetMemberType("Ordering", "Shipped", "packageId", out _).ShouldBeFalse();
    }
}
