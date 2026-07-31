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
}
