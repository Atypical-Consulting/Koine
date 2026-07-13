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

    /// <summary>
    /// Issue #1374: a local pushed with NO type (a <c>let</c> binding whose value the resolver couldn't
    /// infer, or a lambda parameter whose element type didn't resolve — both real
    /// <c>PushLocal(name, type: null)</c> call sites) that SHADOWS a member must fall back to the
    /// shadowed member's declared type rather than hard-defaulting to <c>null</c>. A <c>null</c> own-type
    /// reads as non-optional to <c>EmitCoerced</c>, which then wraps the identifier in a bare
    /// <c>Decimal::from(...)</c> — invalid Rust (E0277) when the value is really an <c>Option</c>.
    /// <para>
    /// Reachability (this issue's Task 1): NOT reachable from any real <c>.koi</c> model today. The
    /// shape the issue proposed — a let binding whose value is an undeclared call, e.g.
    /// <c>let y = someUndeclaredHelper() in y</c> — never reaches the emitter at all (the compiler fails
    /// on it before emit, independently of any target). So this is pinned by direct construction, the
    /// same precedent #1355 set for its own unreachable-in-practice call shape — closing the landmine
    /// before a future change to let-binding inference makes it live.
    /// </para>
    /// </summary>
    [Fact]
    public void Untyped_local_shadowing_an_optional_member_falls_back_to_the_shadowed_members_type()
    {
        RustExpressionTranslator translator = NewTranslator(
            [new Member("y", new TypeRef("Int", IsOptional: true), null)]);

        // A local named `y` shadowing the member `y: Int?`, with an UNRESOLVABLE own type.
        translator.PushLocal("y");

        var sb = new StringBuilder();
        translator.WriteIdentifier("y", sb, null, new TypeRef("Decimal"));

        // The shadowed member is optional, so the widening must map INSIDE the Option — a bare
        // `Decimal::from(y)` wrap around an `Option<i64>` does not compile.
        sb.ToString().ShouldBe("y.map(Decimal::from)");
    }

    /// <summary>
    /// Issue #1374 guard: the fallback must not change a local that shadows NOTHING. With no member to
    /// fall through to, the resolver finds nothing either, so the own-type stays <c>null</c> and the
    /// rendering is exactly what it was before the fix.
    /// </summary>
    [Fact]
    public void Untyped_local_shadowing_no_member_renders_unchanged()
    {
        RustExpressionTranslator translator = NewTranslator();
        translator.PushLocal("z");

        var sb = new StringBuilder();
        translator.WriteIdentifier("z", sb, null, new TypeRef("Decimal"));

        sb.ToString().ShouldBe("Decimal::from(z)");
    }

    /// <summary>
    /// Issue #1374 guard: a local WITH a known type keeps using its own type — the shadowed member's type
    /// must never override it. Here the local <c>y</c> is a non-optional <c>Int</c> while the member it
    /// shadows is <c>Int?</c>: the bare (non-mapped) wrap is correct, and the fallback must not fire.
    /// </summary>
    [Fact]
    public void Typed_local_shadowing_an_optional_member_keeps_its_own_type()
    {
        RustExpressionTranslator translator = NewTranslator(
            [new Member("y", new TypeRef("Int", IsOptional: true), null)]);

        translator.PushLocal("y", new TypeRef("Int"));

        var sb = new StringBuilder();
        translator.WriteIdentifier("y", sb, null, new TypeRef("Decimal"));

        sb.ToString().ShouldBe("Decimal::from(y)");
    }

    /// <summary>
    /// Issue #1498 (Gap B): <c>EffectiveScope</c> overlays only the locals it has a type for, so a local
    /// whose current shadow type is UNRESOLVED was skipped entirely — and every consumer resolving that
    /// name then fell through to the base member scope, where an unrelated member that merely happens to
    /// share the name won by coincidence. Here the local <c>n</c> shadows an unrelated member
    /// <c>n: Int</c>: asking the translator for <c>n</c>'s type must answer "unresolved", not the
    /// member's <c>Int</c>.
    /// <para>
    /// The distinction matters because the answer drives whether a coercion is emitted AT ALL — see
    /// <see cref="Unresolved_shadow_does_not_manufacture_a_decimal_coercion_from_a_same_named_member"/>
    /// for the wrong Rust this produced.
    /// </para>
    /// </summary>
    [Fact]
    public void Unresolved_local_shadow_masks_a_same_named_member_rather_than_resolving_to_it()
    {
        RustExpressionTranslator translator = NewTranslator(
            [new Member("n", new TypeRef("Int"), null)]);

        translator.InferType(new IdentifierExpr("n"))?.Name.ShouldBe("Int");   // the member, unshadowed

        translator.PushLocal("n");   // an unresolved-type shadow, e.g. `let n = <unresolvable> in …`

        translator.InferType(new IdentifierExpr("n")).ShouldBeNull();
    }

    /// <summary>
    /// Issue #1498 (Gap B), the emitted-Rust consequence of the masking above, and the exact shape the
    /// issue's repro produced. <c>WriteBinary</c> asks <c>EffectiveScope</c> for each operand's type to
    /// decide whether an <c>Int</c> beside a <c>Decimal</c> must widen. With the unresolved shadow
    /// skipped, <c>n</c> resolved to the coincidentally-same-named member <c>n: Int</c> and the emitter
    /// manufactured a <c>Decimal::from(n)</c> around a local it knows nothing about. Masking the name
    /// leaves the type unresolved, so no coercion is invented and the operand renders as itself.
    /// </summary>
    [Fact]
    public void Unresolved_shadow_does_not_manufacture_a_decimal_coercion_from_a_same_named_member()
    {
        RustExpressionTranslator translator = NewTranslator(
        [
            new Member("n", new TypeRef("Int"), null),
            new Member("rate", new TypeRef("Decimal"), null),
        ]);

        translator.PushLocal("n");

        var comparison = new BinaryExpr(BinaryOp.Eq, new IdentifierExpr("n"), new IdentifierExpr("rate"));

        translator.Translate(comparison).ShouldBe("n == self.rate");
    }

    /// <summary>
    /// Issue #1498 guard: the masking must not disturb #1374's deliberate fallback. When an untyped
    /// local shadows a member AND a caller has independently established a <c>Decimal</c> coercion (from
    /// a declared field type, say — not from inferring the identifier), <c>WriteIdentifier</c> still
    /// consults the shadowed member's declared type to pick the widen SHAPE, because a bare
    /// <c>Decimal::from(...)</c> around what may really be an <c>Option</c> does not compile. That is a
    /// different question from "must we widen at all?", which is the one #1498 fixes — so the two rules
    /// coexist rather than collapsing into one. Duplicates
    /// <see cref="Untyped_local_shadowing_an_optional_member_falls_back_to_the_shadowed_members_type"/>'s
    /// expectation deliberately: that test is the thing this change must not break.
    /// </summary>
    [Fact]
    public void Unresolved_shadow_masking_leaves_the_1374_decimal_widen_fallback_intact()
    {
        RustExpressionTranslator translator = NewTranslator(
            [new Member("y", new TypeRef("Int", IsOptional: true), null)]);

        translator.PushLocal("y");

        var sb = new StringBuilder();
        translator.WriteIdentifier("y", sb, null, new TypeRef("Decimal"));

        sb.ToString().ShouldBe("y.map(Decimal::from)");
    }
}
