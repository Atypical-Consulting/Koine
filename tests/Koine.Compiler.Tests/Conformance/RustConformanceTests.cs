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
    /// Issue #1436, Task 2: a value object carrying BOTH a non-optional-declared constant-default member
    /// (<c>taxRate: Decimal = 2</c>, now a trailing <c>Option&lt;Decimal&gt;</c> constructor parameter,
    /// #1436 Task 1) AND demand-driven arithmetic (<c>combined: Money = base + base</c>, which emits
    /// <c>WriteAdditiveOp</c>'s <c>impl std::ops::Add</c>) must still compile — the operator's generated
    /// <c>Money::new(...)</c> call must append one <c>None</c> per trailing defaulted parameter, or a real
    /// <c>cargo check</c> rejects it as E0061 (wrong number of arguments).
    /// </summary>
    [Fact]
    public void Value_object_with_defaulted_member_and_additive_operator_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal = 2\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "  value Line {\n" +
            "    base: Money\n" +
            "    combined: Money = base + base\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Add for Money");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    private const string ValueObjectDefaultedMemberSurvivesAdditiveOperatorModel = """
        context Shop {
          enum Currency { EUR, USD }

          value Money {
            amount: Decimal
            currency: Currency = EUR
            invariant amount >= 0 "an amount cannot be negative"
          }
          value Line {
            base: Money
            combined: Money = base + base
          }
        }
        """;

    /// <summary>
    /// Code-review follow-up to #1436 Task 2: the additive operator's generated <c>Money::new(...)</c>
    /// call must carry a defaulted member's ACTUAL runtime value forward (<c>Some(self.currency)</c>),
    /// not silently reset it to the declared default — the value-object analogue of the C# emitter's
    /// carried-member guard against an <c>EUR + USD -&gt; EUR</c> silent coercion
    /// (<c>CSharpEmitter.ValueObjects.cs</c>'s <c>WriteAdditiveOperator</c>). Before this follow-up,
    /// <c>WriteAdditiveOp</c> passed a bare <c>None</c> for every trailing defaulted parameter, so a
    /// <c>Money</c> constructed with <c>currency: Some(Currency::Usd)</c> silently reverted to <c>EUR</c>
    /// after ANY <c>+</c> — a real, observable data-corruption bug now that #1436 makes such a member
    /// genuinely overridable.
    /// </summary>
    [Fact]
    public void Value_object_defaulted_member_survives_additive_operator()
    {
        var result = new KoineCompiler().Compile(ValueObjectDefaultedMemberSurvivesAdditiveOperatorModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::{Currency, Money};

            #[test]
            fn overridden_currency_survives_addition() {
                let usd = Money::new(Decimal::from(10), Some(Currency::Usd)).expect("valid Money");
                let combined = usd.clone() + usd;
                assert_eq!(combined.currency(), Currency::Usd);
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    private const string ValueObjectOptionalDefaultedMemberSurvivesAdditiveOperatorModel = """
        context Shop {
          value Money {
            amount: Decimal
            taxRate: Decimal? = 2
            invariant amount >= 0 "an amount cannot be negative"
          }
          value Line {
            base: Money
            combined: Money = base + base
          }
        }
        """;

    /// <summary>
    /// Issue #1463 Task 2: the additive operator's generated <c>Money::new(...)</c> call must carry an
    /// optional-declared defaulted member's ACTUAL runtime value forward, not silently reset it to the
    /// declared default — the value-object dual of the non-optional-declared carry-forward fix
    /// (<see cref="Value_object_defaulted_member_survives_additive_operator"/>). Since Task 1 merged
    /// optional-declared members into <c>defaultedParams</c>, the unconditional <c>Some(self.field)</c>
    /// wrap those operator builders already apply would double-wrap an already-<c>Option</c>-typed field
    /// (<c>self.tax_rate</c> is <c>Option&lt;Decimal&gt;</c>, so <c>Some(self.tax_rate)</c> is
    /// <c>Option&lt;Option&lt;Decimal&gt;&gt;</c>) — a real <c>cargo check</c> <c>E0308</c> against the
    /// <c>Option&lt;Decimal&gt;</c> constructor parameter.
    /// </summary>
    [Fact]
    public void Value_object_optional_declared_defaulted_member_survives_additive_operator()
    {
        var result = new KoineCompiler().Compile(ValueObjectOptionalDefaultedMemberSurvivesAdditiveOperatorModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::Money;

            #[test]
            fn overridden_tax_rate_survives_addition() {
                let overridden = Money::new(Decimal::from(10), Some(Decimal::from(9))).expect("valid Money");
                let combined = overridden.clone() + overridden;
                assert_eq!(combined.tax_rate(), &Some(Decimal::from(9)));
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
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
    /// Uses <c>+</c> rather than <c>*</c>/<c>/</c>: at the time this test was written,
    /// <c>ValueObjectArithmeticWalker</c> (which decides whether a VO needs a generated <c>Add</c>/<c>Sub</c>
    /// impl) already resolved an operand's full inferred type, so it recognized a compound (conditional)
    /// operand fine — but <c>ScalarOpWalker</c> (which decides whether a VO needs a generated
    /// <c>Mul</c>/<c>Div</c> impl for a scalar factor) was deliberately shallow, classifying only a bare
    /// identifier/literal operand, so a <c>Money * (if …)</c>-shaped case never got its
    /// <c>impl std::ops::Mul</c> generated at all — an unrelated, pre-existing E0369 ("cannot multiply")
    /// regardless of this fix. That gap was filed as #1289 and is now fixed (see
    /// <see cref="Plain_value_object_scalar_multiply_with_conditional_operand_emits_compiling_rust"/>);
    /// this test still uses <c>+</c> since it targets the clone/borrow (E0507) defect specifically, not
    /// scalar-factor demand-detection.
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

    /// <summary>
    /// Issue #1282 code-review finding — a let-binding's own VALUE (not just the let's body) can be a
    /// bare compound expression (a conditional): <c>let picked = (if flag then a else b) in picked</c>
    /// used as a bare derived-member body. <c>WriteLetBindings</c>'s <c>cloneNonCopyPlaces</c> path
    /// previously rendered a binding's value with plain <c>Write</c> and only cloned it when it was a
    /// bare place, never recursing into a compound value the way the let's body already did — so the
    /// conditional's branches inside the binding's value were left un-cloned and failed a real
    /// <c>cargo check</c> E0507, independently confirmed by three finder agents during code review.
    /// </summary>
    [Fact]
    public void Let_binding_value_is_conditional_derived_member_emits_compiling_rust()
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
            "    combined: Money = let picked = (if flag then a else b) in picked\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the let-binding's own conditional value must
        // clone its non-Copy branches, never leave them as bare, un-borrowed places.
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
    /// Issue #1282 code-review finding — a <c>String</c>-typed conditional branch that is itself a
    /// concatenation (not a bare place) must NOT get an appended <c>.to_string()</c>: the concatenation
    /// already renders as an owned <c>String</c> via <c>WriteStringOwned</c>, and appending a suffix
    /// after <c>StripOuterParens</c> removes its enclosing parens binds the suffix to the
    /// concatenation's LAST operand instead of the whole expression (e.g.
    /// <c>"URGENT ".to_string() + &amp;self.hours.to_string().to_string()</c> — a misassociated,
    /// redundant double <c>.to_string()</c> on <c>hours</c> alone). Confirmed via a real <c>cargo
    /// check</c> comparison against `main`'s pre-fix rendering during code review.
    /// </summary>
    [Fact]
    public void String_typed_conditional_branch_that_is_a_concatenation_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Announcement {\n" +
            "    hours: Int\n" +
            "    minutes: Int\n" +
            "    urgent: Bool\n" +
            "    display: String = if urgent then \"URGENT \" + hours else \"normal \" + minutes\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): each concatenated branch renders exactly one
        // `.to_string()` on the Int operand, never a misassociated double.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("\"URGENT \".to_string() + &self.hours.to_string()");
        rust.ShouldContain("\"normal \".to_string() + &self.minutes.to_string()");
        rust.ShouldNotContain("self.hours.to_string().to_string()");
        rust.ShouldNotContain("self.minutes.to_string().to_string()");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1289 — this issue's own minimal repro: a <c>quantity</c>'s scalar <c>*</c> by a compound
    /// (conditional) operand must get a real <c>impl std::ops::Mul</c>. Before the fix,
    /// <c>ScalarOpWalker.InferOperand</c> classified only a bare identifier/literal operand, so a
    /// conditional operand was invisible to the demand analysis and the impl was never generated at
    /// all — a real <c>cargo check</c> E0369 ("cannot multiply `Weight` by `{integer}`"), even though
    /// the emitter still lowered the <c>*</c> to the native Rust operator unconditionally.
    /// </summary>
    [Fact]
    public void Quantity_scalar_multiply_with_conditional_operand_emits_compiling_rust()
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
            "    scaledConditional: Weight = (if flag then a else b) * 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the native `*` must resolve to a real impl.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Mul<i64> for Weight");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1289 — the <c>/</c> (Div) sibling of
    /// <see cref="Quantity_scalar_multiply_with_conditional_operand_emits_compiling_rust"/>: a
    /// quantity's scalar <c>/</c> by a compound (conditional) operand must also get a real
    /// <c>impl std::ops::Div</c>.
    /// </summary>
    [Fact]
    public void Quantity_scalar_divide_with_conditional_operand_emits_compiling_rust()
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
            "    dividedConditional: Weight = (if flag then a else b) / 4\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the native `/` must resolve to a real impl.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Div<i64> for Weight");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1289 — <c>ScalarOpWalker</c> is shared across quantity and plain (non-quantity) value
    /// objects, so the same compound-operand gap applies to a plain VO's scalar <c>*</c> too. This is
    /// the exact shape <see cref="General_arithmetic_path_with_conditional_operand_emits_compiling_rust"/>'s
    /// doc comment called out as a separate, pre-existing E0369 filed as this issue.
    /// </summary>
    [Fact]
    public void Plain_value_object_scalar_multiply_with_conditional_operand_emits_compiling_rust()
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
            "    scaledConditional: Money = (if flag then a else b) * 2\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the native `*` must resolve to a real impl.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("impl std::ops::Mul<i64> for Money");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1293 — a conditional operand of the general arithmetic path whose two branches are
    /// themselves mismatched in <b>shape</b> (a bare <c>Int</c> identifier vs. a nested <c>Int</c>
    /// arithmetic expression) only got the identifier branch <c>Decimal::from(...)</c>-coerced:
    /// <c>Write()</c>'s dispatch only honors <c>coerceTo</c> for a bare <c>IdentifierExpr</c>/<c>LiteralExpr</c>
    /// leaf, so the nested-arithmetic branch kept its raw <c>i64</c> type and the generated <c>if</c>/<c>else</c>
    /// had two different Rust types — a real <c>cargo check</c> E0308, even though the compiler reported
    /// success. Discovered during code review of #1282; confirmed pre-existing on <c>main</c> as well.
    /// </summary>
    [Fact]
    public void Conditional_operand_with_mismatched_branch_shapes_is_coerced_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    surcharge: Int\n" +
            "    flatFee: Int\n" +
            "    taxRate: Decimal\n" +
            "    isSpecial: Bool\n" +
            "    tax: Decimal = (if isSpecial then baseAmount + surcharge else flatFee) * taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the whole conditional is coerced ONCE, outside
        // the if/else — never per-branch (which left the two branches with different Rust types).
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain(
            "Decimal::from(if self.is_special { self.base_amount + self.surcharge } else { self.flat_fee })");
        rust.ShouldNotContain("Decimal::from(self.flat_fee)");
        rust.ShouldNotContain("Decimal::from(self.base_amount + self.surcharge)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1293, Task 2 — the compound-operand coercion wrap must also reach a <c>let</c>-bound
    /// mismatched-type value, not just a bare conditional: <c>WriteArithmeticOperand</c>'s compound
    /// branch matches <c>ConditionalExpr</c>/<c>LetExpr</c>/<c>GuardExpr</c> alike, so the same
    /// whole-expression <c>Decimal::from(...)</c> wrap must apply when the mismatched conditional is
    /// itself wrapped in a <c>let</c>.
    /// </summary>
    [Fact]
    public void Let_operand_with_mismatched_branch_shapes_is_coerced_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    surcharge: Int\n" +
            "    flatFee: Int\n" +
            "    taxRate: Decimal\n" +
            "    isSpecial: Bool\n" +
            "    tax: Decimal = (let picked = (if isSpecial then baseAmount + surcharge else flatFee) in picked) * taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the whole let-block is coerced ONCE, outside its
        // braces — never per-branch inside the nested conditional.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain(
            "Decimal::from({ let picked = if self.is_special { self.base_amount + self.surcharge } else { self.flat_fee }; picked })");
        rust.ShouldNotContain("Decimal::from(self.flat_fee)");
        rust.ShouldNotContain("Decimal::from(self.base_amount + self.surcharge)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1293, Task 2 — the <c>when</c>-guarded sibling of
    /// <see cref="Conditional_operand_with_mismatched_branch_shapes_is_coerced_once_as_a_whole"/>: a
    /// <c>GuardExpr</c> wrapping a mismatched-type conditional must also get the whole-expression wrap.
    /// <c>when</c> is semantic-only (no runtime Rust representation), so the rendered shape is identical
    /// to the bare-conditional case — this test guards that <c>WriteArithmeticOperand</c>'s
    /// <c>GuardExpr</c> dispatch reaches the same wrap path, not that the guard adds new Rust syntax.
    /// </summary>
    [Fact]
    public void Guarded_conditional_operand_with_mismatched_branch_shapes_is_coerced_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    surcharge: Int\n" +
            "    flatFee: Int\n" +
            "    taxRate: Decimal\n" +
            "    isSpecial: Bool\n" +
            "    active: Bool\n" +
            "    tax: Decimal = ((if isSpecial then baseAmount + surcharge else flatFee) when active) * taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the whole guarded conditional is coerced ONCE,
        // never per-branch.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain(
            "Decimal::from(if self.is_special { self.base_amount + self.surcharge } else { self.flat_fee })");
        rust.ShouldNotContain("Decimal::from(self.flat_fee)");
        rust.ShouldNotContain("Decimal::from(self.base_amount + self.surcharge)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1311, Task 1 — the compound-operand coercion wrap (#1293) only fired for an arithmetic
    /// operator (<c>isArithmetic</c>-gated), but <c>WriteBinary</c> computes <c>coerceLeft</c>/
    /// <c>coerceRight</c> unconditionally for every binary operator, including comparisons. A comparison
    /// whose operand is a mismatched-shape conditional (a bare <c>Int</c> identifier vs. a nested
    /// <c>Int</c> arithmetic expression, both needing to widen against a <c>Decimal</c> sibling) fell
    /// through to the un-fixed per-leaf <c>coerceTo</c> path, reproducing #1293's exact bug for
    /// comparison operators.
    /// </summary>
    [Fact]
    public void Comparison_operand_with_mismatched_branch_shapes_is_coerced_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    surcharge: Int\n" +
            "    flatFee: Int\n" +
            "    taxRate: Decimal\n" +
            "    isSpecial: Bool\n" +
            "    exceedsTax: Bool = (if isSpecial then baseAmount + surcharge else flatFee) > taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the whole conditional is coerced ONCE, outside
        // the if/else — never per-branch (which left the two branches with different Rust types), and
        // the comparison itself still borrows (no `.clone()` on either branch, per #1282).
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain(
            "Decimal::from(if self.is_special { self.base_amount + self.surcharge } else { self.flat_fee }) > self.tax_rate");
        rust.ShouldNotContain(".flat_fee.clone()");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1311, Task 2 — an EMITTER fix, not a validator one (decided against a <c>KOI0217</c>-style
    /// diagnostic): <c>TypeResolver.VisitConditional</c> already widens a conditional's two directly
    /// differently-typed branches (one <c>Int</c>, one <c>Decimal</c>) to their common <c>Decimal</c>
    /// type (#975) — a legitimate, sanctioned pattern every other target already lowers correctly (C#'s
    /// implicit numeric conversion, TS/Python's dynamic numerics). Rejecting it at the validator level
    /// would regress a working cross-target feature to fix a Rust-only rendering gap. The actual bug:
    /// because the conditional's own AGGREGATE type is already the widened <c>Decimal</c>, the outer
    /// <c>coerceTo</c> comparison in <c>WriteArithmeticOperand</c> never mismatches, so no wrap fires at
    /// all — each branch renders in its own raw, unreconciled Rust type (<c>i64</c> vs <c>Decimal</c> in
    /// the same <c>if</c>/<c>else</c>).
    /// </summary>
    [Fact]
    public void Conditional_operand_with_branches_disagreeing_with_each_other_is_reconciled()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    flatFee: Decimal\n" +
            "    taxRate: Decimal\n" +
            "    isSpecial: Bool\n" +
            "    tax: Decimal = (if isSpecial then baseAmount else flatFee) * taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the Int branch is widened to Decimal so both
        // branches of the if/else share the same Rust type (Decimal is Copy in this emitter, so the
        // Decimal branch needs no `.clone()`).
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("if self.is_special { Decimal::from(self.base_amount) } else { self.flat_fee }");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1311, Task 3 — the root-cause class: a nested <c>BinaryExpr</c> used DIRECTLY as one side
    /// of an arithmetic operator (not nested inside a conditional/let/guard) fell into
    /// <c>WriteOperand</c>'s pre-existing <c>case BinaryExpr: WriteBinary(...)</c>, which ignores
    /// <c>coerceTo</c> entirely — the same gap #1293's own issue named but scoped away from. Widening
    /// <c>WriteArithmeticOperand</c>'s compound-shape recognition to also catch a bare <c>BinaryExpr</c>
    /// operand routes it through the same "render uncoerced, wrap the whole rendered text once" path.
    /// </summary>
    [Fact]
    public void Bare_binary_operand_needing_coercion_is_wrapped_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    surcharge: Int\n" +
            "    taxRate: Decimal\n" +
            "    total: Decimal = (baseAmount + surcharge) + taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the nested Int sum is coerced ONCE, as a whole
        // — not silently dropped.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Decimal::from(self.base_amount + self.surcharge) + self.tax_rate");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Code-review finding on #1311, Task 1 — a comparison operand's compound (conditional/let/guard)
    /// branches must STILL be cloned/normalized when a leaf is a non-Copy place (<c>String</c>, or a
    /// non-Copy value object), even though the comparison OPERATOR itself only ever borrows. The
    /// normalization isn't there to satisfy the operator; it's there because the <c>if</c>/<c>else</c>
    /// BLOCK's own tail position is a move-out-of-<c>&amp;self</c> position regardless of what consumes
    /// the block's result afterward. Gating it off for every comparison (<c>isArithmetic</c>-keyed) broke
    /// this for any non-Copy leaf — Int/Decimal never surfaced it since both are <c>Copy</c>.
    /// </summary>
    [Fact]
    public void Comparison_operand_conditional_with_noncopy_string_branches_is_still_normalized()
    {
        const string src =
            "context Shop {\n" +
            "  value Item {\n" +
            "    primary: String\n" +
            "    secondary: String\n" +
            "    flag: Bool\n" +
            "    isMatch: Bool = (if flag then primary else secondary) == \"x\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): each non-Copy String branch must still be
        // normalized to an owned String so the if/else block itself type/borrow-checks.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("if self.flag { self.primary.to_string() } else { self.secondary.to_string() }");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Sibling of <see cref="Comparison_operand_conditional_with_noncopy_string_branches_is_still_normalized"/>
    /// for a non-Copy VALUE OBJECT place (not a String) — confirms the fix isn't String-special-cased.
    /// </summary>
    [Fact]
    public void Comparison_operand_conditional_with_noncopy_valueobject_branches_is_still_cloned()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "  }\n" +
            "  value Bag {\n" +
            "    a: Money\n" +
            "    b: Money\n" +
            "    other: Money\n" +
            "    flag: Bool\n" +
            "    isMatch: Bool = (if flag then a else b) == other\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): each non-Copy Money branch must still be cloned
        // so the if/else block itself type/borrow-checks; the bare `other` operand still borrows
        // (no `.clone()`), per #1282, since it's used directly by the comparison, not as a block tail.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("(if self.flag { self.a.clone() } else { self.b.clone() }) == self.other");
        rust.ShouldNotContain("self.other.clone()");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>The #1270 repro model: a <c>Money</c> with a non-negativity invariant, scaled and subtracted.</summary>
    private const string InvariantArithmeticSrc =
        "context Shop {\n" +
        "  value Money {\n" +
        "    amount: Decimal\n" +
        "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
        "  }\n" +
        "  value Order {\n" +
        "    fee: Money\n" +
        "    scaled: Money = fee * -20\n" +
        "    halved: Money = fee / 2\n" +
        "    diff: Money = fee - fee\n" +
        "    doubled: Money = fee + fee\n" +
        "  }\n" +
        "}\n";

    /// <summary>
    /// Issue #1270: the demand-driven value-object operators must build their result through the
    /// validating constructor, not a raw struct literal. <c>WriteScalarOp</c> emitted
    /// <c>Money { amount: self.amount * Decimal::from(factor) }</c> and <c>WriteAdditiveOp</c> the
    /// pairwise equivalent — bypassing <c>Money::new</c>, and with it every declared <c>invariant</c>.
    /// A `Money` scaled by a negative factor silently became a negative `Money`. This is the always-on
    /// (no-toolchain) shape guard: every operator body must route through <c>Money::new(...)</c> and no
    /// operator may construct a bare <c>Money { ... }</c> literal.
    /// </summary>
    [Fact]
    public void Demand_driven_value_object_arithmetic_routes_through_the_validating_constructor()
    {
        var result = new KoineCompiler().Compile(InvariantArithmeticSrc, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("Money::new(self.amount * Decimal::from(factor))");
        rust.ShouldContain("Money::new(self.amount / Decimal::from(divisor))");
        rust.ShouldContain("Money::new(self.amount + other.amount)");
        rust.ShouldContain("Money::new(self.amount - other.amount)");
        rust.ShouldContain(".expect(\"Money: `*` violated an invariant\")");
        rust.ShouldContain(".expect(\"Money: `-` violated an invariant\")");

        // The raw struct literal each operator used to build is gone. It was the only place a bare
        // `Money { ... }` literal was ever emitted at an operator body's indent level (the smart
        // constructor spells its own construction `Ok(Self { ... })`, and `pub struct Money {` is the
        // declaration, not a literal) — so its absence at that indent is the precise regression guard.
        rust.ShouldNotContain("        Money {\n");
    }

    /// <summary>
    /// Issue #1270, the behavioural half: compiling the operator is not enough — it must actually
    /// REJECT an invariant-violating result at runtime. Emitted-shape assertions alone would have
    /// passed against the old raw-struct-literal code just as happily, so this runs the emitted crate
    /// under <c>cargo test</c>: a valid scaling still succeeds, while <c>Money * -20</c> and a negative
    /// <c>Money - Money</c> now panic through <c>Money::new</c>'s invariant guard instead of silently
    /// producing a negative amount.
    /// </summary>
    [Fact]
    public void Demand_driven_value_object_arithmetic_enforces_invariants_at_runtime()
    {
        var result = new KoineCompiler().Compile(InvariantArithmeticSrc, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::Money;

            /// A scaling that respects the invariant still yields the scaled value.
            #[test]
            fn scalar_mul_preserves_a_valid_value() {
                let fee = Money::new(Decimal::from(10)).expect("10 is a valid Money");
                assert_eq!(fee * 2, Money::new(Decimal::from(20)).unwrap());
            }

            /// Scaling by a negative factor violates `amount >= 0` and must not silently succeed.
            #[test]
            #[should_panic(expected = "an amount cannot be negative")]
            fn scalar_mul_enforces_the_invariant() {
                let fee = Money::new(Decimal::from(10)).expect("10 is a valid Money");
                let _ = fee * -20;
            }

            /// A subtraction that goes below zero violates the same invariant.
            #[test]
            #[should_panic(expected = "an amount cannot be negative")]
            fn subtraction_enforces_the_invariant() {
                let small = Money::new(Decimal::from(1)).expect("1 is a valid Money");
                let big = Money::new(Decimal::from(5)).expect("5 is a valid Money");
                let _ = small - big;
            }

            /// Addition of two valid amounts stays valid, and yields their sum.
            #[test]
            fn addition_preserves_a_valid_value() {
                let a = Money::new(Decimal::from(3)).expect("3 is a valid Money");
                let b = Money::new(Decimal::from(4)).expect("4 is a valid Money");
                assert_eq!(a + b, Money::new(Decimal::from(7)).unwrap());
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1318, sibling of #1270: a <c>quantity</c>'s inherent <c>add</c>/<c>sub</c>/<c>scale</c>
    /// (<c>WriteQuantityOps</c>) built their result via a local <c>Construct(...)</c> helper that emitted
    /// a raw <c>Weight { amount: …, unit: self.unit }</c> struct literal — bypassing <c>Weight::new</c>
    /// and, with it, every declared <c>invariant</c>. Emitted-shape assertions alone would have passed
    /// against the old raw-literal code just as happily, so this runs the emitted crate under
    /// <c>cargo test</c>: a valid <c>sub</c>/<c>scale</c> still yields the expected value, while a
    /// <c>sub</c> that goes negative now surfaces as <c>Err</c> (composing with the existing unit check)
    /// and a <c>scale</c> by a negative factor now panics through <c>Weight::new</c>'s invariant guard
    /// instead of silently producing a negative amount.
    /// </summary>
    [Fact]
    public void Quantity_add_sub_scale_enforce_invariants_at_runtime()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit\n" +
            "    invariant amount >= 0 \"a weight cannot be negative\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::{MassUnit, Weight};

            /// A subtraction that stays non-negative still yields the difference.
            #[test]
            fn sub_preserves_a_valid_value() {
                let big = Weight::new(Decimal::from(5), MassUnit::Kilograms).expect("5 is a valid Weight");
                let small = Weight::new(Decimal::from(1), MassUnit::Kilograms).expect("1 is a valid Weight");
                assert_eq!(big.sub(&small).unwrap(), Weight::new(Decimal::from(4), MassUnit::Kilograms).unwrap());
            }

            /// A subtraction that goes negative must surface as an Err, not a negative Weight.
            #[test]
            fn sub_enforces_the_invariant() {
                let small = Weight::new(Decimal::from(1), MassUnit::Kilograms).expect("1 is a valid Weight");
                let big = Weight::new(Decimal::from(5), MassUnit::Kilograms).expect("5 is a valid Weight");
                assert!(small.sub(&big).is_err());
            }

            /// A scale that stays non-negative still yields the scaled value.
            #[test]
            fn scale_preserves_a_valid_value() {
                let w = Weight::new(Decimal::from(2), MassUnit::Kilograms).expect("2 is a valid Weight");
                assert_eq!(w.scale(Decimal::from(3)), Weight::new(Decimal::from(6), MassUnit::Kilograms).unwrap());
            }

            /// Scaling by a negative factor violates the invariant and must panic, not silently succeed.
            #[test]
            #[should_panic(expected = "a weight cannot be negative")]
            fn scale_enforces_the_invariant() {
                let w = Weight::new(Decimal::from(1), MassUnit::Kilograms).expect("1 is a valid Weight");
                let _ = w.scale(Decimal::from(-5));
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1318 edge case: a quantity's <c>unit</c> member carrying a constant default is absent from
    /// <c>required</c>, so <c>WriteQuantityOps</c> cannot hand <c>Weight::new(...)</c> a caller-supplied
    /// unit for it — an earlier version of the #1318 fix bailed out of emitting <c>add</c>/<c>sub</c>/
    /// <c>scale</c> entirely in this case, but <c>RustExpressionTranslator.WriteBinary</c> unconditionally
    /// lowers a quantity's <c>+</c>/<c>-</c> to a call to those methods regardless — a real <c>cargo</c>
    /// <c>E0599</c> (no method named `add` found). This asserts the fallback path (a raw-literal
    /// construction, matching pre-#1318 behavior for just this edge case) still emits and compiles
    /// working <c>add</c>/<c>sub</c>/<c>scale</c>, so a quantity's <c>+</c> lowering never targets a
    /// missing method. (Constant-defaulting a quantity's amount/unit is domain-nonsensical and not
    /// rejected by semantics, so this only proves the emitter degrades safely rather than compiles
    /// meaningfully — see the code comment in <c>WriteQuantityOps</c>.)
    /// </summary>
    [Fact]
    public void Quantity_with_constant_default_unit_still_compiles_add_sub_scale()
    {
        const string src =
            "context Shop {\n" +
            "  enum MassUnit { Grams, Kilograms }\n" +
            "  quantity Weight {\n" +
            "    amount: Decimal\n" +
            "    unit: MassUnit = Kilograms\n" +
            "  }\n" +
            "  value Combo {\n" +
            "    a: Weight\n" +
            "    b: Weight\n" +
            "    total: Weight = a + b\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::Weight;

            #[test]
            fn add_still_combines_amounts() {
                let a = Weight::new(Decimal::from(2), None).expect("2 is a valid Weight");
                let b = Weight::new(Decimal::from(3), None).expect("3 is a valid Weight");
                assert_eq!(a.add(&b).unwrap(), Weight::new(Decimal::from(5), None).unwrap());
            }

            #[test]
            fn scale_still_scales_the_amount() {
                let w = Weight::new(Decimal::from(2), None).expect("2 is a valid Weight");
                assert_eq!(w.scale(Decimal::from(3)), Weight::new(Decimal::from(6), None).unwrap());
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1316, Task 1 — a bare <c>MemberAccessExpr</c> (a nested value object's member read through
    /// its accessor, e.g. <c>base.amount</c>) used DIRECTLY as one side of an arithmetic operator falls
    /// into <c>WriteOperand</c>'s <c>default: Write(expr, sb, coerceTo)</c> branch, which dispatches to
    /// <c>WriteMemberAccess(ma, sb)</c> — a method that never consults <c>coerceTo</c> at all. The
    /// generated `total` getter silently drops the Int-&gt;Decimal coercion (`self.base.amount() +
    /// self.tax_rate`), a real <c>cargo check</c> E0277 (no `Add&lt;Decimal&gt;` impl for `i64`).
    /// </summary>
    [Fact]
    public void Bare_member_access_operand_needing_coercion_is_wrapped_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "  }\n" +
            "  value Invoice {\n" +
            "    base: Money\n" +
            "    taxRate: Decimal\n" +
            "    total: Decimal = base.amount + taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the Int member read through its accessor is
        // coerced ONCE, as a whole — not silently dropped.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Decimal::from(self.base.amount()) + self.tax_rate");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Sibling guard for the currently-passing (no-coercion-needed) shape: a bare <c>MemberAccessExpr</c>
    /// arithmetic operand whose type already matches its sibling must render byte-identical to before
    /// this fix — no gratuitous outer parens. This is the primary regression risk the issue calls out:
    /// naively widening the compound-shape wrap (used for <c>ConditionalExpr</c>/<c>LetExpr</c>/
    /// <c>GuardExpr</c>/<c>BinaryExpr</c>, which all need delimiting) to a <c>MemberAccessExpr</c> would
    /// wrap even the no-coercion case in bare <c>(...)</c>, since a plain accessor call
    /// (<c>self.base.amount()</c>) has no self-enclosing parens for <c>StripOuterParens</c> to remove.
    /// </summary>
    [Fact]
    public void Bare_member_access_operand_needing_no_coercion_renders_unwrapped()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "  }\n" +
            "  value Invoice {\n" +
            "    base: Money\n" +
            "    surcharge: Int\n" +
            "    total: Int = base.amount + surcharge\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("self.base.amount() + self.surcharge");
        rust.ShouldNotContain("(self.base.amount())");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1316, Task 2 (probe) — a bare <c>CallExpr</c> (an accessor-style collection call, e.g.
    /// <c>lines.sum(l =&gt; l.amount)</c>) used DIRECTLY as one side of an arithmetic operator, needing
    /// Int-&gt;Decimal coercion. Confirms (or refutes) whether <c>WriteOperand</c>'s <c>default:
    /// Write(expr, sb, coerceTo)</c> branch — which dispatches to <c>WriteCall(call, sb)</c>, a method
    /// that never consults <c>coerceTo</c> — has the same defect as the <c>MemberAccessExpr</c> case
    /// fixed in Task 1.
    /// </summary>
    [Fact]
    public void Bare_call_operand_needing_coercion_is_wrapped_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value LineItem {\n" +
            "    amount: Int\n" +
            "  }\n" +
            "  value Invoice {\n" +
            "    items: List<LineItem>\n" +
            "    taxRate: Decimal\n" +
            "    total: Decimal = items.sum(i => i.amount) + taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the Int-typed sum() call is coerced ONCE, as a
        // whole — not silently dropped.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain(
            "Decimal::from(crate::koine_runtime::koine_sum(self.items.iter().map(|i| i.amount())))" +
            " + self.tax_rate");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1321 — a bare <c>UnaryExpr</c> (a negation, e.g. <c>-baseAmount</c>) used DIRECTLY as one
    /// side of an arithmetic operator falls into <c>Write()</c>'s <c>case UnaryExpr un: WriteUnary(un,
    /// sb)</c> dispatch — a method that never consults <c>coerceTo</c> at all, the same defect
    /// <c>MemberAccessExpr</c>/<c>CallExpr</c> had before #1316. The generated `total` getter silently
    /// dropped the Int-&gt;Decimal coercion (`-self.base_amount + self.tax_rate`), a real
    /// <c>cargo check</c> E0277 (no `Add&lt;Decimal&gt;` impl for `i64`).
    /// </summary>
    [Fact]
    public void Bare_unary_operand_needing_coercion_is_wrapped_once_as_a_whole()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    taxRate: Decimal\n" +
            "    total: Decimal = -baseAmount + taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the negated Int field is coerced ONCE, as a
        // whole — not silently dropped.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Decimal::from(-self.base_amount) + self.tax_rate");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Sibling guard for the currently-passing (no-coercion-needed) shape: a bare <c>UnaryExpr</c>
    /// arithmetic operand whose type already matches its sibling must render byte-identical to before
    /// this fix — no gratuitous outer parens. This is the primary regression risk the issue calls out:
    /// naively widening the compound-shape wrap (used for <c>ConditionalExpr</c>/<c>LetExpr</c>/
    /// <c>GuardExpr</c>/<c>BinaryExpr</c>, which all need delimiting) to a <c>UnaryExpr</c> would wrap
    /// even the no-coercion case in bare <c>(...)</c>, since a negation has no self-enclosing parens for
    /// <c>StripOuterParens</c> to remove.
    /// </summary>
    [Fact]
    public void Bare_unary_operand_needing_no_coercion_renders_unwrapped()
    {
        const string src =
            "context Shop {\n" +
            "  value Invoice {\n" +
            "    baseAmount: Int\n" +
            "    surcharge: Int\n" +
            "    total: Int = -baseAmount + surcharge\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("-self.base_amount + self.surcharge");
        rust.ShouldNotContain("(-self.base_amount)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1319: a value object's constant-default field must be coerced to its declared Rust type in
    /// the smart constructor, or the emitted crate does not compile at all. Before the fix, a
    /// <c>Decimal</c> field defaulted to an <c>Int</c> literal emitted the raw literal (<c>tax_rate:
    /// 2</c>, expected <c>Decimal</c>) and a <c>String</c> field defaulted to a string literal emitted a
    /// borrowed <c>&amp;str</c> (<c>label: "std"</c>, expected <c>String</c>) — both real <c>cargo
    /// check</c> <c>E0308</c>s.
    /// </summary>
    [Fact]
    public void Value_object_constant_default_decimal_and_string_fields_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal = 2\n" +
            "    label: String = \"std\"\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1324: an entity's constant-default field must be coerced to its declared Rust type in the
    /// smart constructor's <c>let</c>-binding loop — the entity dual of #1319's value-object fix — or the
    /// emitted crate does not compile at all. Before the fix, a <c>Decimal</c> field defaulted to an
    /// <c>Int</c> literal bound the raw literal (<c>let tax_rate = 2;</c>, expected <c>Decimal</c>) and a
    /// <c>String</c> field defaulted to a string literal bound a borrowed <c>&amp;str</c> (<c>let label =
    /// "std";</c>, expected <c>String</c>) — both real <c>cargo check</c> <c>E0308</c>s at the
    /// struct-literal field-init site.
    /// </summary>
    [Fact]
    public void Entity_constant_default_decimal_and_string_fields_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal = 2\n" +
            "    label: String = \"std\"\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1325: an <b>optional</b> value-object constant-default field must be
    /// <c>Some(...)</c>-wrapped (and, when needed, coerced) in the smart constructor, or the emitted
    /// crate does not compile. Before the fix, an <c>Option&lt;Decimal&gt;</c> field defaulted to an
    /// <c>Int</c> literal emitted the raw literal (<c>tax_rate: 2</c>, expected
    /// <c>Option&lt;Decimal&gt;</c>) and an <c>Option&lt;String&gt;</c> field defaulted to a string
    /// literal emitted a borrowed <c>&amp;str</c> (<c>label: "std"</c>, expected
    /// <c>Option&lt;String&gt;</c>) — both real <c>cargo check</c> <c>E0308</c>s.
    /// </summary>
    [Fact]
    public void Value_object_optional_constant_default_decimal_and_string_fields_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal? = 2\n" +
            "    label: String? = \"std\"\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1325: an <b>optional</b> entity constant-default field must be <c>Some(...)</c>-wrapped
    /// (and, when needed, coerced) in the smart constructor's <c>let</c>-binding loop — the entity dual
    /// of the value-object case above — or the emitted crate does not compile.
    /// </summary>
    [Fact]
    public void Entity_optional_constant_default_decimal_and_string_fields_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal? = 2\n" +
            "    label: String? = \"std\"\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1472: an entity <c>invariant</c> comparing a constant-defaulted, optional-declared
    /// member against a same-typed non-optional operand (guarded by <c>isPresent</c>) must compile —
    /// before the fix, the member's ctor-local was re-wrapped in <c>Some(...)</c> before the invariant
    /// guards ran, so the comparison mismatched <c>Option&lt;Decimal&gt;</c> against <c>Decimal</c>
    /// (<c>E0308</c>).
    /// </summary>
    [Fact]
    public void Entity_invariant_referencing_constant_defaulted_optional_member_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal? = 2\n" +
            "    invariant taxRate >= amount when taxRate.isPresent \"tax rate must be at least amount\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1472: the value-object dual of the entity case above — <c>WriteSmartConstructor</c>
    /// re-wraps a constant-defaulted optional member the same way, so it hits the identical
    /// <c>E0308</c> once an invariant references it.
    /// </summary>
    [Fact]
    public void Value_object_invariant_referencing_constant_defaulted_optional_member_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal? = 2\n" +
            "    invariant taxRate >= amount when taxRate.isPresent \"tax rate must be at least amount\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1472: the entity invariant referencing a constant-defaulted optional member doesn't just
    /// compile — it must actually enforce the rule, both when the member is left at its default and
    /// when a caller overrides it with a violating value.
    /// </summary>
    [Fact]
    public void Entity_invariant_referencing_constant_defaulted_optional_member_enforces_the_rule()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal? = 2\n" +
            "    invariant taxRate >= amount when taxRate.isPresent \"tax rate must be at least amount\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::{Product, ProductId};

            #[test]
            fn default_tax_rate_passes_the_invariant() {
                let p = Product::new(ProductId::new("p-1"), Decimal::from(1), None);
                assert!(p.is_ok());
            }

            #[test]
            fn overridden_tax_rate_still_enforces_the_invariant() {
                let p = Product::new(ProductId::new("p-2"), Decimal::from(10), Some(Decimal::from(1)));
                assert!(p.is_err());
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1472: the value-object dual of the runtime-behavior test above.
    /// </summary>
    [Fact]
    public void Value_object_invariant_referencing_constant_defaulted_optional_member_enforces_the_rule()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal? = 2\n" +
            "    invariant taxRate >= amount when taxRate.isPresent \"tax rate must be at least amount\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::Money;

            #[test]
            fn default_tax_rate_passes_the_invariant() {
                let m = Money::new(Decimal::from(1), None);
                assert!(m.is_ok());
            }

            #[test]
            fn overridden_tax_rate_still_enforces_the_invariant() {
                let m = Money::new(Decimal::from(10), Some(Decimal::from(1)));
                assert!(m.is_err());
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1472 edge case: a genuinely-optional, <b>non-defaulted</b> member's <c>isPresent</c> must
    /// keep emitting a real <c>.is_some()</c> check — the constant-defaulted short-circuit is keyed off
    /// having an initializer, so a member with none must fall through unchanged. (A direct numeric
    /// comparison of such a member against a non-optional operand, e.g. <c>taxRate &gt;= amount when
    /// taxRate.isPresent</c>, is a separate, pre-existing Option-vs-T coercion gap for genuinely-optional
    /// members — out of scope here per this issue's non-goals — so this only exercises a standalone
    /// presence check, which does compile today.)
    /// </summary>
    [Fact]
    public void Value_object_isPresent_on_a_non_defaulted_optional_member_still_emits_is_some()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Decimal\n" +
            "    taxRate: Decimal?\n" +
            "    hasTaxRate: Bool = taxRate.isPresent\n" +
            "    invariant amount >= 0 \"an amount cannot be negative\"\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("tax_rate.is_some()");

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::Money;

            #[test]
            fn absent_tax_rate_reports_not_present() {
                let m = Money::new(Decimal::from(1), None).expect("valid Money");
                assert!(!m.has_tax_rate());
            }

            #[test]
            fn present_tax_rate_reports_present() {
                let m = Money::new(Decimal::from(1), Some(Decimal::from(2))).expect("valid Money");
                assert!(m.has_tax_rate());
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1329: an optional-declared derived (computed) member whose bare or conditional body is a
    /// non-optional numeric value must be coerced to the declared underlying type and <c>Some(...)</c>-
    /// wrapped — <c>WriteDerived</c>'s coercion sites otherwise left it entirely uncoerced/unwrapped
    /// whenever the declared type was optional, a real <c>cargo check</c> <c>E0308</c>. A body that is
    /// itself already <c>Option</c>-shaped (both conditional branches reference optional fields) must
    /// keep rendering unwrapped, unchanged.
    /// </summary>
    [Fact]
    public void Value_object_optional_derived_member_numeric_coercion_cases_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    surcharge: Int\n" +
            "    bonus: Int?\n" +
            "    fallback: Int?\n" +
            "    totalNarrower: Decimal? = amount + surcharge\n" +
            "    totalSameType: Int? = amount + surcharge\n" +
            "    totalOptCond: Int? = if amount > 0 then bonus else fallback\n" +
            "    totalNumCond: Decimal? = if amount > 0 then amount else 0\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1329: the entity dual of the value-object case above — <c>WriteDerived</c> is shared
    /// verbatim between <c>EmitValueObject</c> and <c>EmitEntity</c>, so an entity's optional-declared
    /// derived member needs the identical coerce/<c>Some(...)</c>-wrap treatment, or the emitted crate
    /// does not compile.
    /// </summary>
    [Fact]
    public void Entity_optional_derived_member_numeric_coercion_cases_emit_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    amount: Int\n" +
            "    surcharge: Int\n" +
            "    bonus: Int?\n" +
            "    fallback: Int?\n" +
            "    totalNarrower: Decimal? = amount + surcharge\n" +
            "    totalSameType: Int? = amount + surcharge\n" +
            "    totalOptCond: Int? = if amount > 0 then bonus else fallback\n" +
            "    totalNumCond: Decimal? = if amount > 0 then amount else 0\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1331: a <c>ConditionalExpr</c> derived-member body whose branches disagree in optionality
    /// must render both <c>if</c>/<c>else</c> arms in the same Rust type — the non-optional branch
    /// <c>Some(...)</c>-wrapped to match its optional sibling, composing with the existing numeric
    /// Int→Decimal widen when both apply to the same branch — or the emitted crate does not compile.
    /// </summary>
    [Fact]
    public void Conditional_branch_optionality_mismatch_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Int?\n" +
            "    total: Int? = if amount > 0 then amount else bonus\n" +
            "  }\n" +
            "  value Cash {\n" +
            "    amount: Int\n" +
            "    bonusAmount: Decimal?\n" +
            "    total: Decimal? = if amount > 0 then amount else bonusAmount\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1333: a <c>CoalesceExpr</c> (<c>a ?? b</c>) whose right operand is itself optional must
    /// render <c>.or_else(...)</c>, not <c>.unwrap_or_else(...)</c> — the latter force-unwraps to a bare
    /// <c>T</c> while the closure actually returns <c>Option&lt;T&gt;</c>, a real <c>cargo check</c>
    /// <c>E0308</c>. Exercises all four presence combinations (present/absent on each side) at runtime,
    /// not just that it compiles.
    /// </summary>
    [Fact]
    public void Coalesce_with_both_operands_optional_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Int?\n" +
            "    fallback: Int?\n" +
            "    total: Int? = bonus ?? fallback\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1333 edge case: a nested <c>CoalesceExpr</c> as the right operand of an outer coalesce
    /// (<c>bonus ?? (fallback ?? backup)</c>) must render <c>.or_else(...)</c> at both levels and compile
    /// cleanly — the outer method-name choice depends on the inner coalesce's own inferred optionality.
    /// </summary>
    [Fact]
    public void Coalesce_with_nested_optional_coalesce_right_operand_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    amount: Int\n" +
            "    bonus: Int?\n" +
            "    fallback: Int?\n" +
            "    backup: Int?\n" +
            "    total: Int? = bonus ?? (fallback ?? backup)\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1332: an optional-declared <c>String?</c> derived member whose bare body ends in
    /// <c>.trim()</c> must own the result (<c>.to_string()</c>) before <c>WriteDerived</c>'s
    /// <c>Some(...)</c>-wrap is applied, or the emitted crate does not compile — the accessor's
    /// declared return type is <c>Option&lt;String&gt;</c>, but a borrowed <c>&amp;str</c> (from
    /// <c>.clone()</c> on the <c>.trim()</c> result) fails to unify with it (<c>E0308</c>). <c>slug</c>
    /// is the non-optional-declared sibling, along for the ride to pin its (unchanged, previously
    /// conformance-untested) baseline compile alongside the fix.
    /// </summary>
    [Fact]
    public void Value_object_optional_derived_member_with_trim_body_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Person {\n" +
            "    name: String\n" +
            "    nickname: String? = name.trim\n" +
            "    slug: String = name.trim\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1335: a <c>ConditionalExpr</c> derived-member body whose numeric-widen-needing branch is
    /// itself optional (<c>Int?</c>) must render as <c>.map(Decimal::from)</c> — both against a
    /// non-optional <c>Decimal</c> sibling and against an optional <c>Decimal?</c> sibling — or the
    /// emitted crate does not compile.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    decimalAmount: Decimal\n" +
            "    intBonus: Int?\n" +
            "    total: Decimal? = if decimalAmount > 0 then decimalAmount else intBonus\n" +
            "  }\n" +
            "  value Cash {\n" +
            "    amount: Int\n" +
            "    bonusDecimal: Decimal?\n" +
            "    bonusInt: Int?\n" +
            "    total: Decimal? = if amount > 0 then bonusDecimal else bonusInt\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1343: a bare optional <c>Int?</c> identifier compared via <c>==</c> to a non-optional
    /// <c>Decimal</c> must map inside its Option (not a bare <c>Decimal::from(...)</c> prefix, invalid
    /// for an <c>Option&lt;i64&gt;</c> operand) — and the opposite non-optional <c>Decimal</c> operand
    /// must itself become <c>Some(...)</c>-wrapped so both sides of <c>==</c> share the same Rust type —
    /// or the emitted crate does not compile.
    /// </summary>
    [Fact]
    public void Optional_int_identifier_compared_via_equality_to_decimal_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    a: Int?\n" +
            "    c: Decimal\n" +
            "    isEq: Bool = a == c\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1343: a compound (conditional) operand that itself yields an optional <c>Int?</c> (per
    /// #975's branch-optionality join) compared via <c>==</c> to a non-optional <c>Decimal</c> must map
    /// the whole rendered <c>if</c>/<c>else</c> inside its Option, with the opposite operand
    /// <c>Some(...)</c>-wrapped to match — or the emitted crate does not compile.
    /// </summary>
    [Fact]
    public void Compound_optional_int_conditional_compared_via_equality_to_decimal_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    flag: Bool\n" +
            "    x: Int\n" +
            "    y: Int?\n" +
            "    c: Decimal\n" +
            "    isEq: Bool = (if flag then x else y) == c\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1343 edge case: when the opposite operand is ITSELF optional (<c>Decimal?</c>), the
    /// coerced operand still needs <c>.map(Decimal::from)</c> with no <c>Some(...)</c> wrap on either
    /// side — or the emitted crate does not compile.
    /// </summary>
    [Fact]
    public void Optional_int_compared_to_optional_decimal_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    a: Int?\n" +
            "    d: Decimal?\n" +
            "    isEq: Bool = a == d\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1343 code-review finding: the mirror of the bare-identifier case above — a non-optional
    /// <c>Int</c> operand compared via <c>==</c> to an ALREADY-optional <c>Decimal?</c> operand. The Int
    /// side still widens bare (it isn't itself optional), but the widened result must become
    /// <c>Some(...)</c>-wrapped to match its optional sibling — or the emitted crate does not compile.
    /// </summary>
    [Fact]
    public void Non_optional_int_compared_to_optional_decimal_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Money {\n" +
            "    c: Decimal?\n" +
            "    a: Int\n" +
            "    isEq: Bool = c == a\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1354: a <c>MemberAccessExpr</c> operand whose type is an optional <c>Int?</c>, compared via
    /// <c>==</c> to a non-optional <c>Decimal</c>, must map instead of bare-wrapping — or the emitted
    /// crate does not compile (E0277: no <c>From&lt;Option&lt;i64&gt;&gt;</c>/<c>&amp;Option&lt;i64&gt;</c>
    /// impl for <c>Decimal</c>).
    /// </summary>
    [Fact]
    public void Optional_int_member_access_compared_to_decimal_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value Discount {\n" +
            "    amount: Int?\n" +
            "  }\n" +
            "  value Money {\n" +
            "    d: Discount\n" +
            "    c: Decimal\n" +
            "    isEq: Bool = d.amount == c\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1354, second shape: the same fix for a <c>CallExpr</c> operand (an aggregate over an
    /// optional <c>Int?</c> selector) compared to a non-optional <c>Decimal</c> — confirms the branch
    /// keys off the operand's own type, not its expression shape.
    /// </summary>
    [Fact]
    public void Optional_int_call_operand_compared_to_decimal_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  value LineItem {\n" +
            "    bonus: Int?\n" +
            "  }\n" +
            "  value Invoice {\n" +
            "    items: List<LineItem>\n" +
            "    taxRate: Decimal\n" +
            "    isEq: Bool = items.max(i => i.bonus) == taxRate\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1349: the read-model dual of #1332's <c>WriteDerived</c> fix — <c>OwnDerived</c> must own an
    /// optional-declared <c>String?</c> projected field's <c>.trim()</c>-yielding borrowed <c>&amp;str</c>
    /// body via <c>.to_string()</c> and <c>Some(...)</c>-wrap it, or the emitted crate does not compile
    /// (<c>E0308</c>: <c>Option&lt;String&gt;</c> expected, <c>&amp;str</c> found via a no-op
    /// <c>.clone()</c>). <c>slug</c> is the non-optional-declared sibling, along for the ride to pin its
    /// baseline compile alongside the fix.
    /// </summary>
    [Fact]
    public void Read_model_optional_derived_string_field_with_trim_body_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  aggregate Shop root Person {\n" +
            "    entity Person identified by PersonId {\n" +
            "      name: String\n" +
            "    }\n" +
            "  }\n" +
            "\n" +
            "  readmodel PersonSummary from Person {\n" +
            "    id\n" +
            "    nickname: String? = name.trim\n" +
            "    slug: String = name.trim\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1349's edge-case follow-through: a <c>Copy</c>-typed (<c>Decimal</c>) optional-declared
    /// read-model projected field must be <c>Some(...)</c>-wrapped WITHOUT a spurious <c>.clone()</c> —
    /// <c>OwnDerived</c>'s ownership gate must short-circuit on the field's underlying (non-optional) Copy
    /// type before the wrap decision, or the emitted crate does not compile (a bare <c>.clone()</c> on an
    /// already-<c>Decimal</c> body doesn't itself break compilation, but the missing <c>Some(...)</c> does
    /// — <c>E0308</c>: <c>Option&lt;Decimal&gt;</c> expected, <c>Decimal</c> found).
    /// </summary>
    [Fact]
    public void Read_model_optional_derived_copy_typed_field_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  aggregate Shop root Money {\n" +
            "    entity Money identified by MoneyId {\n" +
            "      amount: Decimal\n" +
            "      surcharge: Decimal\n" +
            "    }\n" +
            "  }\n" +
            "\n" +
            "  readmodel MoneySummary from Money {\n" +
            "    id\n" +
            "    total: Decimal? = amount + surcharge\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1349 code-review finding: a text-based (e.g. <c>.EndsWith(".trim()")</c>) gate on
    /// <c>OwnDerived</c>'s owning suffix is too narrow — a bare String passthrough with no method call at
    /// all needs the same <c>.to_string()</c> + <c>Some(...)</c>-wrap treatment as a <c>.trim()</c> body.
    /// Conversely, a projection that passes through another already-optional-declared source member — a
    /// String or a Copy-typed <c>Int</c> alike — is already <c>Option&lt;...&gt;</c>-shaped at its accessor
    /// and must be owned via a plain <c>.clone()</c> with no <c>.to_string()</c> rewrite and no
    /// <c>Some(...)</c>-wrap, regardless of the underlying type's Copy-ness.
    /// </summary>
    [Fact]
    public void Read_model_optional_derived_field_bare_and_optional_passthrough_emits_compiling_rust()
    {
        const string src =
            "context Shop {\n" +
            "  aggregate Shop root Person {\n" +
            "    entity Person identified by PersonId {\n" +
            "      name: String\n" +
            "      middleName: String?\n" +
            "      bonus: Int?\n" +
            "    }\n" +
            "  }\n" +
            "\n" +
            "  readmodel PersonSummary from Person {\n" +
            "    id\n" +
            "    bareName: String? = name\n" +
            "    passthrough: String? = middleName\n" +
            "    bonusOut: Int? = bonus\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1380 — the compiling-code proof for the trailing <c>Option&lt;T&gt;</c> constructor
    /// parameter: a caller can both override a non-optional defaulted member (<c>Order::new(id, lines,
    /// Some(OrderStatus::Placed))</c>) and omit it (<c>Order::new(id, lines, None)</c>) to fall back to
    /// the declared default — proving the parameter is genuinely usable, not just present in the
    /// signature.
    /// </summary>
    [Fact]
    public void Entity_with_defaulted_member_constructs_via_override_and_via_default()
    {
        const string src =
            "context Sales {\n" +
            "  enum OrderStatus { Draft, Placed, Shipped, Cancelled }\n" +
            "  entity Order identified by OrderId {\n" +
            "    lines:  Int\n" +
            "    status: OrderStatus = Draft\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::sales::{Order, OrderId, OrderStatus};

            /// Passing `None` falls back to the declared default (`Draft`).
            #[test]
            fn omitting_the_parameter_applies_the_declared_default() {
                let order = Order::new(OrderId::new("order-1"), 3, None).expect("valid order");
                assert_eq!(order.status(), OrderStatus::Draft);
            }

            /// Passing `Some(...)` overrides the default — the whole point of the parameter existing.
            #[test]
            fn overriding_the_parameter_constructs_a_non_default_status() {
                let order = Order::new(OrderId::new("order-1"), 3, Some(OrderStatus::Placed)).expect("valid order");
                assert_eq!(order.status(), OrderStatus::Placed);
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1380 code-review finding: a factory that explicitly initializes a trailing
    /// <c>Option&lt;T&gt;</c>-parameterized defaulted member (<c>taxRate -&gt; 5</c> for a <c>Decimal</c>
    /// field) must have that value coerced the same way the constructor's own default-value computation
    /// already is — <c>BuildFactoryCtorArgs</c>'s new <c>defaultedParams</c> branch originally wrapped
    /// the initialization value in <c>Some(...)</c> with no <c>NumericCoercionWrap</c>, so an <c>Int</c>
    /// literal assigned to a <c>Decimal</c> field emitted <c>Some(5)</c> against a <c>Some(Decimal)</c>-
    /// typed parameter — a real <c>cargo check</c> E0308 the earlier fixture never exercised (its factory
    /// never referenced the defaulted member at all).
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_defaulted_member_coerces_the_value()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    name: String\n" +
            "    taxRate: Decimal = 2\n" +
            "\n" +
            "    create make(name: String) {\n" +
            "      taxRate -> 5\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the Int literal must be coerced to Decimal
        // before being Some(...)-wrapped, not passed through raw.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Some(Decimal::from(5))");
        rust.ShouldNotContain("Some(5)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1438 — the <c>required</c> loop in <c>BuildFactoryCtorArgs</c> lacked the identical
    /// <c>NumericCoercionWrap</c> call its sibling <c>defaultedParams</c> loop already gained during
    /// #1380's own code review: a factory's explicit <c>field -&gt; expr</c> initialization of a
    /// <b>required</b> <c>Decimal</c> member with a bare <c>Int</c> literal emitted the raw, uncoerced
    /// value (<c>Self::new(id, 5)</c>) instead of <c>Decimal::from(5)</c> — a real <c>cargo check</c>
    /// E0308, not just a snapshot mismatch. Also settles the Design's open edge case: a required
    /// <c>String</c> member explicitly initialized with a string literal needs no extra call-site
    /// handling beyond what <c>TranslateOwned</c> already does — it owns any String-typed result via
    /// <c>.to_string()</c> regardless of this fix, since <c>NumericCoercionWrap</c> only ever fires for
    /// numeric mismatches.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_required_member_coerces_the_value()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal\n" +
            "    label: String\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5\n" +
            "      label -> \"std\"\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the Int literal must be coerced to Decimal
        // before being passed to Self::new, not passed through raw; the String literal is already
        // owned correctly via TranslateOwned's existing .to_string() handling.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, Decimal::from(5), \"std\".to_string())");
        rust.ShouldNotContain("Self::new(id, 5,");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1452 — the <c>required</c> loop's explicit-init branch never <c>Some(...)</c>-wraps a
    /// value for a member whose declared type is optional but has no member-level default (e.g.
    /// <c>total: Decimal?</c>), even though that identical member shape is already handled correctly by
    /// this same loop's <c>unset</c> branch three lines below (<c>m.Type.IsOptional</c> → <c>"None"</c>).
    /// The constructor signature correctly declares the parameter <c>Option&lt;Decimal&gt;</c> (an
    /// optional-declared, default-less member still needs <c>Option&lt;T&gt;</c> since it can be
    /// legitimately unset), but the explicit-init branch passed the bare, un-wrapped value — a real
    /// <c>cargo check</c> E0308.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_member_is_some_wrapped()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "    label: String\n" +
            "\n" +
            "    create make() {\n" +
            "      total -> 5\n" +
            "      label -> \"std\"\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the optional-declared required member's
        // explicit init must be numerically coerced AND Some(...)-wrapped to match the constructor's
        // Option<Decimal> parameter, not passed through as the bare, un-wrapped value.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, Some(Decimal::from(5)), \"std\".to_string())");
        rust.ShouldNotContain("Self::new(id, 5,");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Same defect (#1452), non-numeric member: the <c>Some(...)</c> wrap must apply independently of
    /// <c>NumericCoercionWrap</c> firing — an optional-declared required <c>String</c> member explicitly
    /// initialized with a string literal must also be wrapped, not just numeric ones.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_string_member_is_some_wrapped()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    label: String?\n" +
            "\n" +
            "    create make() {\n" +
            "      label -> \"std\"\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, Some(\"std\".to_string()))");
        rust.ShouldNotContain("Self::new(id, \"std\".to_string())");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Same defect (#1452), enum-typed member: confirms <c>expectedEnum</c>/<c>TranslateOwned</c> compose
    /// correctly with the new <c>Some(...)</c> wrap — coerce/translate the bare enum member first, wrap
    /// last — per the issue's Design edge cases.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_enum_member_is_some_wrapped()
    {
        const string src =
            "context Shop {\n" +
            "  enum Status { Draft, Active }\n" +
            "  entity Product identified by ProductId {\n" +
            "    status: Status?\n" +
            "\n" +
            "    create make() {\n" +
            "      status -> Draft\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, Some(Status::Draft))");
        rust.ShouldNotContain("Self::new(id, Status::Draft)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Code-review follow-up to #1452 itself: the validator legally allows a `required`-bucket
    /// optional-declared member to be explicitly initialized from an already-Option-typed source
    /// expression (e.g. a same-shaped <c>T?</c> factory parameter, <c>total -&gt; rate</c>). The naive
    /// <c>m.Type.IsOptional ? Some(owned) : owned</c> wrap this issue's own fix first added
    /// unconditionally wraps that value, producing <c>Some(rate)</c> against the constructor's
    /// <c>Option&lt;Decimal&gt;</c> parameter where <c>rate</c> is itself <c>Option&lt;Decimal&gt;</c> — a
    /// real <c>cargo check</c> E0308 (<c>Option&lt;Option&lt;Decimal&gt;&gt;</c>), the exact double-wrap
    /// shape #1437's follow-up already fixed for the sibling <c>defaultedParams</c> loop.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_a_required_member_from_an_already_optional_source_does_not_double_wrap()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(rate: Decimal?) {\n" +
            "      total -> rate\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): an already-Option-typed source value must be
        // passed through as-is, never re-wrapped in another Some(...).
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldNotContain("Some(rate");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1437: an entity member that is both optional-declared and constant-defaulted
    /// (<c>taxRate: Decimal? = 2</c>) must have a factory's explicit <c>taxRate -&gt; 5</c> initialization
    /// actually reach the constructed value — before this fix, this member class had no constructor
    /// parameter at all, so <c>BuildFactoryCtorArgs</c> never routed the factory's value anywhere and
    /// <c>Product::make()</c> silently always yielded the hardcoded default. A sibling factory that never
    /// touches <c>taxRate</c> must still fall back to the constructor's own default (#1325's coercion,
    /// now reached via the <c>None</c> arm instead of a hardcoded local).
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_defaulted_member_reaches_the_constructor()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    taxRate: Decimal? = 2\n" +
            "\n" +
            "    create make() {\n" +
            "      taxRate -> 5\n" +
            "    }\n" +
            "\n" +
            "    create makeDefault() {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::Product;

            #[test]
            fn factory_explicit_init_overrides_the_default() {
                let product = Product::make().expect("valid Product");
                assert_eq!(product.tax_rate(), &Some(Decimal::from(5)));
            }

            #[test]
            fn factory_with_no_init_falls_back_to_the_declared_default() {
                let product = Product::make_default().expect("valid Product");
                assert_eq!(product.tax_rate(), &Some(Decimal::from(2)));
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Code-review follow-up to #1437: merging the optional-declared-defaulted bucket into
    /// <c>defaultedParams</c> exposed <c>BuildFactoryCtorArgs</c>'s unconditional <c>Some(...)</c>-wrap
    /// to a source value that can itself already be <c>Option</c>-typed — a factory parameter declared
    /// <c>T?</c>, either explicitly initializing the member (<c>taxRate -&gt; rate</c>) or auto-binding to
    /// it by name. Wrapping an already-<c>Option&lt;T&gt;</c> value in another <c>Some(...)</c> produces
    /// <c>Option&lt;Option&lt;T&gt;&gt;</c> against the constructor's <c>Option&lt;T&gt;</c> parameter — a
    /// real <c>cargo check</c> E0308, reproduced on the pre-fix code for both the explicit-init and the
    /// auto-bind path.
    /// </summary>
    [Fact]
    public void Factory_with_an_already_optional_source_value_does_not_double_wrap_a_defaulted_member()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    taxRate: Decimal? = 2\n" +
            "\n" +
            "    create makeExplicit(rate: Decimal?) {\n" +
            "      taxRate -> rate\n" +
            "    }\n" +
            "\n" +
            "    create makeAutoBound(taxRate: Decimal?) {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        const string integrationTest =
            """
            use koine_domain::koine_runtime::Decimal;
            use koine_domain::shop::Product;

            #[test]
            fn explicit_init_from_an_optional_parameter_carries_a_set_value() {
                let product = Product::make_explicit(Some(Decimal::from(7))).expect("valid Product");
                assert_eq!(product.tax_rate(), &Some(Decimal::from(7)));
            }

            #[test]
            fn explicit_init_from_an_optional_parameter_falls_back_to_the_default_when_unset() {
                let product = Product::make_explicit(None).expect("valid Product");
                assert_eq!(product.tax_rate(), &Some(Decimal::from(2)));
            }

            #[test]
            fn auto_bound_optional_parameter_carries_a_set_value() {
                let product = Product::make_auto_bound(Some(Decimal::from(9))).expect("valid Product");
                assert_eq!(product.tax_rate(), &Some(Decimal::from(9)));
            }

            #[test]
            fn auto_bound_optional_parameter_falls_back_to_the_default_when_unset() {
                let product = Product::make_auto_bound(None).expect("valid Product");
                assert_eq!(product.tax_rate(), &Some(Decimal::from(2)));
            }
            """;

        var r = TestSupport.RunRust(result.Files, integrationTest);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1467 — the <c>required</c> loop's auto-bound branch never <c>Some(...)</c>-wraps the bound
    /// field for a member whose declared type is optional but has no member-level default (e.g.
    /// <c>total: Decimal?</c>), when the auto-bound factory parameter itself is declared non-optional
    /// (e.g. <c>total: Decimal</c>). The sibling <c>defaultedParams</c> loop's own auto-bound branch
    /// already carries this guard; only this loop's auto-bound branch was missing it — the second branch
    /// of this loop to need the wrap, after the explicit-init branch (#1452/PR #1464); the unset branch
    /// already handles it correctly and never needed a fix.
    /// </summary>
    [Fact]
    public void Factory_auto_bound_non_optional_parameter_binding_to_an_optional_declared_required_member_is_some_wrapped()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(total: Decimal) {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the auto-bound non-optional parameter must be
        // Some(...)-wrapped to match the constructor's Option<Decimal> parameter, not passed through as
        // the bare, un-wrapped field.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, Some(total))");
        rust.ShouldNotContain("Self::new(id, total)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Same member shape (#1467), regression guard: an auto-bound <b>optional</b> (<c>T?</c>) parameter
    /// binding to the same optional-declared required member must be unaffected — the field is already
    /// <c>Option&lt;T&gt;</c>-typed (mirroring the sibling <c>defaultedParams</c> loop's own
    /// already-correct same-shape case), so no additional wrap is applied (no double-wrap).
    /// </summary>
    [Fact]
    public void Factory_auto_bound_optional_parameter_binding_to_an_optional_declared_required_member_is_not_double_wrapped()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(total: Decimal?) {\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, total)");
        rust.ShouldNotContain("Some(total)");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Issue #1468 — the <c>required</c> loop's explicit-init branch never coerces an <b>Option-typed</b>
    /// initializing expression whose underlying numeric type differs from the declared member's (e.g. an
    /// <c>Int?</c>-typed factory parameter initializing a <c>Decimal?</c> member). <c>NumericCoercionWrap</c>
    /// unconditionally bails whenever the body's own inferred type is itself optional, so the raw
    /// <c>Option&lt;i64&gt;</c> value was passed straight through against the constructor's
    /// <c>Option&lt;Decimal&gt;</c> parameter — a real <c>cargo check</c> E0308.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_member_from_an_option_typed_mismatched_numeric_body_is_map_coerced()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal?\n" +
            "\n" +
            "    create make(rate: Int?) {\n" +
            "      total -> rate\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        // Always-on guard (no Rust toolchain required): the Option-typed, numerically-mismatched body
        // must be `.map(...)`-coerced, not passed through bare.
        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, rate.clone().map(Decimal::from))");
        rust.ShouldNotContain("Self::new(id, rate.clone())");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Same defect (#1468), the sibling <c>defaultedParams</c> loop: an Option-typed, numerically
    /// mismatched initializing expression for a member with its own default (e.g. <c>total: Decimal? =
    /// 1</c>) must also be <c>.map(...)</c>-coerced — the loop shares <c>NumericCoercionWrap</c> and
    /// neither guards the body side, so this reproduces identically.
    /// </summary>
    [Fact]
    public void Factory_defaulted_param_explicit_init_from_an_option_typed_mismatched_numeric_body_is_map_coerced()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    total: Decimal? = 1\n" +
            "\n" +
            "    create make(rate: Int?) {\n" +
            "      total -> rate\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var result = new KoineCompiler().Compile(src, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, rate.clone().map(Decimal::from))");
        rust.ShouldNotContain("Self::new(id, rate.clone())");

        var r = TestSupport.CompileRust(result.Files);
        TestSupport.RequireOrSkip(r.ToolchainAvailable, NoToolchainNotice);

        r.Ok.ShouldBeTrue(string.Join("\n", r.Errors));
    }

    /// <summary>
    /// Mirror direction (#1468): a <c>Decimal?</c>-typed body narrowing into an <c>Int?</c>-declared
    /// member must compose the same way, via <c>dec_to_i64</c> instead of <c>Decimal::from</c>. A
    /// <c>Decimal?</c>-into-<c>Int?</c> factory initialization is itself rejected upstream by the
    /// semantic validator's <c>Assignable</c> check (<c>KOI0804</c>, the same narrowing guard
    /// <c>NumericCoercionWrap</c>'s own doc comment calls out for its non-Option narrowing branch), so
    /// there is no legal <c>.koi</c> source that reaches this branch through <c>KoineCompiler.Compile</c>.
    /// Exercise the emitter directly against a parsed-but-unvalidated model instead — the same
    /// "defensive for direct emitter use" contract the sibling branch already documents.
    /// </summary>
    [Fact]
    public void Factory_explicit_init_of_an_optional_declared_required_member_from_an_option_typed_narrowing_numeric_body_is_map_coerced()
    {
        const string src =
            "context Shop {\n" +
            "  entity Product identified by ProductId {\n" +
            "    count: Int?\n" +
            "\n" +
            "    create make(rate: Decimal?) {\n" +
            "      count -> rate\n" +
            "    }\n" +
            "  }\n" +
            "}\n";
        var (model, diagnostics) = new KoineCompiler().Parse(src);
        model.ShouldNotBeNull(string.Join("\n", diagnostics.Select(d => d.ToString())));

        var files = new RustEmitter().Emit(model!);
        var rust = string.Join("\n", files.Select(f => f.Contents));
        rust.ShouldContain("Self::new(id, rate.clone().map(crate::koine_runtime::dec_to_i64))");
        rust.ShouldNotContain("Self::new(id, rate.clone())");
    }
}
