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

    /// <summary>
    /// Issue #1799 — the *control* model: unambiguous, so owner SELECTION (the #1739/#1793/#1797 axis)
    /// is already right and untouched here. What is wrong is the owner's RENDERING: <c>Kind</c> is owned
    /// by context <c>Other</c>, the reference sits in context <c>C</c>, and C#/Java/Kotlin appended the
    /// enum's *simple* name straight into the buffer with no namespace/package qualification and no
    /// import — so the emitted artifact does not compile. The declared member type
    /// (<c>Other.Kind</c> / <c>koine.generated.other.Kind</c>) is routed through each emitter's type
    /// mapper and has always been correct; only the expression path bypassed it.
    /// </summary>
    private const string CrossContextQualifiedEnum = """
        context Other {
          enum Kind { Active, Idle }
        }

        context C {
          enum Flag { Green, Blue }
          entity Item identified by ItemId {
            status: Other.Kind
            previous: Other.Kind
            invariant status == Active "cross-context enum reference"
            invariant previous != Idle "a second cross-context member of the same foreign enum"
          }
        }
        """;

    /// <summary>
    /// Issue #1799, the collection form the spec calls out: a lambda body over a
    /// <c>List&lt;Other.Kind&gt;</c> re-enters the same bare-identifier path from a nested scope, where
    /// the enclosing member scope no longer supplies the reference. Exercised for the three targets
    /// this issue fixes only — Rust rejects <c>kinds.iter().all(|k| k != …)</c> with
    /// <c>E0277: can't compare `&amp;Kind` with `Kind`</c> (a missing deref in the lambda binder), which
    /// reproduces identically for a SAME-context enum and is therefore a pre-existing defect unrelated
    /// to owner qualification; it is tracked separately rather than fixed or masked here.
    /// </summary>
    private const string CrossContextQualifiedEnumInLambda = """
        context Other {
          enum Kind { Active, Idle }
        }

        context C {
          entity Item identified by ItemId {
            kinds: List<Other.Kind>
            invariant kinds.all(k => k != Idle) "cross-context enum reference inside a lambda"
          }
        }
        """;

    /// <summary>
    /// Issue #1799, the C#-specific aggravated form: the member is named <c>kind</c>, so the emitted
    /// property is <c>Kind</c> — the same identifier as the enum type. A bare <c>Kind.Active</c> then
    /// binds to the PROPERTY rather than failing to resolve, and Roslyn reports
    /// <c>CS0176: Member 'Kind.Active' cannot be accessed with an instance reference</c> instead of
    /// <c>CS0103</c>. This is why the fix must emit a genuinely namespace-qualified reference rather
    /// than lean on C#'s "Color Color" rule or an added <c>using</c>.
    /// </summary>
    private const string CrossContextQualifiedEnumShadowingProperty = """
        context Other {
          enum Kind { Active, Idle }
        }

        context C {
          entity Item identified by ItemId {
            kind: Other.Kind
            invariant kind == Active "cross-context enum reference shadowed by a same-named property"
          }
        }
        """;

    [Fact]
    public void CSharp_namespace_qualifies_a_bare_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnum, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.cs", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Other.Kind.Active");
        item.ShouldContain("Other.Kind.Idle");

        (System.Reflection.Assembly? assembly, IReadOnlyList<string> errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void CSharp_namespace_qualifies_a_bare_enum_member_shadowed_by_a_same_named_property()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnumShadowingProperty, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.cs", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Other.Kind.Active");

        (System.Reflection.Assembly? assembly, IReadOnlyList<string> errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Java_package_qualifies_a_bare_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnum, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.java", StringComparison.Ordinal)).Contents;
        item.ShouldContain("koine.generated.other.Kind.Active");
        item.ShouldContain("koine.generated.other.Kind.Idle");

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable javac toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Kotlin_package_qualifies_a_bare_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnum, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.kt", StringComparison.Ordinal)).Contents;
        item.ShouldContain("koine.generated.other.Kind.Active");
        item.ShouldContain("koine.generated.other.Kind.Idle");

        var check = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable kotlinc toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void CSharp_namespace_qualifies_a_bare_enum_member_inside_a_lambda()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnumInLambda, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.cs", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Other.Kind.Idle");

        (System.Reflection.Assembly? assembly, IReadOnlyList<string> errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Java_package_qualifies_a_bare_enum_member_inside_a_lambda()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnumInLambda, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.java", StringComparison.Ordinal)).Contents;
        item.ShouldContain("koine.generated.other.Kind.Idle");

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable javac toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Kotlin_package_qualifies_a_bare_enum_member_inside_a_lambda()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnumInLambda, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.kt", StringComparison.Ordinal)).Contents;
        item.ShouldContain("koine.generated.other.Kind.Idle");

        var check = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable kotlinc toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    /// <summary>
    /// The four targets the issue's audit found already correct — each routes the enum through its own
    /// import/qualification machinery. Pinned here so the C#/Java/Kotlin fix can't silently churn them:
    /// unlike the C#-family fixtures above, this fixture compares a runtime FIELD against a bare member,
    /// which mypy/phpstan cannot constant-fold, so the full type-checkers apply rather than the
    /// syntax-only fallbacks the sibling <c>CrossContextCollision</c> tests need.
    /// </summary>
    [Fact]
    public void TypeScript_imports_a_bare_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnum, new TypeScriptEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("item.ts", StringComparison.OrdinalIgnoreCase)).Contents;
        item.ShouldContain("Kind.Active");
        item.ShouldContain("Kind.Idle");
        item.ShouldContain("from '../../Other/enums/Kind'");

        var check = TestSupport.TypeCheckTypeScript(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable tsc toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Python_imports_a_bare_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnum, new PythonEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("item.py", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Kind.ACTIVE");
        item.ShouldContain("Kind.IDLE");
        item.ShouldContain("from other.enums.kind import Kind");

        var check = TestSupport.TypeCheckPython(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable python toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Php_imports_a_bare_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnum, new PhpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.php", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Kind::ACTIVE");
        item.ShouldContain("Kind::IDLE");
        item.ShouldContain(@"use Koine\Other\Enums\Kind;");

        var check = TestSupport.TypeCheckPhp(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable php toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Rust_path_qualifies_a_bare_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextQualifiedEnum, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var module = result.Files.Single(f => f.RelativePath.EndsWith("c.rs", StringComparison.Ordinal)).Contents;
        module.ShouldContain("crate::other::Kind::Active");
        module.ShouldContain("crate::other::Kind::Idle");

        var check = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable cargo toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

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
}
