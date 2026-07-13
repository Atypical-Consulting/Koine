using Koine.Compiler.Ast;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// The shared local-binding shadow stack (#1497): the one place every code emitter's expression
/// translator tracks which names are currently bound as LOCALS (a command/factory parameter, a
/// <c>let</c> binding, a lambda parameter) and at what <see cref="TypeRef"/>.
/// <para>
/// Six translators used to back this onto a flat <c>HashSet&lt;string&gt;</c> +
/// <c>Dictionary&lt;string, TypeRef&gt;</c> pair, whose <c>PopLocal</c> unconditionally EVICTED a name
/// instead of restoring whatever the matching <c>PushLocal</c> shadowed. So a nested
/// <c>let n = ... in ...</c> (or a lambda parameter) that shadows a same-named OUTER binding
/// permanently destroyed the outer binding once the inner one popped, corrupting the emitter's own
/// type-tracking for the rest of the outer binding's scope — a real, target-typechecker-visible defect
/// (#1370 hit it as a <c>cargo check</c> E0308 in Rust; #1497 found the identical shape unfixed in the
/// five siblings).
/// </para>
/// <para>
/// The contract this pins: a push STACKS on top of any existing binding for that name, and the
/// matching pop RESTORES what was underneath — both the name's presence AND its exact
/// <see cref="TypeRef"/>? — rather than evicting it.
/// </para>
/// </summary>
public class LocalScopeStackTests
{
    private static TypeRef Type(string name, bool optional = false) => new(name, IsOptional: optional);

    [Fact]
    public void PushThenPop_OfASingleName_BindsThenUnbindsIt()
    {
        var stack = new LocalScopeStack();

        stack.IsLocal("n").ShouldBeFalse();

        stack.PushLocal("n", Type("Int"));

        stack.IsLocal("n").ShouldBeTrue();
        stack.TypeOf("n").ShouldBe(Type("Int"));

        stack.PopLocal("n");

        stack.IsLocal("n").ShouldBeFalse();
        stack.TypeOf("n").ShouldBeNull();
    }

    [Fact]
    public void NestedPushOfTheSameName_RestoresTheOuterTypeAfterTheInnerPop()
    {
        // The #1370/#1497 shape: `let n = amount in (let n = rate in ...) && n == rate` — popping the
        // INNER `n` must hand the outer `n` (Int?) back, not evict it.
        var stack = new LocalScopeStack();
        stack.PushLocal("n", Type("Int", optional: true));

        stack.PushLocal("n", Type("Decimal"));
        stack.TypeOf("n").ShouldBe(Type("Decimal"));

        stack.PopLocal("n");

        stack.IsLocal("n").ShouldBeTrue();
        stack.TypeOf("n").ShouldBe(Type("Int", optional: true));
    }

    [Fact]
    public void NestedPushOfTheSameName_WithNoTypeOnTheInnerPush_StillRestoresTheOuterType()
    {
        // A lambda parameter whose element type doesn't resolve pushes a null type. That must SHADOW the
        // outer type (the inner binding is genuinely unknown, not the outer's), and popping must still
        // hand the outer type back.
        var stack = new LocalScopeStack();
        stack.PushLocal("n", Type("Int", optional: true));

        stack.PushLocal("n");

        stack.IsLocal("n").ShouldBeTrue();
        stack.TypeOf("n").ShouldBeNull();

        stack.PopLocal("n");

        stack.TypeOf("n").ShouldBe(Type("Int", optional: true));
    }

    [Fact]
    public void PushWithNoType_IsStillALocal_ButContributesNoTypeBinding()
    {
        var stack = new LocalScopeStack();

        stack.PushLocal("x");

        stack.IsLocal("x").ShouldBeTrue();
        stack.TypeOf("x").ShouldBeNull();
        stack.ActiveBindings.ShouldBeEmpty();
    }

    [Fact]
    public void ActiveBindings_ExposeOnlyCurrentlyBoundNamesAtTheirTopOfStackType()
    {
        var stack = new LocalScopeStack();
        stack.PushLocal("n", Type("Int", optional: true));
        stack.PushLocal("other", Type("String"));

        stack.PushLocal("n", Type("Decimal"));

        // The inner `n` shadows the outer: the overlay must project Decimal, never both bindings.
        stack.ActiveBindings.ShouldBe(
            [
                new KeyValuePair<string, TypeRef>("n", Type("Decimal")),
                new KeyValuePair<string, TypeRef>("other", Type("String")),
            ],
            ignoreOrder: true);

        stack.PopLocal("n");

        stack.ActiveBindings.ShouldBe(
            [
                new KeyValuePair<string, TypeRef>("n", Type("Int", optional: true)),
                new KeyValuePair<string, TypeRef>("other", Type("String")),
            ],
            ignoreOrder: true);

        stack.PopLocal("n");
        stack.PopLocal("other");

        stack.ActiveBindings.ShouldBeEmpty();
    }

    [Fact]
    public void PopOfAnUnboundName_IsANoOp()
    {
        // Translators pop defensively (a `PopLocals(pushed)` unwind); popping a name that was never
        // pushed must not throw, and must not resurrect or corrupt anything.
        var stack = new LocalScopeStack();

        Should.NotThrow(() => stack.PopLocal("never-pushed"));

        stack.IsLocal("never-pushed").ShouldBeFalse();
    }

    [Fact]
    public void ThreeDeepShadowing_UnwindsOneLevelAtATime()
    {
        var stack = new LocalScopeStack();
        stack.PushLocal("n", Type("Int"));
        stack.PushLocal("n", Type("Decimal"));
        stack.PushLocal("n", Type("String"));

        stack.TypeOf("n").ShouldBe(Type("String"));
        stack.PopLocal("n");
        stack.TypeOf("n").ShouldBe(Type("Decimal"));
        stack.PopLocal("n");
        stack.TypeOf("n").ShouldBe(Type("Int"));
        stack.PopLocal("n");
        stack.IsLocal("n").ShouldBeFalse();
    }

    [Fact]
    public void NamesAreMatchedOrdinally()
    {
        var stack = new LocalScopeStack();
        stack.PushLocal("n", Type("Int"));

        stack.IsLocal("N").ShouldBeFalse();
        stack.TypeOf("N").ShouldBeNull();
    }

    // ---------------------------------------------------------------------------------------------
    // #1536 — a per-binding RENDERED name, for a target (Java) whose lowering must alpha-rename a
    // colliding binding rather than merely resolving it (the local's IDENTITY is unaffected — #1497 —
    // but its SPELLING in the emitted source must differ from whatever it shadows).
    // ---------------------------------------------------------------------------------------------

    [Fact]
    public void PushLocal_WithARenderedName_ReportsItFromRenderedNameOf()
    {
        var stack = new LocalScopeStack();

        stack.PushLocal("n", Type("Int"), renderedName: "n$1");

        stack.RenderedNameOf("n").ShouldBe("n$1");
    }

    [Fact]
    public void PushLocal_WithNoRenderedName_FallsBackToTheBindingsOwnName()
    {
        var stack = new LocalScopeStack();

        stack.PushLocal("n", Type("Int"));

        stack.RenderedNameOf("n").ShouldBe("n");
    }

    [Fact]
    public void RenderedNameOf_OfAnUnboundName_FallsBackToTheNameItself()
    {
        var stack = new LocalScopeStack();

        stack.RenderedNameOf("never-pushed").ShouldBe("never-pushed");
    }

    [Fact]
    public void NestedPushWithARenderedName_ShadowsTheOuterRenderedName_RestoredOnPop()
    {
        var stack = new LocalScopeStack();
        stack.PushLocal("n", Type("Int"), renderedName: "n");

        stack.PushLocal("n", Type("Int"), renderedName: "n$1");
        stack.RenderedNameOf("n").ShouldBe("n$1");

        stack.PopLocal("n");
        stack.RenderedNameOf("n").ShouldBe("n");
    }

    /// <summary>
    /// <see cref="LocalScopeStack.Overlay"/> is every translator's <c>EffectiveScope()</c>: the member
    /// scope with the active locals layered on top, so a local SHADOWS a same-named member for type
    /// resolution — and un-shadows it, at the member's own type, once it pops.
    /// </summary>
    [Fact]
    public void Overlay_ShadowsASameNamedMember_AndUnshadowsItOnPop()
    {
        const string src =
            """
            context Shop {
              value Money {
                n:    String
                base: Int
              }
            }
            """;

        var result = new KoineCompiler().Compile(src, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        ModelIndex index = new SemanticModel(result.Model!).Index;
        var money = result.Model!.Contexts
            .SelectMany(c => c.AllTypeDecls())
            .OfType<ValueObjectDecl>()
            .First(v => v.Name == "Money");

        TypeScope members = TypeScope.FromMembers(money.Members, index);
        var resolver = new TypeResolver(index, "Shop");
        var stack = new LocalScopeStack();

        // With nothing bound, `n` is the String MEMBER.
        resolver.Infer(new IdentifierExpr("n"), stack.Overlay(members, index))!.Name.ShouldBe("String");

        // A local `n` shadows it...
        stack.PushLocal("n", Type("Int"));
        resolver.Infer(new IdentifierExpr("n"), stack.Overlay(members, index))!.Name.ShouldBe("Int");

        // ...and popping it hands the member back.
        stack.PopLocal("n");
        resolver.Infer(new IdentifierExpr("n"), stack.Overlay(members, index))!.Name.ShouldBe("String");
    }
}
