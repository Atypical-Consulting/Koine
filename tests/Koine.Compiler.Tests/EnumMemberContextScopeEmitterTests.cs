using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Issue #1739, Task 4: the four bare-enum-member qualifier resolutions
/// (<c>CSharpExpressionTranslator</c>, <c>TypeScriptExpressionTranslator</c>,
/// <c>PhpExpressionTranslator</c>, <c>KotlinExpressionTranslator</c>) all resolved owners via the
/// context-blind <see cref="Koine.Compiler.Ast.ModelIndex.EnumsDeclaring(string)"/>, exactly like
/// <c>ExpressionChecker</c> before Task 3. Task 2/3 already fixed the VALIDATOR side — this model
/// compiles clean (no <c>KOI0213</c>/<c>KOI0210</c>) — but pre-Task-4 the EMITTER independently
/// re-resolves the same bare identifiers and, with no context scoping, still picks whichever enum's
/// member happened to be declared LAST in the file (<c>Marker</c>/<c>Signal</c> — two enums with no
/// relationship to this code at all) instead of <c>C</c>'s own <c>Flag</c>. The invariant form (rather
/// than a value-object member default) sidesteps an unrelated, pre-existing C# constraint — a smart
/// enum comparison isn't a compile-time constant, so it can't be a default PARAMETER value — while
/// still exercising the exact same bare-identifier qualifier resolution inside the generated
/// invariant guard.
/// </summary>
public class EnumMemberContextScopeEmitterTests
{
    private const string CrossContextCollision = """
        context A {
          enum Status { Red }
        }

        context C {
          enum Flag { Red, Blue }
          entity Item identified by ItemId {
            tag: Flag = Red
            invariant Red != Blue "sanity check with no declared-type hint"
          }
        }

        context D {
          enum Marker { Red }
        }

        context E {
          enum Signal { Blue }
        }
        """;

    [Fact]
    public void CSharp_qualifies_both_operands_against_the_referencing_contexts_own_enum()
    {
        var result = new KoineCompiler().Compile(CrossContextCollision, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.cs", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Flag.Red");
        item.ShouldContain("Flag.Blue");
        item.ShouldNotContain("Marker.");
        item.ShouldNotContain("Signal.");
        item.ShouldNotContain("Status.");

        (System.Reflection.Assembly? assembly, IReadOnlyList<string> errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void TypeScript_qualifies_both_operands_against_the_referencing_contexts_own_enum()
    {
        var result = new KoineCompiler().Compile(CrossContextCollision, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("item.ts", StringComparison.OrdinalIgnoreCase)).Contents;
        item.ShouldContain("Flag.Red");
        item.ShouldContain("Flag.Blue");
        item.ShouldNotContain("Marker.");
        item.ShouldNotContain("Signal.");
        item.ShouldNotContain("Status.");

        var check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable tsc toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Php_qualifies_both_operands_against_the_referencing_contexts_own_enum()
    {
        var result = new KoineCompiler().Compile(CrossContextCollision, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.php", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Flag::RED");
        item.ShouldContain("Flag::BLUE");
        item.ShouldNotContain("Marker::");
        item.ShouldNotContain("Signal::");
        item.ShouldNotContain("Status::");

        var check = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable phpstan/php toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Kotlin_qualifies_both_operands_against_the_referencing_contexts_own_enum()
    {
        var result = new KoineCompiler().Compile(CrossContextCollision, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.kt", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Flag.Red");
        item.ShouldContain("Flag.Blue");
        item.ShouldNotContain("Marker.");
        item.ShouldNotContain("Signal.");
        item.ShouldNotContain("Status.");

        var check = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable kotlinc toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
