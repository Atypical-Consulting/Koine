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
    private static RustExpressionTranslator NewTranslator(IReadOnlyList<Member>? members = null)
    {
        var result = new KoineCompiler().Compile("context C { value V { x: Int } }", new CSharpEmitter());
        ModelIndex index = new SemanticModel(result.Model!).Index;
        return new RustExpressionTranslator(
            index,
            members: members ?? [],
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

    /// <summary>
    /// The member branch resolves its own type via <c>TypeResolver.Infer</c> rather than a
    /// caller-supplied <c>ownType</c> — the riskier half of the #1355 fix, since it walks the resolver
    /// instead of a plain dictionary lookup. Pins the same <c>.map(Decimal::from)</c> shape for a bare
    /// optional-<c>Int</c> MEMBER identifier (not a local), reached the same unthreaded way `Write`'s
    /// own <c>IdentifierExpr</c> case does.
    /// </summary>
    [Fact]
    public void Write_identifier_case_maps_an_optional_int_member_coerced_toward_decimal()
    {
        RustExpressionTranslator translator = NewTranslator(
            [new Member("y", new TypeRef("Int", IsOptional: true), Initializer: null)]);

        var sb = new StringBuilder();
        translator.WriteIdentifier("y", sb, null, new TypeRef("Decimal"));

        sb.ToString().ShouldBe("self.y.map(Decimal::from)");
    }

    /// <summary>
    /// Pins why <c>EmitCoerced</c> is the one optionality call site that does NOT route through the shared
    /// <c>BranchReconciliation.Classify</c> (#1356). A local can be registered with NO type — <c>PushLocal</c>'s
    /// type parameter is optional, and a lambda parameter whose element type does not resolve passes none —
    /// so <c>ownType</c> is <see langword="null"/> here while <c>coerceTo</c> (from <c>TypeResolver</c>, via
    /// <c>WriteBinary</c>) still says a <c>Decimal</c> is expected. <c>BranchReconciliation</c> degrades an
    /// unresolved type to "reconcile nothing", which would drop the widen and emit a bare <c>y</c> — an
    /// <c>i64</c> against a <c>Decimal</c> (<c>cargo check</c> E0308). The coercion must survive the unknown
    /// type, so this asserts the <c>Decimal::from(...)</c> is still emitted.
    /// </summary>
    [Fact]
    public void Write_identifier_case_widens_an_untyped_local_coerced_toward_decimal()
    {
        RustExpressionTranslator translator = NewTranslator();
        translator.PushLocal("y");

        var sb = new StringBuilder();
        translator.WriteIdentifier("y", sb, null, new TypeRef("Decimal"));

        sb.ToString().ShouldBe("Decimal::from(y)");
    }
}
