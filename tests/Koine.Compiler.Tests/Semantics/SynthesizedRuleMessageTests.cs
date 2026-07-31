using System.Reflection;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// #1313 / PR #1478 regression net. An invariant with NO explicit message gets one synthesized by
/// rendering its condition back to Koine source (CSharpEmitter.SynthesizeMessage → Lowerer.SourceText
/// → BinaryOpExtensions.Symbol). That text is user-visible: it is the `rule` baked into the emitted
/// DomainInvariantViolationException. The And/Or mapping silently drifted from the grammar
/// (KoineLexer.g4: AND : '&&', OR : '||') to the English words "and"/"or" and back, and NOTHING caught
/// it — no .koi in templates/ or tests/ had an unmessaged &amp;&amp; / || invariant. These tests are that net.
/// </summary>
public class SynthesizedRuleMessageTests
{
    private static (Assembly Asm, string Files) Compile(string source)
    {
        var result = new KoineCompiler().Compile(source, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        var (asm, errors) = TestSupport.Compile(result.Files);
        (asm is not null).ShouldBeTrue("generated C# failed to compile:\n" + string.Join("\n", errors));
        return (asm!, TestSupport.Render(result.Files));
    }

    /// <summary>Reads `Rule` off the generated DomainInvariantViolationException (type unknown at compile time).</summary>
    private static string RuleOf(TargetInvocationException ex)
    {
        var inner = ex.InnerException!;
        inner.GetType().Name.ShouldBe("DomainInvariantViolationException");
        return (string)inner.GetType().GetProperty("Rule")!.GetValue(inner)!;
    }

    private const string AndSrc = """
        context Test {
          value Score {
            value: Int
            invariant value >= 0 && value <= 100
          }
        }
        """;

    [Fact]
    public void Unmessaged_And_invariant_synthesizes_the_grammar_operator_in_the_emitted_rule()
    {
        var (_, files) = Compile(AndSrc);

        // The emitted guard must quote back text the user could actually have WRITTEN.
        files.ShouldContain("value >= 0 && value <= 100");
        files.ShouldNotContain("value >= 0 and value <= 100");
    }

    [Fact]
    public void Unmessaged_And_invariant_surfaces_the_grammar_operator_at_runtime()
    {
        var (asm, _) = Compile(AndSrc);
        var score = asm.GetType("Test.Score")!;

        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(score, 150));

        // The identifier renders in KOINE spelling (`value`), not the emitted C# property (`Value`).
        RuleOf(ex).ShouldBe("value >= 0 && value <= 100");
    }

    private const string OrSrc = """
        context Test {
          value Bound {
            value: Int
            invariant value < 0 || value > 100
          }
        }
        """;

    [Fact]
    public void Unmessaged_Or_invariant_synthesizes_the_grammar_operator()
    {
        var (asm, files) = Compile(OrSrc);
        files.ShouldContain("value < 0 || value > 100");
        files.ShouldNotContain("value < 0 or value > 100");

        var bound = asm.GetType("Test.Bound")!;
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(bound, 50));
        RuleOf(ex).ShouldBe("value < 0 || value > 100");
    }

    [Fact]
    public void Unmessaged_mixed_And_Or_invariant_renders_both_grammar_operators()
    {
        // Nested/mixed precedence — the renderer must not fall back to English words for either op.
        var (asm, files) = Compile("""
            context Test {
              value Ticket {
                amount: Int
                kind: String
                invariant amount > 0 && kind == "A" || kind == "B"
              }
            }
            """);

        files.ShouldContain("&&");
        files.ShouldContain("||");

        var ticket = asm.GetType("Test.Ticket")!;
        var ex = Should.Throw<TargetInvocationException>(() => Activator.CreateInstance(ticket, 0, "C"));
        var rule = RuleOf(ex);
        rule.ShouldContain("&&");
        rule.ShouldContain("||");
        rule.ShouldNotContain(" and ");
        rule.ShouldNotContain(" or ");
    }

    private const string RequiresSrc = """
        context Test {
          entity Account identified by AccountId {
            balance: Int
            frozen: Bool

            command withdraw(amount: Int) {
              requires amount > 0 && frozen == false
              balance -> balance - amount
            }
          }
        }
        """;

    [Fact]
    public void Unmessaged_requires_precondition_synthesizes_the_grammar_operator()
    {
        var (asm, files) = Compile(RequiresSrc);
        files.ShouldContain("amount > 0 && frozen == false");
        files.ShouldNotContain("amount > 0 and frozen == false");

        var account = asm.GetType("Test.Account")!;
        var accountId = asm.GetType("Test.AccountId")!;
        var id = accountId.GetMethod("New")!.Invoke(null, null);
        var a = Activator.CreateInstance(account, id, 100, true)!; // frozen: violates precondition

        var ex = Should.Throw<TargetInvocationException>(() => account.GetMethod("Withdraw")!.Invoke(a, [10]));
        RuleOf(ex).ShouldBe("amount > 0 && frozen == false");
    }
}
