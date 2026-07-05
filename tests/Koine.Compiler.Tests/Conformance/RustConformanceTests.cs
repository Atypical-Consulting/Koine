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
}
