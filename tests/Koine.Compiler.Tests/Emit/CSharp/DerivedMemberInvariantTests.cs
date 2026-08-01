using System.Reflection;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1756: a value object whose <c>invariant</c> references a <b>derived</b> member used to emit
/// the member's bare camelCase name. A derived member has no constructor parameter — it is a get-only
/// property computed from the stored ones — so the guard bound to nothing (<c>CS0103</c>) and the
/// shipped <c>templates/saas-subscription</c> emitted C# that did not compile.
/// <para>
/// These are Roslyn <b>compile-and-execute</b> meta-tests on purpose: the snapshot suites happily
/// captured the broken text for months without noticing, so the decisive assertion is that the emitted
/// C# compiles AND that the guard evaluates the derivation correctly — the fix substitutes the
/// derived member's defining expression over the constructor parameters, keeping the emitter's
/// deliberate validate-before-assign ordering.
/// </para>
/// </summary>
public class DerivedMemberInvariantTests
{
    /// <summary>The issue's minimal reproduction: an invariant over a single derived member.</summary>
    private const string UsageMeterFixture = """
        context Subscription {
          value UsageMeter {
            includedQuota: Int
            consumed:      Int
            overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
            invariant overage >= 0   "overage can never be negative"
          }
        }
        """;

    /// <summary>A derived member defined over another derived member — substitution must recurse.</summary>
    private const string ChainedFixture = """
        context Subscription {
          value Ledger {
            gross:  Int
            rate:   Int
            net:    Int = gross - rate
            doubled: Int = net * 2
            invariant doubled > 0   "doubled net stays positive"
          }
        }
        """;

    /// <summary>
    /// A <b>diamond</b>: one invariant reaches <c>net</c> twice along two different paths. The visited
    /// set must scope re-entry to the path currently being expanded, not ban a member for the rest of
    /// the guard — otherwise the second path degrades to the old dangling name.
    /// </summary>
    private const string DiamondFixture = """
        context Subscription {
          value Split {
            gross:   Int
            rate:    Int
            net:     Int = gross - rate
            doubled: Int = net * 2
            total:   Int = net + doubled
            overQuota: Bool = net > rate
            invariant total > 0   "the split total stays positive"
            invariant overQuota   "the net must exceed the rate"
          }
        }
        """;

    /// <summary>
    /// The <b>hygiene</b> case: the lambda binds <c>rate</c>, the same name the derivation reads. In the
    /// emitted C# a lambda parameter and a constructor parameter share one identifier space, so splicing
    /// <c>total = rate * 2</c> here would read the ELEMENT — quietly admitting an instance that violates
    /// the invariant that let it through. The emitter refuses instead, leaving the pre-#1756 bare name.
    /// </summary>
    private const string LambdaCaptureFixture = """
        context Shop {
          value Cart {
            rate:  Int
            lines: List<Int>
            total: Int = rate * 2
            invariant lines.all(rate => rate < total)   "every line stays below the total"
          }
        }
        """;

    /// <summary>The same shape with a lambda binding that shadows nothing — this one must substitute.</summary>
    private const string LambdaNoCaptureFixture = """
        context Shop {
          value Basket {
            rate:  Int
            lines: List<Int>
            total: Int = rate * 2
            invariant lines.all(line => line < total)   "every line stays below the total"
          }
        }
        """;

    /// <summary>
    /// Two lambdas of the SAME name nested inside one another (issue #1768, Task 3): the outer
    /// <c>rate =&gt;</c> is mangled to free the member name, then the inner <c>rate =&gt;</c> — shadowing
    /// the SAME Koine name again, one level deeper — must be mangled to a DIFFERENT identifier than the
    /// outer's (not collide with it), and the outer's own rename mapping must survive the inner lambda's
    /// render (save/restore nesting), rather than being left clobbered once the inner call returns.
    /// </summary>
    private const string NestedShadowFixture = """
        context Shop {
          value Grid {
            rate:  Int
            rows:  List<Int>
            total: Int = rate * 2
            invariant rows.all(rate => rows.all(rate => rate < total))   "every cell stays below the total"
          }
        }
        """;

    [Fact]
    public void A_nested_lambda_rebinding_the_same_name_restores_the_outer_mapping()
    {
        Assembly asm = CompileFixture(NestedShadowFixture);
        Type grid = asm.GetType("Shop.Grid")!;

        // rate = 2 -> Total = 4, and a row of 5 is NOT below it: the guard must reject.
        Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(grid, new object[] { 2, new List<int> { 5 } }));

        // rate = 10 -> Total = 20, and a row of 5 IS below it: the guard must admit.
        Activator.CreateInstance(grid, new object[] { 10, new List<int> { 5 } }).ShouldNotBeNull();
    }

    /// <summary>
    /// A derived member defined transitively over ANOTHER derived member, referenced from inside a
    /// member-shadowing lambda (issue #1768, Task 3): substituting <c>total</c> first splices
    /// <c>subtotal * 2</c>, and that splice must ITSELF resolve <c>subtotal</c> as a member (recursing
    /// into <c>rate + 1</c>) rather than picking up the lambda's renamed <c>rate</c> binding at any point
    /// along the chain — proving <c>TryWriteDerivedBody</c>'s scope-suppression holds across recursive
    /// substitution, not just a single hop.
    /// </summary>
    private const string TransitiveDerivationFixture = """
        context Shop {
          value Ledger {
            rate:     Int
            lines:    List<Int>
            subtotal: Int = rate + 1
            total:    Int = subtotal * 2
            invariant lines.all(rate => rate < total)   "every line stays below the total"
          }
        }
        """;

    [Fact]
    public void A_transitive_derivation_substitutes_through_a_renamed_binding()
    {
        Assembly asm = CompileFixture(TransitiveDerivationFixture);
        Type ledger = asm.GetType("Shop.Ledger")!;

        // rate = 1 -> subtotal = 2 -> total = 4; a line of 5 is not below it.
        Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(ledger, new object[] { 1, new List<int> { 5 } }));

        // rate = 10 -> subtotal = 11 -> total = 22; a line of 5 is below it.
        object ok = Activator.CreateInstance(ledger, new object[] { 10, new List<int> { 5 } })!;
        ledger.GetProperty("Total")!.GetValue(ok).ShouldBe(22);
    }

    /// <summary>
    /// Exercises <c>WriteLet</c>'s rename path specifically (issue #1768, Task 3), rather than
    /// <c>RenderLambda</c>'s: a <c>let rate = 1 in …</c> binding shadows the member <c>rate</c> — so
    /// inside the let's own scope, a bare <c>rate</c> reference must read the let's fixed local (always
    /// <c>1</c>) — while <c>total</c>, referenced in the SAME scope, is a derived member defined as
    /// <c>rate * 2</c> over the REAL constructor parameter. Pre-#1768 hygiene, substituting <c>total</c>
    /// here would have refused (an un-renamed local capture) or — worse, pre-#1756/#1768 entirely —
    /// silently spliced against the let's own <c>rate</c>, always yielding <c>total == 2</c> regardless
    /// of the constructor argument. Both would be observably wrong: this fixture is built so the
    /// discriminating instance (rate = 10) only succeeds when <c>total</c> is computed from the real
    /// constructor parameter, not the let's local.
    /// </summary>
    private const string LetShadowFixture = """
        context Shop {
          value Crate {
            rate:  Int
            lines: List<Int>
            total: Int = rate * 2
            invariant let rate = 1 in rate == 1 && lines.all(line => line < total)   "the let's own rate stays fixed at 1 while total still derives from the real constructor rate"
          }
        }
        """;

    [Fact]
    public void A_let_binding_that_shadows_a_member_does_not_leak_into_a_substituted_derivation()
    {
        Assembly asm = CompileFixture(LetShadowFixture);
        Type crate = asm.GetType("Shop.Crate")!;

        // rate = 2 -> total = 4 (from the real constructor parameter), and a line of 5 is
        // not below it: the guard must reject regardless of the let's own fixed rate = 1.
        Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(crate, new object[] { 2, new List<int> { 5 } }));

        // rate = 10 -> total = 20 (from the REAL constructor parameter, not the let's fixed
        // rate = 1): a line of 5 is below it, so construction must succeed. Pre-fix, the let's
        // own `rate = 1` binding leaking into total's substituted body would compute
        // total = 1 * 2 = 2 and wrongly reject this instance.
        object ok = Activator.CreateInstance(crate, new object[] { 10, new List<int> { 5 } })!;
        crate.GetProperty("Total")!.GetValue(ok).ShouldBe(20);
    }

    /// <summary>
    /// An author-written member already named after what <c>MangleBinding</c> would otherwise pick
    /// (issue #1768, Task 3): the lambda's <c>rate =&gt;</c> shadows the member <c>rate</c>, so
    /// <c>MangleBinding</c> tries <c>__rate</c> first — but the model ALSO declares a real member
    /// literally named <c>__rate</c>, so that candidate collides and the fallback loop must pick
    /// <c>__rate2</c> instead. Forces <c>MangleBinding</c>'s <c>n = 2</c> branch for real, rather than
    /// coincidentally passing because the candidate was never checked against the model's own members.
    /// </summary>
    private const string PreMangledFixture = """
        context Shop {
          value Slate {
            rate:   Int
            __rate: Int
            lines:  List<Int>
            total:  Int = rate * 2
            invariant lines.all(rate => rate < total)   "every line stays below the total"
          }
        }
        """;

    [Fact]
    public void A_mangled_name_that_the_model_already_uses_does_not_collide()
    {
        Assembly asm = CompileFixture(PreMangledFixture);
        Type slate = asm.GetType("Shop.Slate")!;

        // rate = 2 -> Total = 4, and a line of 5 is not below it: the guard must reject.
        Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(slate, new object[] { 2, 99, new List<int> { 5 } }));

        // rate = 10 -> Total = 20, and a line of 5 is below it: construction (with the lambda's
        // `rate` mangled to `__rate2`, since `__rate` is already taken by a real member) must succeed.
        object ok = Activator.CreateInstance(slate, new object[] { 10, 99, new List<int> { 5 } })!;
        slate.GetProperty("Total")!.GetValue(ok).ShouldBe(20);
    }

    /// <summary>
    /// A member whose Koine name camelCases to a C# reserved keyword (issue #1768): <c>CSharpNaming
    /// .ToCamelCase</c> already keyword-escapes its result (<c>"base"</c> becomes <c>"@base"</c>), so
    /// <c>MangleBinding</c> must not blindly prepend <c>"__"</c> onto an already-escaped name — that
    /// would emit <c>__@base</c>, which is not a valid C# identifier (<c>@</c> is only legal as the
    /// FIRST character). A mangled name can never itself collide with a bare keyword (no reserved word
    /// starts with <c>__</c>), so the escape is not needed post-prefix.
    /// </summary>
    private const string KeywordMemberFixture = """
        context Shop {
          value Widget {
            base:  Int
            items: List<Int>
            total: Int = base * 2
            invariant items.all(base => base < total)   "every item stays below the total"
          }
        }
        """;

    [Fact]
    public void A_member_name_that_camel_cases_to_a_keyword_is_mangled_to_valid_csharp()
    {
        Assembly asm = CompileFixture(KeywordMemberFixture);
        Type widget = asm.GetType("Shop.Widget")!;

        // base = 2 -> Total = 4, and an item of 5 is NOT below it: the guard must reject.
        Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(widget, new object[] { 2, new List<int> { 5 } }));

        // base = 10 -> Total = 20, and an item of 5 IS below it: construction must succeed.
        object ok = Activator.CreateInstance(widget, new object[] { 10, new List<int> { 5 } })!;
        widget.GetProperty("Total")!.GetValue(ok).ShouldBe(20);
    }

    /// <summary>
    /// The residual, GENUINELY unsafe shape (issue #1768): a single derived member referenced from a
    /// plain invariant — no lambda/<c>let</c> anywhere. Used (not compiled through the emitter directly)
    /// to obtain a real <see cref="ModelIndex"/> and <see cref="ValueObjectDecl"/> for driving
    /// <see cref="CSharpExpressionTranslator"/> by hand in
    /// <see cref="A_pushed_local_that_cannot_be_renamed_still_refuses_substitution"/> — see that test's
    /// doc comment for why a real command/factory <c>.koi</c> fixture cannot exercise this case.
    /// </summary>
    private const string PushedLocalCaptureFixture = """
        context Shop {
          value Meter {
            rate:  Int
            total: Int = rate * 2
            invariant total > 0   "total must stay positive"
          }
        }
        """;

    /// <summary>
    /// An enum-typed derived member whose branches name members SHARED with another enum, so the
    /// substituted body needs the same expected-enum hint the derived-property body gets — otherwise
    /// the two arms qualify to different enums and the ternary has no common type (CS0173).
    /// </summary>
    private const string SharedEnumMemberFixture = """
        context Shop {
          enum Grade { Low
                       High }
          enum Rank  { Low
                       Top }
          value Card {
            score: Int
            grade: Grade = if score > 10 then High else Low
            invariant grade == High   "a card must be high grade"
          }
        }
        """;

    /// <summary>An entity carrying the same shape — its guards run after assignment, over properties.</summary>
    private const string EntityFixture = """
        context Subscription {
          aggregate Metering root Meter {
            entity Meter identified by MeterId {
              includedQuota: Int
              consumed:      Int
              overage:       Int = if consumed > includedQuota then consumed - includedQuota else 0
              invariant overage >= 0   "overage can never be negative"
            }
          }
        }
        """;

    private static Assembly CompileFixture(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return asm!;
    }

    [Fact]
    public void Value_object_invariant_over_a_derived_member_compiles()
    {
        Assembly asm = CompileFixture(UsageMeterFixture);
        asm.GetType("Subscription.UsageMeter").ShouldNotBeNull();
    }

    [Fact]
    public void Value_object_invariant_over_a_derived_member_evaluates_the_derivation()
    {
        Assembly asm = CompileFixture(UsageMeterFixture);
        Type meter = asm.GetType("Subscription.UsageMeter")!;

        // The derivation is non-negative for every input, so construction always succeeds — and the
        // derived property must agree with what the guard computed over the constructor parameters.
        object underQuota = Activator.CreateInstance(meter, new object[] { 100, 40 })!;
        meter.GetProperty("Overage")!.GetValue(underQuota).ShouldBe(0);

        object overQuota = Activator.CreateInstance(meter, new object[] { 100, 175 })!;
        meter.GetProperty("Overage")!.GetValue(overQuota).ShouldBe(75);
    }

    [Fact]
    public void Chained_derived_members_substitute_recursively()
    {
        Assembly asm = CompileFixture(ChainedFixture);
        Type ledger = asm.GetType("Subscription.Ledger")!;

        object ok = Activator.CreateInstance(ledger, new object[] { 10, 4 })!;
        ledger.GetProperty("Doubled")!.GetValue(ok).ShouldBe(12);

        // gross - rate = -1 -> doubled = -2, so the guard must reject it *before* assignment.
        TargetInvocationException ex = Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(ledger, new object[] { 3, 4 }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void A_derived_member_reached_twice_in_one_guard_substitutes_on_both_paths()
    {
        Assembly asm = CompileFixture(DiamondFixture);
        Type split = asm.GetType("Subscription.Split")!;

        // net = 6, doubled = 12, total = 18, overQuota = true.
        object ok = Activator.CreateInstance(split, new object[] { 10, 4 })!;
        split.GetProperty("Total")!.GetValue(ok).ShouldBe(18);
        split.GetProperty("OverQuota")!.GetValue(ok).ShouldBe(true);

        // A bare Bool derived member as the whole guard: net = 1 is not > rate = 9, so this throws.
        TargetInvocationException ex = Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(split, new object[] { 10, 9 }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void A_lambda_binding_that_shadows_a_member_is_renamed_so_the_derivation_substitutes()
    {
        Assembly asm = CompileFixture(LambdaCaptureFixture);
        Type cart = asm.GetType("Shop.Cart")!;

        // rate = 2 -> Total = 4, and a line of 5 is NOT below it: the guard must reject.
        TargetInvocationException ex = Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(cart, new object[] { 2, new List<int> { 5 } }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");

        // rate = 10 -> Total = 20, and a line of 5 is below it: the guard must admit.
        object ok = Activator.CreateInstance(cart, new object[] { 10, new List<int> { 5 } })!;
        cart.GetProperty("Total")!.GetValue(ok).ShouldBe(20);
    }

    [Fact]
    public void A_lambda_binding_that_shadows_nothing_still_substitutes()
    {
        Assembly asm = CompileFixture(LambdaNoCaptureFixture);
        Type basket = asm.GetType("Shop.Basket")!;

        // rate = 1 -> total = 2, and a line of 5 is not below it: the guard must reject.
        TargetInvocationException ex = Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(basket, new object[] { 1, new List<int> { 5 } }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");

        object ok = Activator.CreateInstance(basket, new object[] { 10, new List<int> { 5 } })!;
        basket.GetProperty("Total")!.GetValue(ok).ShouldBe(20);
    }

    /// <summary>
    /// The residual case Task 1's rename cannot cover (issue #1768): a local the emitter pushes
    /// directly — <c>CSharpEmitter</c>/<c>CSharpEmitter.Behaviors.cs</c> call
    /// <see cref="CSharpExpressionTranslator.PushLocal"/> for a command, factory, or service-operation
    /// parameter — never goes through the rename-aware <c>RenderLambda</c>/<c>WriteLet</c> path, so it
    /// can never be mangled: its name IS the emitted public C# signature.
    /// <c>WouldBeCaptured</c> must still refuse a derived-member substitution such a local shadows.
    /// <para>
    /// This drives <see cref="CSharpExpressionTranslator"/> directly instead of compiling a
    /// command/factory <c>.koi</c> fixture through <see cref="CSharpEmitter"/>, because — verified
    /// empirically against this codebase, not assumed — <c>NameMode.Parameter</c> substitution (the
    /// only mode <c>TryWriteDerivedBody</c> ever runs under) is reachable EXCLUSIVELY from a value
    /// object's own constructor invariant guards: <c>WriteValueObjectConstructor</c>/
    /// <c>WriteConstructor</c> are the only two <c>NameMode.Parameter</c> call sites in the whole C#
    /// emitter, every command/factory/service-operation guard renders in <c>NameMode.Property</c>
    /// (never substituting), and <see cref="ValueObjectDecl"/> has no commands or factories to push an
    /// external local through in the first place. So a real command/factory parameter can never share a
    /// translator's scope with a Parameter-mode substitution in the shipped grammar today — this test
    /// pins the guarantee at the mechanism it actually depends on (an un-renamed <c>PushLocal</c>'d
    /// name), so it stays true even if a future construct brings the two together.
    /// </para>
    /// </summary>
    [Fact]
    public void A_pushed_local_that_cannot_be_renamed_still_refuses_substitution()
    {
        var result = new KoineCompiler().Compile(PushedLocalCaptureFixture, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var index = new ModelIndex(result.Model!);
        ValueObjectDecl meter = result.Model!.Contexts.Single(c => c.Name == "Shop")
            .Types.OfType<ValueObjectDecl>().Single(v => v.Name == "Meter");
        Invariant invariant = meter.Invariants.Single();

        var translator = new CSharpExpressionTranslator(
            index, meter.Members, new Dictionary<string, string>(StringComparer.Ordinal));

        // Exactly what CSharpEmitter/.Behaviors.cs do for a command/factory/service parameter:
        // PushLocal directly — never through a lambda/let — so no rename is ever registered for it.
        translator.PushLocal("rate", new TypeRef("Int"));
        var guard = translator.TranslateTopLevel(invariant.Condition, CSharpExpressionTranslator.NameMode.Parameter);

        // A minimal, hand-assembled host for the translated guard (a full command/factory fixture
        // cannot exist for this scope, per the doc comment above) — only "rate" is in scope, matching
        // a value object's own constructor.
        var source = $$"""
            public sealed class Meter
            {
                public Meter(int rate)
                {
                    if (!({{guard}}))
                    {
                        throw new System.Exception("total must stay positive");
                    }
                }
            }
            """;

        var (assembly, errors) = TestSupport.Compile(new[] { new EmittedFile("Meter.cs", source) });

        // Refused: "total" stays the bare pre-#1756 name (unresolvable here — only "rate" is in scope)
        // rather than splicing "rate * 2", which would silently read the PUSHED local instead of the
        // member the invariant meant — exactly the miscompile issue #1768 exists to prevent.
        assembly.ShouldBeNull();
        errors.ShouldContain(e => e.Contains("CS0103", StringComparison.Ordinal)
            && e.Contains("total", StringComparison.Ordinal));
    }

    [Fact]
    public void An_enum_typed_derived_member_keeps_its_expected_enum_when_substituted()
    {
        Assembly asm = CompileFixture(SharedEnumMemberFixture);
        Type card = asm.GetType("Shop.Card")!;

        object high = Activator.CreateInstance(card, new object[] { 42 })!;
        card.GetProperty("Grade")!.GetValue(high)!.ToString().ShouldBe("High");

        TargetInvocationException ex = Should.Throw<TargetInvocationException>(
            () => Activator.CreateInstance(card, new object[] { 1 }));
        ex.InnerException!.GetType().Name.ShouldBe("DomainInvariantViolationException");
    }

    [Fact]
    public void Entity_invariant_over_a_derived_member_compiles()
    {
        Assembly asm = CompileFixture(EntityFixture);
        asm.GetType("Subscription.Meter").ShouldNotBeNull();
    }
}
