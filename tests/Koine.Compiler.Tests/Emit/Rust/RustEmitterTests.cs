using Koine.Compiler.Emit;
using Koine.Compiler.Services;

namespace Koine.Compiler.Tests;

/// <summary>
/// Plumbing-level coverage for the Rust backend (issue #24, Task 1): the <c>rust</c> target is
/// registered, resolves through the shared <see cref="EmitterRegistry"/> exactly like the other
/// targets, and a <c>--target rust</c> compile runs end-to-end without throwing. The construct
/// emitters and their snapshot/<c>cargo</c> coverage land in later tasks.
/// </summary>
public class RustEmitterTests
{
    private const string TrivialModel = """
        context Billing {
          enum Currency { EUR, USD, GBP }
        }
        """;

    [Fact]
    public void Rust_target_is_registered_in_the_unified_registry()
    {
        var registry = new EmitterRegistry(BuiltInEmitterProviders.All);
        registry.IsSupported("rust").ShouldBeTrue();
        registry.SupportedTargets.ShouldContain("rust");
    }

    [Fact]
    public void Rust_emitter_reports_its_target_name()
    {
        new RustEmitter().TargetName.ShouldBe("rust");
    }

    [Fact]
    public void Empty_options_resolve_a_rust_emitter()
    {
        var registry = new EmitterRegistry(BuiltInEmitterProviders.All);
        registry.TryCreate("rust", EmitterOptions.Empty, out var emitter).ShouldBeTrue();
        emitter.ShouldNotBeNull();
        emitter.TargetName.ShouldBe("rust");
    }

    [Fact]
    public void Rust_build_of_a_trivial_model_runs_without_throwing()
    {
        var result = new KoineCompiler().Compile(TrivialModel, new RustEmitter());

        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        result.Files.ShouldNotBeNull();
    }

    private const string ConstantDefaultCoercionModel = """
        context Shop {
          value Money {
            amount: Decimal
            taxRate: Decimal = 2
            label: String = "std"
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// Issue #1319: a value object's constant-default field must be coerced/owned to its declared Rust
    /// type in the smart constructor's <c>Ok(Self { ... })</c> literal — a <c>Decimal</c> field defaulted
    /// to a bare <c>Int</c> literal, or a <c>String</c> field defaulted to a string literal, otherwise
    /// emits a raw uncoerced initializer that is a real <c>cargo check</c> <c>E0308</c>.
    /// </summary>
    [Fact]
    public void Value_object_constant_default_fields_coerce_to_their_declared_rust_type()
    {
        var result = new KoineCompiler().Compile(ConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("tax_rate: Decimal::from(2),");
        rust.ShouldNotContain("tax_rate: 2,");

        rust.ShouldContain("label: \"std\".to_string(),");
        rust.ShouldNotContain("label: \"std\",");
    }

    private const string EntityConstantDefaultCoercionModel = """
        context Shop {
          entity Product identified by ProductId {
            amount: Decimal
            taxRate: Decimal = 2
            label: String = "std"
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// Issue #1324: an entity's constant-default field must be coerced/owned to its declared Rust type
    /// in the smart constructor's <c>let</c>-binding loop — the entity dual of #1319's value-object fix.
    /// A <c>Decimal</c> field defaulted to a bare <c>Int</c> literal, or a <c>String</c> field defaulted
    /// to a string literal, otherwise binds a raw uncoerced local that is a real <c>cargo check</c>
    /// <c>E0308</c> at the struct-literal field-init site.
    /// </summary>
    [Fact]
    public void Entity_constant_default_fields_coerce_to_their_declared_rust_type()
    {
        var result = new KoineCompiler().Compile(EntityConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("let tax_rate = Decimal::from(2);");
        rust.ShouldNotContain("let tax_rate = 2;");

        rust.ShouldContain("let label = \"std\".to_string();");
        rust.ShouldNotContain("let label = \"std\";");
    }

    private const string OptionalConstantDefaultCoercionModel = """
        context Shop {
          value Money {
            amount: Decimal
            taxRate: Decimal? = 2
            label: String? = "std"
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// Issue #1325: an <b>optional</b> value-object constant-default field must be coerced to its
    /// declared underlying Rust type <i>and</i> <c>Some(...)</c>-wrapped in the smart constructor's
    /// <c>Ok(Self { ... })</c> literal — #1319 only handles the non-optional case, so an
    /// <c>Option&lt;Decimal&gt;</c>/<c>Option&lt;String&gt;</c> field defaulted to a bare literal is
    /// otherwise left completely uncoerced, a real <c>cargo check</c> <c>E0308</c>.
    /// </summary>
    [Fact]
    public void Value_object_optional_constant_default_fields_coerce_and_some_wrap()
    {
        var result = new KoineCompiler().Compile(OptionalConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("tax_rate: Some(Decimal::from(2)),");
        rust.ShouldNotContain("tax_rate: 2,");

        rust.ShouldContain("label: Some(\"std\".to_string()),");
        rust.ShouldNotContain("label: \"std\",");
    }

    private const string OptionalEntityConstantDefaultCoercionModel = """
        context Shop {
          entity Product identified by ProductId {
            amount: Decimal
            taxRate: Decimal? = 2
            label: String? = "std"
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// Issue #1325: an <b>optional</b> entity constant-default field must be coerced to its declared
    /// underlying Rust type <i>and</i> <c>Some(...)</c>-wrapped in the smart constructor's <c>let</c>-
    /// binding loop — the entity dual of the value-object fix above; #1324 only handles the non-optional
    /// case.
    /// </summary>
    [Fact]
    public void Entity_optional_constant_default_fields_coerce_and_some_wrap()
    {
        var result = new KoineCompiler().Compile(OptionalEntityConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("let tax_rate = Some(Decimal::from(2));");
        rust.ShouldNotContain("let tax_rate = 2;");

        rust.ShouldContain("let label = Some(\"std\".to_string());");
        rust.ShouldNotContain("let label = \"std\";");
    }

    private const string OptionalDerivedNarrowerNumericModel = """
        context Shop {
          value Money {
            amount: Int
            surcharge: Int
            total: Decimal? = amount + surcharge
          }
        }
        """;

    /// <summary>
    /// Issue #1329: an optional-declared derived member (<c>Decimal?</c>) whose bare body infers to a
    /// narrower/different numeric type (<c>Int</c>) must be coerced to the declared underlying type
    /// <i>and</i> <c>Some(...)</c>-wrapped — <c>NumericCoercionWrap</c>'s existing <c>declared.IsOptional</c>
    /// short-circuit otherwise left it entirely uncoerced and unwrapped, a real <c>cargo check</c>
    /// <c>E0308</c> (bare <c>i64</c> body against a declared <c>Option&lt;Decimal&gt;</c> return type).
    /// </summary>
    [Fact]
    public void Value_object_optional_derived_member_with_bare_narrower_numeric_body_coerces_and_wraps()
    {
        var result = new KoineCompiler().Compile(OptionalDerivedNarrowerNumericModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn total(&self) -> Option<Decimal> {");
        rust.ShouldContain("Some(Decimal::from(self.amount + self.surcharge))");
        rust.ShouldNotContain("{\n        self.amount + self.surcharge\n");
    }

    private const string OptionalDerivedSameTypeNumericModel = """
        context Shop {
          value Money {
            amount: Int
            surcharge: Int
            total: Int? = amount + surcharge
          }
        }
        """;

    /// <summary>
    /// Issue #1329: an optional-declared derived member whose bare body already infers to the SAME
    /// underlying numeric type (<c>Int?</c> declared, <c>Int</c> body) needs no numeric coercion — but
    /// still needs the <c>Some(...)</c> wrap, since the accessor's declared return type is
    /// <c>Option&lt;i64&gt;</c> while the bare body is a plain <c>i64</c>.
    /// </summary>
    [Fact]
    public void Value_object_optional_derived_member_with_bare_same_type_numeric_body_wraps_without_coercion()
    {
        var result = new KoineCompiler().Compile(OptionalDerivedSameTypeNumericModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn total(&self) -> Option<i64> {");
        rust.ShouldContain("Some(self.amount + self.surcharge)");
        rust.ShouldNotContain("{\n        self.amount + self.surcharge\n");
    }

    private const string OptionalDerivedConditionalNumericModel = """
        context Shop {
          value Money {
            amount: Int
            total: Decimal? = if amount > 0 then amount else 0
          }
        }
        """;

    /// <summary>
    /// Issue #1329: the owned-value (<c>ConditionalExpr</c>/<c>LetExpr</c>/<c>GuardExpr</c>) coercion
    /// site needs the identical treatment as the bare-body site — a conditional whose branches are both
    /// non-optional numeric, assigned to a wider optional declared type, must coerce the whole rendered
    /// conditional and <c>Some(...)</c>-wrap it.
    /// </summary>
    [Fact]
    public void Value_object_optional_derived_member_with_conditional_numeric_body_coerces_and_wraps()
    {
        var result = new KoineCompiler().Compile(OptionalDerivedConditionalNumericModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn total(&self) -> Option<Decimal> {");
        rust.ShouldContain("Some(Decimal::from(if self.amount > 0 { self.amount } else { 0 }))");
    }

    private const string OptionalDerivedAlreadyOptionalConditionalModel = """
        context Shop {
          value Money {
            amount: Int
            bonus: Int?
            fallback: Int?
            total: Int? = if amount > 0 then bonus else fallback
          }
        }
        """;

    /// <summary>
    /// Regression guard (issue #1329): a <c>ConditionalExpr</c>-bodied derived member whose branches are
    /// THEMSELVES optional (both <c>bonus</c> and <c>fallback</c> are <c>Int?</c>) must keep rendering
    /// exactly as today — no additional <c>Some(...)</c> wrap around the whole conditional, which would
    /// double-wrap an already-<c>Option</c>-shaped body. Must pass both before and after the fix.
    /// </summary>
    [Fact]
    public void Value_object_optional_derived_member_with_already_optional_conditional_body_stays_unwrapped()
    {
        var result = new KoineCompiler().Compile(OptionalDerivedAlreadyOptionalConditionalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn total(&self) -> Option<i64> {");
        rust.ShouldContain("if self.amount > 0 { self.bonus.clone() } else { self.fallback.clone() }");
        rust.ShouldNotContain("Some(if self.amount > 0");
    }

    private const string ConditionalBranchOptionalityMismatchModel = """
        context Shop {
          value Money {
            amount: Int
            bonus: Int?
            total: Int? = if amount > 0 then amount else bonus
          }
        }
        """;

    /// <summary>
    /// Issue #1331: a <c>ConditionalExpr</c> derived-member body whose two branches disagree in
    /// optionality (a bare non-optional <c>amount: Int</c> branch against an optional <c>bonus: Int?</c>
    /// sibling) must <c>Some(...)</c>-wrap the non-optional branch so both <c>if</c>/<c>else</c> arms
    /// share the same Rust type — <c>WriteReconciledBranch</c> previously only reconciled a numeric
    /// (Int→Decimal) mismatch between branches, never an optionality one, a real <c>cargo check</c>
    /// <c>E0308</c>.
    /// </summary>
    [Fact]
    public void Value_object_conditional_branch_with_optionality_mismatch_some_wraps_the_non_optional_branch()
    {
        var result = new KoineCompiler().Compile(ConditionalBranchOptionalityMismatchModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("if self.amount > 0 { Some(self.amount) } else { self.bonus.clone() }");
        rust.ShouldNotContain("{ self.amount } else");
    }

    private const string ConditionalBranchOptionalityAndNumericMismatchModel = """
        context Shop {
          value Money {
            amount: Int
            bonusAmount: Decimal?
            total: Decimal? = if amount > 0 then amount else bonusAmount
          }
        }
        """;

    /// <summary>
    /// Issue #1331: when the non-optional branch also needs the existing numeric Int→Decimal widen, the
    /// two reconciliations must compose in the correct nesting order — <c>Some(Decimal::from(...))</c>,
    /// not <c>Decimal::from(Some(...))</c> (the latter is not valid Rust, since <c>Decimal::from</c>
    /// doesn't accept an <c>Option&lt;Decimal&gt;</c>).
    /// </summary>
    [Fact]
    public void Value_object_conditional_branch_with_optionality_and_numeric_mismatch_composes_wrap_and_widen()
    {
        var result = new KoineCompiler().Compile(ConditionalBranchOptionalityAndNumericMismatchModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("if self.amount > 0 { Some(Decimal::from(self.amount)) } else { self.bonus_amount.clone() }");
        rust.ShouldNotContain("Decimal::from(Some(");
        rust.ShouldNotContain("{ Decimal::from(self.amount) } else");
    }

    private const string CoalesceBothOperandsOptionalModel = """
        context Shop {
          value Money {
            amount: Int
            bonus: Int?
            fallback: Int?
            total: Int? = bonus ?? fallback
          }
        }
        """;

    /// <summary>
    /// Issue #1333: a <c>CoalesceExpr</c> (<c>a ?? b</c>) whose right operand <c>b</c> is itself
    /// optional must render <c>.or_else(...)</c> — an <c>Option&lt;T&gt;</c>-preserving fallback — not
    /// <c>.unwrap_or_else(...)</c>, which force-unwraps to a bare <c>T</c> and fails a real
    /// <c>cargo check</c> <c>E0308</c> (the closure returns <c>Option&lt;T&gt;</c>, not <c>T</c>).
    /// </summary>
    [Fact]
    public void Value_object_coalesce_with_optional_right_operand_renders_or_else()
    {
        var result = new KoineCompiler().Compile(CoalesceBothOperandsOptionalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn total(&self) -> Option<i64> {");
        rust.ShouldContain("self.bonus.clone().or_else(|| self.fallback.clone())");
        rust.ShouldNotContain(".unwrap_or_else(");
    }

    private const string CoalesceNonOptionalRightOperandModel = """
        context Shop {
          value Money {
            amount: Int
            bonus: Int?
            total: Int = bonus ?? 0
          }
        }
        """;

    /// <summary>
    /// Regression guard (issue #1333): a <c>CoalesceExpr</c> whose right operand is non-optional (the
    /// pre-existing, already-correct case) must keep rendering <c>.unwrap_or_else(...)</c> unchanged.
    /// Must pass both before and after the fix.
    /// </summary>
    [Fact]
    public void Value_object_coalesce_with_non_optional_right_operand_keeps_unwrap_or_else()
    {
        var result = new KoineCompiler().Compile(CoalesceNonOptionalRightOperandModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn total(&self) -> i64 {");
        rust.ShouldContain("self.bonus.clone().unwrap_or_else(|| 0)");
    }
}
