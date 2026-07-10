using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Unit tests exercising <see cref="RustExpressionTranslator.WriteIdentifier"/> directly, for call
/// shapes that no real <c>.koi</c> model can reach through the emitter's public entry points — see
/// #1355.
/// </summary>
public class RustExpressionTranslatorTests
{
    private static RustExpressionTranslator NewTranslator()
    {
        var result = new KoineCompiler().Compile("context C { value V { x: Int } }", new CSharpEmitter());
        ModelIndex index = new SemanticModel(result.Model!).Index;
        return new RustExpressionTranslator(
            index,
            members: [],
            enumMemberToType: new Dictionary<string, string>(),
            enumVariants: new Dictionary<(string, string), IReadOnlyDictionary<string, string>>(),
            typeMapper: new RustTypeMapper(index));
    }

    /// <summary>
    /// <see cref="RustExpressionTranslator.Write"/>'s own <c>IdentifierExpr</c> case calls
    /// <c>WriteIdentifier(id.Name, sb, null, coerceTo)</c> with no <c>ownType</c> argument — exactly the
    /// shape reproduced here. An optional <c>Int</c> local coerced toward <c>Decimal</c> must map inside
    /// its <c>Option</c> (<c>.map(Decimal::from)</c>) rather than being wrapped in an invalid bare
    /// <c>Decimal::from(...)</c> prefix, regardless of which caller reaches <c>WriteIdentifier</c>
    /// (mirrors the fix #1347 already applied to <c>WriteOperand</c>'s sibling call site).
    /// </summary>
    [Fact]
    public void Write_identifier_case_maps_an_optional_int_local_coerced_toward_decimal()
    {
        RustExpressionTranslator translator = NewTranslator();
        translator.PushLocal("y", new TypeRef("Int", IsOptional: true));

        var sb = new StringBuilder();
        translator.WriteIdentifier("y", sb, null, new TypeRef("Decimal"));

        sb.ToString().ShouldBe("y.map(Decimal::from)");
    }
}
