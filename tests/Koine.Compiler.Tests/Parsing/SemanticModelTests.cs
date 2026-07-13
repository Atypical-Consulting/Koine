using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The <see cref="SemanticModel"/> resolution façade: <see cref="SemanticModel.GetSymbol(string)"/> is the
/// single path the editor services share for go-to-definition / hover / rename.
/// </summary>
public class SemanticModelTests
{
    private const string Src = """
        context Shop {
          value Money { amount: Decimal }
          enum Status { Active, Closed }
          entity Order identified by OrderId { total: Decimal }
          spec IsBig on Order = total > 100
        }
        """;

    private static SemanticModel Build()
    {
        var (model, diagnostics) = new KoineCompiler().Parse(Src);
        diagnostics.ShouldBeEmpty();
        model.ShouldNotBeNull();
        return new SemanticModel(model);
    }

    [Fact]
    public void GetSymbol_resolves_a_declared_type()
    {
        var sym = Build().GetSymbol("Money").ShouldBeOfType<TypeSymbol>();
        sym.TypeKind.ShouldBe(TypeKind.Value);
        sym.DeclSpan.ShouldNotBe(SourceSpan.None);
    }

    [Fact]
    public void GetSymbol_resolves_an_enum_and_its_member()
    {
        var sema = Build();
        sema.GetSymbol("Status").ShouldBeOfType<TypeSymbol>().TypeKind.ShouldBe(TypeKind.Enum);

        var member = sema.GetSymbol("Active").ShouldBeOfType<EnumMemberSymbol>();
        member.EnumName.ShouldBe("Status");
        member.DeclSpan.ShouldNotBe(SourceSpan.None);
    }

    [Fact]
    public void GetSymbol_resolves_a_spec_to_its_target()
    {
        var sym = Build().GetSymbol("IsBig").ShouldBeOfType<SpecSymbol>();
        sym.TargetType.ShouldBe("Order");
    }

    [Fact]
    public void GetSymbol_resolves_an_id_value_object_to_its_owning_entity()
    {
        var sym = Build().GetSymbol("OrderId").ShouldBeOfType<IdValueObjectSymbol>();
        sym.Owner.ShouldNotBeNull().Name.ShouldBe("Order");
    }

    [Fact]
    public void GetSymbol_returns_null_for_primitives_and_unknown_names()
    {
        var sema = Build();
        sema.GetSymbol("Int").ShouldBeNull();
        sema.GetSymbol("Nonexistent").ShouldBeNull();
    }

    /// <summary>
    /// Issue #1498: a smart enum's associated data is its member set — <c>MemberTypeOf</c> had no
    /// <c>EnumDecl</c> case at all, so a documented, accepted <c>currency.symbol</c> read resolved to
    /// nothing (and every emitter downstream had to guess). The signature's parameters resolve to their
    /// declared types, exactly as a value object's members do.
    /// </summary>
    [Fact]
    public void Index_resolves_a_smart_enums_associated_data_members()
    {
        ModelIndex index = SmartEnumIndex();

        index.TryGetMemberType("Currency", "symbol", out TypeRef symbol).ShouldBeTrue();
        symbol.Name.ShouldBe("String");

        index.TryGetMemberType("Currency", "decimals", out TypeRef decimals).ShouldBeTrue();
        decimals.Name.ShouldBe("Int");

        index.MemberNames("Currency").ShouldBe(["symbol", "decimals"]);
    }

    /// <summary>
    /// Issue #1498's other half: a member the enum does NOT declare stays unresolved, which is what lets
    /// <c>ExpressionChecker.CheckMember</c> report it as an unknown member. A bare-name enum (no
    /// signature) therefore has no members at all.
    /// </summary>
    [Fact]
    public void Index_does_not_resolve_an_undeclared_enum_member()
    {
        SmartEnumIndex().TryGetMemberType("Currency", "bogusMember", out _).ShouldBeFalse();

        // `Status` is a bare-name enum: no signature, so no members and no suggestions.
        ModelIndex index = new SemanticModel(new KoineCompiler().Parse(Src).Model!).Index;
        index.TryGetMemberType("Status", "anything", out _).ShouldBeFalse();
        index.MemberNames("Status").ShouldBeEmpty();
    }

    /// <summary>
    /// The resolution the index change buys the whole pipeline: <see cref="TypeResolver"/> now infers
    /// <c>currency.symbol</c> as its declared <c>String</c> instead of <c>ErrorType</c>.
    /// </summary>
    [Fact]
    public void Resolver_infers_a_smart_enum_associated_data_access_as_its_declared_type()
    {
        ModelIndex index = SmartEnumIndex();
        var resolver = new TypeResolver(index, "Shop");
        var scope = TypeScope.FromRefPairs(
            [new KeyValuePair<string, TypeRef>("currency", new TypeRef("Currency"))], index);

        resolver.Infer(new MemberAccessExpr(new IdentifierExpr("currency"), "symbol"), scope)
            .ShouldNotBeNull().Name.ShouldBe("String");

        resolver.Infer(new MemberAccessExpr(new IdentifierExpr("currency"), "bogusMember"), scope)
            .ShouldBeNull();
    }

    private static ModelIndex SmartEnumIndex()
    {
        const string src = """
            context Shop {
              enum Currency(symbol: String, decimals: Int) {
                EUR("€", 2)
                USD("$", 2)
              }
            }
            """;
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        diagnostics.ShouldBeEmpty();
        return new SemanticModel(model.ShouldNotBeNull()).Index;
    }
}
