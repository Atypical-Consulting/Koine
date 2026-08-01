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

        // Syntax-only (php -l), not TestSupport.TypeCheckPhp/phpstan: the fixture's invariant
        // deliberately compares two literal enum cases with no other-operand hint available (the exact
        // shape that exercises this fix's fallback branch) — phpstan's strict `identical.alwaysFalse`
        // rule correctly, but irrelevantly, flags THAT as dead code regardless of which enum ends up
        // qualifying it. Real-world code hitting this bug compares a runtime FIELD against a bare
        // member (e.g. `status == Active`), which phpstan cannot fold — this fixture isolates the
        // no-hint code path deliberately, at the cost of being unrepresentative of realistic PHP.
        var check = TestSupport.SyntaxCheckPhp(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable php toolchain available; skipping.");
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

    /// <summary>
    /// Issue #1793, Task 1 — the most severe of the three remaining targets: pre-fix, Rust emitted
    /// <c>if !(crate::a::Status::Red != Flag::Blue)</c>, and <c>cargo check</c> rejected the crate
    /// outright with <c>error[E0308]: mismatched types … expected `Status`, found `Flag`</c>. The
    /// <c>CompileRust</c> meta-test below is what makes this a real regression guard rather than a
    /// string assertion: a wrong qualifier here does not type-check.
    /// </summary>
    [Fact]
    public void Rust_qualifies_both_operands_against_the_referencing_contexts_own_enum()
    {
        var result = new KoineCompiler().Compile(CrossContextCollision, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Rust emits one module per bounded context, so `C`'s entity lives in `src/c.rs`.
        var module = result.Files.Single(f => f.RelativePath.EndsWith("c.rs", StringComparison.Ordinal)).Contents;
        module.ShouldContain("Flag::Red");
        module.ShouldContain("Flag::Blue");
        module.ShouldNotContain("Marker::");
        module.ShouldNotContain("Signal::");
        module.ShouldNotContain("Status::");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable cargo toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1793, Task 2 — pre-fix, Python emitted <c>if not (Status.RED != Flag.BLUE)</c> plus a
    /// matching <c>from a.enums.status import Status</c>, i.e. importable, runnable, silently wrong
    /// code: the guard compares an unrelated context's enum member and can therefore never hold.
    /// </summary>
    [Fact]
    public void Python_qualifies_both_operands_against_the_referencing_contexts_own_enum()
    {
        var result = new KoineCompiler().Compile(CrossContextCollision, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("item.py", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Flag.RED");
        item.ShouldContain("Flag.BLUE");
        item.ShouldNotContain("Marker.");
        item.ShouldNotContain("Signal.");
        item.ShouldNotContain("Status.");
        // The wrong qualifier also dragged in an import of the wrong context's enum module; a
        // correctly scoped resolution leaves `C`'s entity with no dependency on `A`/`D`/`E` at all.
        item.ShouldNotContain("from a.enums");
        item.ShouldNotContain("from d.enums");
        item.ShouldNotContain("from e.enums");

        // Syntax-only (`python -m py_compile`), not TestSupport.TypeCheckPython/mypy, for exactly the
        // reason the PHP sibling above uses `php -l`: the fixture's invariant deliberately compares two
        // literal enum members with no other-operand hint (the shape that exercises this fix's fallback
        // branch), and mypy's `comparison-overlap` rule correctly — but irrelevantly — rejects THAT as a
        // non-overlapping equality check regardless of which enum qualifies it, both before and after
        // the fix. Real-world code hitting this bug compares a runtime FIELD against a bare member
        // (e.g. `status == Active`), which mypy cannot fold; this fixture isolates the no-hint path
        // deliberately, at the cost of being unrepresentative of realistic Python.
        var check = TestSupport.SyntaxCheckPython(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable python toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
