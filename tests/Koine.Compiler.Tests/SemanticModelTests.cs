using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The <see cref="SemanticModel"/> resolution façade: <see cref="SemanticModel.GetSymbol"/> is the
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
        return new SemanticModel(model!);
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
        sym.Owner.Name.ShouldBe("Order");
    }

    [Fact]
    public void GetSymbol_returns_null_for_primitives_and_unknown_names()
    {
        var sema = Build();
        sema.GetSymbol("Int").ShouldBeNull();
        sema.GetSymbol("Nonexistent").ShouldBeNull();
    }
}
