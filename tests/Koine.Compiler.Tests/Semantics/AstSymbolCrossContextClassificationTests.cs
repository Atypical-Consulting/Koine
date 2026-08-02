using Koine.Compiler.Ast;
using Koine.Compiler.Ast.Bound;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Guards the <c>Ast/</c> symbol + lowering layers against <see cref="ModelIndex"/>'s flat,
/// last-declaration-wins <c>Classify(string)</c> view (#1870, the family behind #1632 … #1863).
/// </summary>
/// <remarks>
/// <para>R13.2 lets two bounded contexts each legally declare a type with the same simple name — and
/// with a DIFFERENT kind: <c>Catalog.Status</c> is an <c>enum</c> while <c>Support.Status</c> is a
/// <c>value</c>. The flat lookup keeps only whichever was indexed last, so any consumer that asks
/// "what kind is <c>Status</c>?" without saying "as seen from where" gets an answer that depends on
/// <c>.koi</c> <b>source order</b>. Every fixture below therefore ships in BOTH context orders and
/// must produce the same answer in each — a one-order test would prove luck, not correctness.</para>
/// <para>Two call sites were fixed here:
/// <list type="bullet">
///   <item><c>SymbolTable.InternType</c> — the interned <see cref="TypeSymbol.TypeKind"/> of a
///   declaration was classified by flat name, so the losing context's declaration was stamped with
///   the OTHER context's kind.</item>
///   <item><c>Lowerer.ClassifyDefault</c> — an enum-typed constructor default was recognised by flat
///   name, so a value object in the losing context got <see cref="DefaultKind.ConstantDefault"/>
///   instead of <see cref="DefaultKind.EnumDefault"/>.</item>
/// </list>
/// </para>
/// <para><c>Binder.ResolveTypeRef</c>'s own flat <c>Classify</c> is deliberately NOT changed: it
/// consumes the kind only to answer "is this a built-in?" and "is this the <c>*Id</c> convention?",
/// and neither question can differ by context (built-ins are resolved ahead of every dictionary, and
/// <c>IdValueObject</c> is only ever returned for a name NO context declares — in which case the
/// context-aware overload falls back to the identical flat answer). The last test below pins that
/// inertness so a future reader does not have to re-derive it.</para>
/// </remarks>
public class AstSymbolCrossContextClassificationTests
{
    /// <summary>
    /// <c>Catalog</c> declared FIRST, so <c>Support</c>'s <c>value Status</c> is indexed last and wins
    /// the flat table — the order under which the two flat call sites answered <c>Value</c> for
    /// <c>Catalog</c>'s enum.
    /// </summary>
    private const string CatalogFirstFixture = """
        context Catalog {
          enum Status { Draft, Active }

          value Listing {
            title:  String
            status: Status = Draft
          }
        }

        context Support {
          value Status {
            code: String
          }
        }
        """;

    /// <summary>The identical model with the two <c>context</c> blocks swapped — the order that
    /// accidentally answered correctly, because the flat table then held <c>Catalog</c>'s enum.</summary>
    private const string SupportFirstFixture = """
        context Support {
          value Status {
            code: String
          }
        }

        context Catalog {
          enum Status { Draft, Active }

          value Listing {
            title:  String
            status: Status = Draft
          }
        }
        """;

    private static SemanticModel Build(string src)
    {
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    private static TypeDecl DeclIn(SemanticModel sema, string context, string typeName) =>
        sema.Model.Contexts.Single(c => c.Name == context).AllTypeDecls().Single(t => t.Name == typeName);

    [Theory]
    [InlineData(nameof(CatalogFirstFixture), CatalogFirstFixture)]
    [InlineData(nameof(SupportFirstFixture), SupportFirstFixture)]
    public void Both_declaration_orders_are_a_legal_model(string order, string src)
    {
        IReadOnlyList<Diagnostic> diagnostics = new KoineCompiler().Diagnose(src);

        diagnostics.ShouldBeEmpty(
            $"[{order}] two contexts declaring a same-named type with different kinds is legal under R13.2:\n"
            + string.Join("\n", diagnostics.Select(d => $"{d.Code} {d.Message}")));
    }

    [Theory]
    [InlineData(nameof(CatalogFirstFixture), CatalogFirstFixture)]
    [InlineData(nameof(SupportFirstFixture), SupportFirstFixture)]
    public void Interned_type_symbol_carries_the_kind_of_its_own_contexts_declaration(string order, string src)
    {
        var sema = Build(src);

        var catalogStatus = (TypeSymbol)sema.GetDeclaredSymbol(DeclIn(sema, "Catalog", "Status"))!;
        var supportStatus = (TypeSymbol)sema.GetDeclaredSymbol(DeclIn(sema, "Support", "Status"))!;

        catalogStatus.TypeKind.ShouldBe(TypeKind.Enum, $"[{order}] Catalog.Status is declared `enum`");
        supportStatus.TypeKind.ShouldBe(TypeKind.Value, $"[{order}] Support.Status is declared `value`");
    }

    [Theory]
    [InlineData(nameof(CatalogFirstFixture), CatalogFirstFixture)]
    [InlineData(nameof(SupportFirstFixture), SupportFirstFixture)]
    public void Enum_typed_ctor_default_is_lowered_as_an_enum_default_in_its_own_context(string order, string src)
    {
        var sema = Build(src);
        var listing = (ValueObjectDecl)DeclIn(sema, "Catalog", "Listing");

        BoundField status = sema.BoundValueObjectFor(listing).Fields.Single(f => f.Name == "status");

        status.DefaultKind.ShouldBe(
            DefaultKind.EnumDefault,
            $"[{order}] `status: Status = Draft` is typed by Catalog's enum, so its default is not a compile-time constant");
    }

    [Theory]
    [InlineData(nameof(CatalogFirstFixture), CatalogFirstFixture)]
    [InlineData(nameof(SupportFirstFixture), SupportFirstFixture)]
    public void Type_reference_binds_to_the_declaration_its_own_context_sees(string order, string src)
    {
        // Binder.ResolveTypeRef's flat Classify is inert for this collision (both kinds fall through to
        // the already context-aware ResolveTypeName), which this pins in both orders: the `status:
        // Status` reference inside Catalog.Listing must bind to Catalog's enum, never Support's value.
        var sema = Build(src);
        var listing = (ValueObjectDecl)DeclIn(sema, "Catalog", "Listing");
        TypeRef statusRef = listing.Members.Single(m => m.Name == "status").Type;

        var bound = sema.GetSymbolInfo(statusRef).ShouldBeOfType<TypeSymbol>();
        bound.Declaration.ShouldBeSameAs(DeclIn(sema, "Catalog", "Status"), $"[{order}] must bind Catalog's Status");
    }
}
