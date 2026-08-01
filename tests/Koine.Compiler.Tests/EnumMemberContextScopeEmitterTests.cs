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
    /// Issue #1802 — the sibling of <see cref="CrossContextQualifiedEnum"/>: the modeller writes the
    /// enum-TYPE qualifier explicitly (<c>Kind.Active</c>) rather than leaving it bare. #1799 fixed the
    /// bare-member branch, which resolves an owner via <c>ModelIndex.EnumsDeclaring(context, member)</c>;
    /// an explicit <c>Kind.Active</c> never reaches that branch — <c>Kind</c> is a TYPE name, not a
    /// member name, so <c>EnumsDeclaring</c> returns empty and control falls through to each
    /// translator's separate enum-<em>type</em>-identifier branch, which appended the simple name
    /// verbatim with no namespace/package qualification.
    /// </summary>
    private const string CrossContextExplicitEnumQualifier = """
        context Other {
          enum Kind { Active, Idle }
        }

        context C {
          entity Item identified by ItemId {
            status: Other.Kind
            invariant status == Kind.Active "explicit enum-type qualifier on a foreign enum"
          }
        }
        """;

    [Fact]
    public void CSharp_namespace_qualifies_an_explicitly_typed_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextExplicitEnumQualifier, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.cs", StringComparison.Ordinal)).Contents;
        item.ShouldContain("Other.Kind.Active");

        (System.Reflection.Assembly? assembly, IReadOnlyList<string> errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Java_package_qualifies_an_explicitly_typed_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextExplicitEnumQualifier, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.java", StringComparison.Ordinal)).Contents;
        item.ShouldContain("koine.generated.other.Kind.Active");

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable javac toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Kotlin_package_qualifies_an_explicitly_typed_enum_member_owned_by_another_context()
    {
        var result = new KoineCompiler().Compile(CrossContextExplicitEnumQualifier, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var item = result.Files.Single(f => f.RelativePath.EndsWith("Item.kt", StringComparison.Ordinal)).Contents;
        item.ShouldContain("koine.generated.other.Kind.Active");

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

    /// <summary>
    /// Issue #1797's model, shared by the seven-target string assertions and the three toolchain-compile
    /// facts that follow them. <c>C</c> declares its OWN <c>Active</c> on <c>Flag</c>, so the bare
    /// <c>Active</c> in the invariant is ambiguous on name alone; only the explicit <c>Other.Kind</c>
    /// qualifier on the member's declared type tells the compiler which one is meant.
    /// </summary>
    private const string ExplicitlyQualifiedCollision = """
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
        const string source = ExplicitlyQualifiedCollision;

        // (emitter, file the invariant lands in, the owner that must win, the local owner that must not).
        // Expected is the FULLY qualified spelling for C#/Java/Kotlin: #1799 landed the emitter half, so
        // the owner these three name is no longer merely the right enum but one the toolchain can
        // actually resolve. The bare `Kind.Active` this row originally asserted still *substring*-matches
        // the qualified form, so tightening it is what keeps the row honest about which defect it pins.
        //
        // Forbidden is null for Rust alone: it emits the whole `C` context as ONE module, so `c.rs` also
        // holds Flag's own declaration and its from_str/from_i32 match arms — `Flag::Active` legitimately
        // appears there. The positive assertion still discriminates: pre-fix the owner list was ["Flag"],
        // so the invariant read `Flag::Active` and `Kind::Active` was absent from the file entirely.
        (IEmitter Emitter, string File, string Expected, string? Forbidden)[] targets =
        [
            (new CSharpEmitter(), "Item.cs", "Other.Kind.Active", "Flag.Active"),
            (new TypeScriptEmitter(), "Item.ts", "Kind.Active", "Flag.Active"),
            (new PythonEmitter(), "item.py", "Kind.ACTIVE", "Flag.ACTIVE"),
            (new PhpEmitter(), "Item.php", "Kind::ACTIVE", "Flag::ACTIVE"),
            (new RustEmitter(), "c.rs", "crate::other::Kind::Active", null),
            (new JavaEmitter(), "Item.java", "koine.generated.other.Kind.Active", "Flag.Active"),
            (new KotlinEmitter(), "Item.kt", "koine.generated.other.Kind.Active", "Flag.Active"),
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

        // The compile checks this test deferred to #1799 live in the three `..._compiles_the_collision_model`
        // facts below rather than inline here, deliberately: `RequireOrSkip` aborts the WHOLE test on the
        // first absent toolchain, so folding seven gates into this one loop would let a missing mypy or
        // phpstan skip the six string assertions above with it — silently deleting the coverage #1797
        // added. One fact per target keeps each toolchain's absence scoped to its own row.
    }

    /// <summary>
    /// Issue #1799 closing the loop on #1797's deferred compile checks, for the three targets whose
    /// rendering it fixed. This is the model where BOTH halves are load-bearing: #1797 (PR #1798) is what
    /// puts the explicitly-qualified <c>Other.Kind</c> back in the owner list so the bare <c>Active</c>
    /// resolves to it rather than the local <c>Flag</c>, and #1799 is what then spells that owner so the
    /// toolchain can find it. Either half alone leaves this model broken — silently wrong code without
    /// the first, non-compiling code without the second — which is exactly what a string assertion cannot
    /// see and a real compile can.
    /// </summary>
    [Fact]
    public void CSharp_compiles_the_collision_model_resolved_to_the_explicitly_qualified_owner()
    {
        var result = new KoineCompiler().Compile(ExplicitlyQualifiedCollision, new CSharpEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        (System.Reflection.Assembly? assembly, IReadOnlyList<string> errors) = TestSupport.Compile(result.Files);
        assembly.ShouldNotBeNull(string.Join("\n", errors));
    }

    [Fact]
    public void Java_compiles_the_collision_model_resolved_to_the_explicitly_qualified_owner()
    {
        var result = new KoineCompiler().Compile(ExplicitlyQualifiedCollision, new JavaEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileJava(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable javac toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }

    [Fact]
    public void Kotlin_compiles_the_collision_model_resolved_to_the_explicitly_qualified_owner()
    {
        var result = new KoineCompiler().Compile(ExplicitlyQualifiedCollision, new KotlinEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var check = TestSupport.CompileKotlin(result.Files);
        TestSupport.RequireOrSkip(check.ToolchainAvailable, "No usable kotlinc toolchain available; skipping.");
        check.Ok.ShouldBeTrue(string.Join("\n", check.Errors));
    }
}
