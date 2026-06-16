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
        Assert.Empty(diagnostics);
        Assert.NotNull(model);
        return new SemanticModel(model!);
    }

    [Fact]
    public void GetSymbol_resolves_a_declared_type()
    {
        var sym = Assert.IsType<TypeSymbol>(Build().GetSymbol("Money"));
        Assert.Equal(TypeKind.Value, sym.TypeKind);
        Assert.NotEqual(SourceSpan.None, sym.DeclSpan);
    }

    [Fact]
    public void GetSymbol_resolves_an_enum_and_its_member()
    {
        var sema = Build();
        Assert.Equal(TypeKind.Enum, Assert.IsType<TypeSymbol>(sema.GetSymbol("Status")).TypeKind);

        var member = Assert.IsType<EnumMemberSymbol>(sema.GetSymbol("Active"));
        Assert.Equal("Status", member.EnumName);
        Assert.NotEqual(SourceSpan.None, member.DeclSpan);
    }

    [Fact]
    public void GetSymbol_resolves_a_spec_to_its_target()
    {
        var sym = Assert.IsType<SpecSymbol>(Build().GetSymbol("IsBig"));
        Assert.Equal("Order", sym.TargetType);
    }

    [Fact]
    public void GetSymbol_resolves_an_id_value_object_to_its_owning_entity()
    {
        var sym = Assert.IsType<IdValueObjectSymbol>(Build().GetSymbol("OrderId"));
        Assert.Equal("Order", sym.Owner.Name);
    }

    [Fact]
    public void GetSymbol_returns_null_for_primitives_and_unknown_names()
    {
        var sema = Build();
        Assert.Null(sema.GetSymbol("Int"));
        Assert.Null(sema.GetSymbol("Nonexistent"));
    }
}
