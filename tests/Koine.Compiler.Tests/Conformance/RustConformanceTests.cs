using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests.Conformance;

/// <summary>
/// Conformance harness for the Rust backend (issue #24, Task 2). It exercises the
/// <see cref="TestSupport.CompileRust"/> plumbing — write emitted <c>.rs</c> into a temp crate and run
/// <c>cargo check</c> — so it is ready to validate the Rust emitter as it lands. When no usable
/// <c>cargo</c> toolchain is present (absent, or present-but-offline so crate dependencies can't be
/// fetched) the compile is funneled through <see cref="TestSupport.RequireOrSkip"/>, which reports the
/// test as <c>Skipped</c> (not a false Passed) — keeping <c>dotnet test</c> green without a networked
/// Rust toolchain while surfacing the gap. It NEVER silently passes a real error: a real error is only
/// assertable when <c>cargo</c> is usable, and then it IS asserted. CI sets
/// <c>KOINE_REQUIRE_CONFORMANCE</c> and installs the toolchain, so a missing one there is a hard
/// <c>Failed</c> rather than a silent skip.
/// </summary>
public class RustConformanceTests
{
    private const string NoToolchainNotice =
        "No usable Rust toolchain (cargo, networked) available; compile not run. " +
        "Install Rust (or set KOINE_CARGO) — CI runs this for real.";

    /// <summary>A well-formed, dependency-free crate must compile (skipped if no toolchain).</summary>
    [Fact]
    public void Harness_accepts_well_formed_rust()
    {
        var files = new[]
        {
            new EmittedFile("src/lib.rs", "pub fn f(x: i64) -> i64 {\n    x + 1\n}\n"),
        };

        var r = TestSupport.CompileRust(files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// A real compile error must be reported, not silently swallowed — this proves the harness is a
    /// genuine check (the analogue of the Python/TypeScript negative fixtures).
    /// </summary>
    [Fact]
    public void Harness_rejects_ill_formed_rust()
    {
        var files = new[]
        {
            // Returns a &str from a function annotated to return i64 → a real rustc type error.
            new EmittedFile("src/lib.rs", "pub fn f(x: i64) -> i64 {\n    \"nope\"\n}\n"),
        };

        var r = TestSupport.CompileRust(files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeFalse();
        r.Errors.ShouldNotBeEmpty();
    }

    /// <summary>
    /// The outcome contract <see cref="TestSupport.RequireOrSkip"/> relies on: a missing toolchain
    /// yields a <see cref="TestSupport.RustCheck.Skipped"/> result whose <c>ToolchainAvailable</c> and
    /// <c>Ok</c> are both <c>false</c> — so it can never be mistaken for a real pass.
    /// </summary>
    [Fact]
    public void Skipped_result_does_not_claim_success()
    {
        TestSupport.RustCheck skipped = TestSupport.RustCheck.Skipped;
        skipped.ToolchainAvailable.ShouldBeFalse();
        skipped.Ok.ShouldBeFalse();
    }

    /// <summary>
    /// Int-led chained mixed concatenation must emit compiling Rust (issue #837, follows up #819).
    /// <c>display: String = hours + ":" + minutes</c> (<c>hours</c>, <c>minutes</c> both <c>Int</c>)
    /// is a left-associative chain where the inner join <c>hours + ":"</c> produces a <c>String</c>,
    /// and the outer join appends <c>minutes</c> (an <c>Int</c>) on the right.
    /// <see cref="RustExpressionTranslator"/> must stringify the non-<c>String</c> right operand,
    /// emitting <c>(self.hours.to_string() + ":") + &amp;self.minutes.to_string()</c>
    /// (<c>String + &amp;String</c>, which coerces to <c>&amp;str</c>) rather than the invalid
    /// <c>String + &amp;i64</c> that <c>cargo check</c> would reject.
    /// Mirrors the PHP fixture added in PR #819. Skipped (not failed) when no Rust toolchain is
    /// present; CI installs the toolchain and runs it for real.
    /// </summary>
    [Fact]
    public void Int_led_chained_mixed_concatenation_emits_compiling_rust()
    {
        const string src =
            "context Scheduling {\n" +
            "  value TimeOfDay {\n" +
            "    hours: Int\n" +
            "    minutes: Int\n" +
            // Int-led chain: (hours + ":") + minutes — the outer join's right operand is non-String.
            "    display: String = hours + \":\" + minutes\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the non-String right operand of the outer
        // join must be stringified. Assert the emitted accessor uses `.to_string()` on `minutes`
        // and does NOT emit the bare `&self.minutes)` that caused `String + &i64` (E0369).
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.minutes.to_string()");
        rust.ShouldNotContain("+ &self.minutes)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #938 cross-target parity: Rust already truncates an <c>Int</c> field's scalar divide toward
    /// zero for free — <c>ScaleField</c> emits the bare native <c>self.grams / divisor</c> (both
    /// <c>i64</c>), and Rust's integer division truncates toward zero by definition, with no
    /// <c>dec_to_i64</c> coercion involved (that path is only for a Decimal-typed operand). No emitter
    /// change was needed; this pins the rendering so it can't silently regress while the TypeScript
    /// emitter is being brought into line (the same issue's actual fix).
    /// </summary>
    [Fact]
    public void Int_field_scalar_divide_uses_native_truncating_division()
    {
        const string src =
            "context Shop {\n" +
            "  value Weight {\n" +
            "    grams: Int\n" +
            "  }\n" +
            "  value Box {\n" +
            "    total: Weight\n" +
            "    half: Weight = total / 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.grams / divisor");
        // Only the Decimal-operand coercion path routes through dec_to_i64 (crate::koine_runtime's own
        // definition of the helper aside) — an Int field scaled by an Int scalar never should.
        rust.ShouldNotContain("dec_to_i64(self.grams");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #887: a plain (non-quantity) value object used directly in binary arithmetic —
    /// <c>combined: Money = base + base</c> / <c>diff: Money = base - base</c> — must emit real
    /// <c>impl std::ops::Add</c> / <c>impl std::ops::Sub</c> so the native <c>+</c>/<c>-</c> the
    /// translator lowers to resolve. Before the fix the value-object writer only generated <c>Add</c>
    /// (and only when the VO was <c>sum</c>-folded), so <c>base - base</c> had no <c>Sub</c> impl — a
    /// real <c>cargo check</c> failure (E0369). Brings Rust to parity with C#/TypeScript/Python (#834)
    /// and PHP.
    /// </summary>
    [Fact]
    public void Value_object_plain_arithmetic_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    combined: Money = base + base\n" +
            "    diff: Money = base - base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): both operator impls must be rendered.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Add for Money");
        rust.ShouldContain("impl std::ops::Sub for Money");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #887 — the demand-gating must be genuinely two-way: a value object used ONLY in a plain
    /// <c>base - base</c> (never summed, never used in a plain <c>+</c>) must get <c>Sub</c> but NOT a
    /// spurious <c>Add</c>. Without this negative fixture, a swapped <c>BinaryOp.Add</c>/<c>BinaryOp.Sub</c>
    /// check in the emitter's demand-gating would slip through undetected, since the sibling positive test
    /// exercises a value object that needs both operators together.
    /// </summary>
    [Fact]
    public void Value_object_used_only_in_subtraction_does_not_emit_add()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    diff: Money = base - base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Sub for Money");
        rust.ShouldNotContain("impl std::ops::Add for Money");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1068: a <c>quantity</c> value object used directly in plain binary arithmetic —
    /// <c>combined: Weight = base + base</c> — must lower through its existing unit-checked
    /// <c>add</c>/<c>sub</c> methods, not the native <c>+</c>/<c>-</c> operator. Unlike a plain value
    /// object (#887), a <c>quantity</c> never gets an <c>impl std::ops::Add</c>/<c>Sub</c> — only the
    /// inherent, <c>Result</c>-returning methods <c>WriteQuantityOps</c> emits — so the native operator
    /// the translator previously emitted unconditionally referenced an impl that was never generated
    /// (a real <c>cargo check</c> E0369). Predates #887; #887 only touches the non-quantity branch.
    /// </summary>
    [Fact]
    public void Quantity_plain_arithmetic_routes_through_unit_checked_methods()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "    invariant amount >= 0 \"a weight cannot be negative\"\n" +
            "  }\n" +
            "  value Box {\n" +
            "    base: Weight\n" +
            "    combined: Weight = base + base\n" +
            "    diff: Weight = base - base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the native operator must NOT be emitted for a
        // quantity operand, and the unit-checked methods must be used instead.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldNotContain("self.base.clone() + self.base.clone()");
        rust.ShouldNotContain("self.base.clone() - self.base.clone()");
        rust.ShouldContain("self.base.add(&self.base).expect(\"Weight: unit mismatch\")");
        rust.ShouldContain("self.base.sub(&self.base).expect(\"Weight: unit mismatch\")");
        rust.ShouldNotContain("impl std::ops::Add for Weight");
        rust.ShouldNotContain("impl std::ops::Sub for Weight");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1268, follow-up of #1068's Add/Sub fix: a <c>quantity</c>'s unit-checked <c>+</c>/<c>-</c>
    /// must compile via a real <c>cargo check</c> when an operand is a compound (non-place) expression
    /// such as a conditional, not just a bare identifier/field access. The #1068 guard wrote a
    /// conditional operand's branches as bare place expressions (<c>self.a</c>/<c>self.b</c>) with no
    /// borrow/clone, so the generated <c>if</c>/<c>else</c> tried to move a non-<c>Copy</c> field out of
    /// <c>&amp;self</c> — a real E0507.
    /// </summary>
    [Fact]
    public void Quantity_addition_with_conditional_operand_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "  }\n" +
            "  value Mix {\n" +
            "    a: Weight\n" +
            "    b: Weight\n" +
            "    flag: Bool\n" +
            "    combined: Weight = (if flag then a else b) + a\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): a conditional branch that yields a non-Copy
        // field must be cloned, never emitted as a bare, un-borrowed place headed into the if/else.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.a.clone()");
        rust.ShouldContain("self.b.clone()");
        rust.ShouldNotContain("{ self.a }");
        rust.ShouldNotContain("{ self.b }");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1268 — the same E0507 class reproduces on the <c>-</c> half of the guard, on the RIGHT
    /// (argument) operand rather than the left (receiver), and for a <c>let…in</c> operand whose body is
    /// a bare non-Copy place — the #1068 guard's original repro (<c>base + base</c>) never exercised any
    /// of these shapes. <c>WriteQuantityOperand</c> routes both operands identically and
    /// <c>WriteOwnedOperand</c> recurses into a <c>let</c> binding's body, so all three must compile via a
    /// real <c>cargo check</c>.
    /// </summary>
    [Fact]
    public void Quantity_subtraction_with_conditional_right_operand_and_let_operand_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "  }\n" +
            "  value Mix {\n" +
            "    a: Weight\n" +
            "    b: Weight\n" +
            "    flag: Bool\n" +
            "    subRight: Weight = a - (if flag then a else b)\n" +
            "    letOperand: Weight = (let x = a in x) - b\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.a.clone()");
        rust.ShouldContain("self.b.clone()");
        rust.ShouldNotContain("{ let x = self.a; ");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1268 — a <c>when</c>-guarded conditional operand (<c>GuardExpr</c> wrapping a
    /// <c>ConditionalExpr</c>) is a distinct AST shape from a bare conditional; <c>WriteOwnedOperand</c>
    /// must unwrap the guard rather than falling through to the un-cloning default path.
    /// </summary>
    [Fact]
    public void Quantity_addition_with_guarded_conditional_operand_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "  }\n" +
            "  value Mix {\n" +
            "    a: Weight\n" +
            "    b: Weight\n" +
            "    c: Weight\n" +
            "    flag: Bool\n" +
            "    otherCond: Bool\n" +
            "    combined: Weight = ((if flag then a else b) when otherCond) + c\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.a.clone()");
        rust.ShouldContain("self.b.clone()");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1084, sibling of #1068's Add/Sub fix: a <c>quantity</c> value object's scalar
    /// <c>* scalar</c>/<c>/ scalar</c> — <c>scaled: Weight = base * 2</c> / <c>halved: Weight = base / 2</c>
    /// — must get real <c>impl std::ops::Mul</c>/<c>Div</c> so the native operator the translator lowers
    /// to resolves. Before the fix <c>WriteQuantityOps</c> only ever emitted the unit-checked
    /// <c>add</c>/<c>sub</c> methods for a quantity, so the native <c>*</c>/<c>/</c> the general
    /// arithmetic path emits referenced an impl that was never generated (a real <c>cargo check</c>
    /// E0369).
    /// </summary>
    [Fact]
    public void Quantity_scalar_multiply_and_divide_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "    invariant amount >= 0 \"a weight cannot be negative\"\n" +
            "  }\n" +
            "  value Box {\n" +
            "    base: Weight\n" +
            "    scaled: Weight = base * 2\n" +
            "    halved: Weight = base / 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the native operator must resolve to a real impl.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Mul<i64> for Weight");
        rust.ShouldContain("impl std::ops::Div<i64> for Weight");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1084 — the demand-gating for a quantity's scalar Mul/Div must be genuinely two-way,
    /// mirroring the plain-VO negative fixture <see cref="Value_object_used_only_in_subtraction_does_not_emit_add"/>:
    /// a quantity used ONLY in <c>* scalar</c> (never <c>/ scalar</c>) must get <c>Mul</c> but NOT a
    /// spurious <c>Div</c>. Without this, a bug that collapses the separate <c>MultiplyFactors</c>/
    /// <c>DivideFactors</c> checks into one shared gate would slip through undetected, since the sibling
    /// positive test exercises a quantity that needs both operators together.
    /// </summary>
    [Fact]
    public void Quantity_used_only_in_multiplication_does_not_emit_div()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "    invariant amount >= 0 \"a weight cannot be negative\"\n" +
            "  }\n" +
            "  value Box {\n" +
            "    base: Weight\n" +
            "    scaled: Weight = base * 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Mul<i64> for Weight");
        rust.ShouldNotContain("impl std::ops::Div<i64> for Weight");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1084 — a quantity scaled by a <c>Decimal</c> factor (not just the <c>Int</c> literal the
    /// sibling positive test uses) must also get a real <c>impl std::ops::Mul&lt;Decimal&gt;</c>/
    /// <c>Div&lt;Decimal&gt;</c>, exercising the same <c>ScalarFactors</c>/<c>ScaleField</c> path
    /// <see cref="RustSnapshotTests"/> already pins for a plain (non-quantity) value object.
    /// </summary>
    [Fact]
    public void Quantity_scalar_multiply_and_divide_by_decimal_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "    invariant amount >= 0 \"a weight cannot be negative\"\n" +
            "  }\n" +
            "  value Box {\n" +
            "    base: Weight\n" +
            "    scaled: Weight = base * 2.5\n" +
            "    halved: Weight = base / 2.5\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Mul<Decimal> for Weight");
        rust.ShouldContain("impl std::ops::Div<Decimal> for Weight");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1282, Task 1 — the general (non-quantity) arithmetic path's operand-cloning check
    /// (<c>IsNonCopyPlace</c>-gated <c>cloneLeft</c>/<c>cloneRight</c>) only recognizes a bare place, not
    /// a conditional, so a plain (non-quantity) value object's <c>+</c> with a conditional operand fails
    /// the same E0507 class the quantity guard (#1268) fixed for <c>+</c>/<c>-</c>.
    /// <para>
    /// Uses <c>+</c> rather than <c>*</c>/<c>/</c>: <c>ValueObjectArithmeticWalker</c> (which decides
    /// whether a VO needs a generated <c>Add</c>/<c>Sub</c> impl) resolves an operand's full inferred
    /// type, so it recognizes a compound (conditional) operand fine. <c>ScalarOpWalker</c> (which decides
    /// whether a VO needs a generated <c>Mul</c>/<c>Div</c> impl for a scalar factor) is deliberately
    /// shallow — it only classifies a bare identifier/literal operand — so a <c>Money * (if …)</c>-shaped
    /// case never gets its <c>impl std::ops::Mul</c> generated at all and fails with an unrelated,
    /// pre-existing E0369 ("cannot multiply") regardless of this fix. Confirmed with a real
    /// <c>cargo check</c> and filed separately (issue tracker) rather than folded into this fix, which is
    /// scoped to the clone/borrow (E0507) defect, not scalar-factor demand-detection.
    /// </para>
    /// </summary>
    [Fact]
    public void General_arithmetic_path_with_conditional_operand_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "  }\n" +
            "  value Bag {\n" +
            "    a: Money\n" +
            "    b: Money\n" +
            "    flag: Bool\n" +
            "    combined: Money = (if flag then a else b) + a\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): a conditional branch that yields a non-Copy
        // field must be cloned, never emitted as a bare, un-borrowed place headed into the if/else.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.a.clone()");
        rust.ShouldContain("self.b.clone()");
        rust.ShouldNotContain("{ self.a }");
        rust.ShouldNotContain("{ self.b }");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1282, Task 2 — a bare conditional (no arithmetic operator at all) used directly as a
    /// derived member's body has no ownership handling in <c>WriteDerived</c>: its clone check only
    /// recognizes <c>m.Initializer is IdentifierExpr or MemberAccessExpr</c>, never a
    /// <c>ConditionalExpr</c>, so <c>combined: Weight = if flag then a else b</c> emits the bare,
    /// un-cloned <c>if self.flag { self.a } else { self.b }</c> and fails a real <c>cargo check</c>
    /// E0507 — for both a <c>quantity</c> and a plain (non-quantity) value object.
    /// </summary>
    [Fact]
    public void Bare_conditional_derived_member_body_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "  }\n" +
            "  value Mix {\n" +
            "    a: Weight\n" +
            "    b: Weight\n" +
            "    flag: Bool\n" +
            "    bareConditional: Weight = if flag then a else b\n" +
            "  }\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "  }\n" +
            "  value PlainMix {\n" +
            "    a: Money\n" +
            "    b: Money\n" +
            "    flag: Bool\n" +
            "    bareConditional: Money = if flag then a else b\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): a bare conditional derived-member body must
        // clone a non-Copy branch, never leave it as a bare, un-borrowed place.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.a.clone()");
        rust.ShouldContain("self.b.clone()");
        rust.ShouldNotContain("{ self.a }");
        rust.ShouldNotContain("{ self.b }");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1282, Task 3 — a probe (confirmed with a real <c>cargo check</c>, not just static reading)
    /// for the plausible-but-unverified <c>CoalesceExpr</c>-arm gap flagged in this issue's brainstorm:
    /// <c>WriteOperandValue</c>, like the general arithmetic path and a bare conditional return, only
    /// recognizes a bare place — not a conditional — as needing ownership treatment, so
    /// <c>maybeA ?? (if flag then a else b)</c> fails the same E0507 class on the coalesce's right arm.
    /// </summary>
    [Fact]
    public void Coalesce_right_arm_conditional_operand_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "  }\n" +
            "  value Mix {\n" +
            "    a: Weight\n" +
            "    b: Weight\n" +
            "    maybeA: Weight?\n" +
            "    flag: Bool\n" +
            "    coalesced: Weight = maybeA ?? (if flag then a else b)\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the coalesce's right (default) arm's conditional
        // branches must be cloned, never left as a bare, un-borrowed place.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.a.clone()");
        rust.ShouldContain("self.b.clone()");
        rust.ShouldNotContain("{ self.a }");
        rust.ShouldNotContain("{ self.b }");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }
}
