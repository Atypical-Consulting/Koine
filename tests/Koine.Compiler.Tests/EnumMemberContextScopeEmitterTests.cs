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

    /// <summary>
    /// Issue #1793, Task 3 — Java already carried #1771's (PR #1778) sibling-operand <c>enumHint</c>,
    /// but that only threads through binary <c>==</c>/<c>!=</c> comparisons whose OTHER operand types
    /// to an enum. This fixture's invariant compares two bare members, so neither operand can hint the
    /// other and resolution fell through to the context-blind owners list, emitting an unqualified
    /// <c>Status.Red</c> from context <c>A</c> inside <c>koine.generated.c</c>. The <c>enumHint</c>
    /// path is untouched by this fix and still wins when it resolves — <see
    /// cref="JavaEnumMemberDisambiguationTests"/> pins that.
    /// </summary>
    [Fact]
    public void Java_qualifies_both_operands_against_the_referencing_contexts_own_enum()
    {
        var result = new KoineCompiler().Compile(CrossContextCollision, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.java", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Flag.Red");
        item.ShouldContain("Flag.Blue");
        item.ShouldNotContain("Marker.");
        item.ShouldNotContain("Signal.");
        item.ShouldNotContain("Status.");

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable javac toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// Issue #1797, the emitter half. #1739 scoped the owner list to enums declared in or imported into
    /// the referencing context, missing R13.2's third way to name a foreign type — an explicit
    /// <c>Context.Type</c> qualifier. The VALIDATOR symptom was a false <c>KOI0210</c>, which is what made
    /// this model unreachable at emit time; all seven translators re-resolve the same bare identifier
    /// through the same <see cref="Koine.Compiler.Ast.ModelIndex.EnumsDeclaring(string?, string)"/>
    /// overload, so they carried the identical blind spot latently.
    ///
    /// <para>Pre-fix, <c>EnumsDeclaring("C", "Active")</c> returned just <c>["Flag"]</c> — a SINGLE owner,
    /// so every translator's <c>owners.Count == 1</c> shortcut fired and confidently emitted the local
    /// <c>Flag.Active</c> for a field typed <c>Other.Kind</c>: silently wrong code on all seven targets,
    /// with no diagnostic once the validator let it through. Post-fix the qualified owner is back in the
    /// list and the sibling-operand hint picks <c>Kind</c>.</para>
    /// </summary>
    [Fact]
    public void Every_target_resolves_a_bare_member_to_the_explicitly_qualified_owner()
    {
        const string source = """
            context Other {
              enum Kind { Active, Idle }
            }

            context C {
              enum Flag { Active, Blue }
              entity Item identified by ItemId {
                kind: Other.Kind
                invariant kind == Active "hint must survive context scoping"
              }
            }
            """;

        // (emitter, file the invariant lands in, the owner that must win, the local owner that must not).
        // Forbidden is null for Rust alone: it emits the whole `C` context as ONE module, so `c.rs` also
        // holds Flag's own declaration and its from_str/from_i32 match arms — `Flag::Active` legitimately
        // appears there. The positive assertion still discriminates: pre-fix the owner list was ["Flag"],
        // so the invariant read `Flag::Active` and `Kind::Active` was absent from the file entirely.
        (IEmitter Emitter, string File, string Expected, string? Forbidden)[] targets =
        [
            (new CSharpEmitter(), "Item.cs", "Kind.Active", "Flag.Active"),
            (new TypeScriptEmitter(), "Item.ts", "Kind.Active", "Flag.Active"),
            (new PythonEmitter(), "item.py", "Kind.ACTIVE", "Flag.ACTIVE"),
            (new PhpEmitter(), "Item.php", "Kind::ACTIVE", "Flag::ACTIVE"),
            (new RustEmitter(), "c.rs", "Kind::Active", null),
            (new JavaEmitter(), "Item.java", "Kind.Active", "Flag.Active"),
            (new KotlinEmitter(), "Item.kt", "Kind.Active", "Flag.Active"),
        ];

        foreach ((IEmitter emitter, var file, var expected, var forbidden) in targets)
        {
            var result = new KoineCompiler().Compile(source, emitter);
            result.Success.ShouldBeTrue($"{file}: " + string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

            var contents = result.Files
                .Single(f => f.RelativePath.EndsWith(file, StringComparison.OrdinalIgnoreCase)).Contents;
            contents.ShouldContain(expected, customMessage: $"{file} should resolve the bare member to the qualified owner");
            if (forbidden is not null)
            {
                contents.ShouldNotContain(forbidden, customMessage: $"{file} must not resolve it to the local same-named enum");
            }
        }

        // Deliberately NOT toolchain-compiled. C#/Java/Kotlin render the (correct) owner as a BARE simple
        // name with no using/import, so a cross-context enum reference doesn't resolve in those three
        // targets — a SEPARATE, pre-existing defect tracked as #1799, reachable on main today via this
        // model's collision-free control variant and therefore neither caused nor widened by #1797.
        // TypeScript/Python/PHP/Rust already qualify correctly. Once #1799 lands, add the compile checks.
    }
}
