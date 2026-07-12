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
    /// type in the smart constructor's <c>let</c>-binding loop — a <c>Decimal</c> field defaulted to a
    /// bare <c>Int</c> literal, or a <c>String</c> field defaulted to a string literal, otherwise binds a
    /// raw uncoerced value that is a real <c>cargo check</c> <c>E0308</c>. Since #1436, a non-optional
    /// defaulted member is a trailing <c>Option&lt;T&gt;</c> constructor parameter unwrapped to the (still
    /// coerced) default — the value-object dual of #1380's entity fix.
    /// </summary>
    [Fact]
    public void Value_object_constant_default_fields_coerce_to_their_declared_rust_type()
    {
        var result = new KoineCompiler().Compile(ConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("let tax_rate = tax_rate.unwrap_or_else(|| Decimal::from(2));");
        rust.ShouldNotContain("tax_rate: Decimal::from(2),");
        rust.ShouldNotContain("tax_rate: 2,");

        rust.ShouldContain("let label = label.unwrap_or_else(|| \"std\".to_string());");
        rust.ShouldNotContain("label: \"std\".to_string(),");
        rust.ShouldNotContain("label: \"std\",");
    }

    private const string ValueObjectDefaultedMemberBecomesTrailingParamModel = """
        context Shop {
          enum Currency { EUR, USD }

          value Money {
            amount: Decimal
            currency: Currency = EUR
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// Issue #1436 (value-object dual of #1380's entity fix): a value object's non-optional-declared
    /// constant-default member — one whose declared type is plain <c>T</c>, not <c>T?</c> — must become
    /// a trailing, overridable <c>Option&lt;T&gt;</c> constructor parameter, not silently dropped from the
    /// signature and hardcoded inline in <c>Ok(Self { ... })</c>. Mirrors the C# emitter's own
    /// optional-parameter shape for the identical model.
    /// </summary>
    [Fact]
    public void Value_object_non_optional_defaulted_member_becomes_trailing_option_ctor_parameter()
    {
        var result = new KoineCompiler().Compile(ValueObjectDefaultedMemberBecomesTrailingParamModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn new(amount: Decimal, currency: Option<Currency>) -> Result<Self, DomainError>");
        rust.ShouldContain("let currency = currency.unwrap_or_else(|| Currency::Eur);");
        rust.ShouldNotContain("currency: Currency::Eur,");
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
    /// <c>E0308</c> at the struct-literal field-init site. Since #1380, a non-optional defaulted member
    /// is a trailing <c>Option&lt;T&gt;</c> constructor parameter unwrapped to the (still-coerced) default.
    /// </summary>
    [Fact]
    public void Entity_constant_default_fields_coerce_to_their_declared_rust_type()
    {
        var result = new KoineCompiler().Compile(EntityConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("let tax_rate = tax_rate.unwrap_or_else(|| Decimal::from(2));");
        rust.ShouldNotContain("let tax_rate = 2;");

        rust.ShouldContain("let label = label.unwrap_or_else(|| \"std\".to_string());");
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
    /// Issue #1325 (superseded by #1463): an <b>optional</b> value-object constant-default field must be
    /// coerced to its declared underlying Rust type <i>and</i> <c>Some(...)</c>-wrapped. Since #1463, this
    /// member class is a trailing, overridable <c>Option&lt;T&gt;</c> constructor parameter (the
    /// value-object dual of #1437's entity fix) rather than a hardcoded local — the coercion itself is
    /// unchanged, only unwrapped from the parameter instead of the bare literal.
    /// </summary>
    [Fact]
    public void Value_object_optional_constant_default_fields_coerce_and_some_wrap()
    {
        var result = new KoineCompiler().Compile(OptionalConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn new(amount: Decimal, tax_rate: Option<Decimal>, label: Option<String>) -> Result<Self, DomainError>");

        rust.ShouldContain("let tax_rate = tax_rate.unwrap_or_else(|| Decimal::from(2));");
        rust.ShouldContain("let tax_rate = Some(tax_rate);");
        rust.ShouldNotContain("let tax_rate = Some(Decimal::from(2));");
        rust.ShouldNotContain("let tax_rate = 2;");

        rust.ShouldContain("let label = label.unwrap_or_else(|| \"std\".to_string());");
        rust.ShouldContain("let label = Some(label);");
        rust.ShouldNotContain("let label = Some(\"std\".to_string());");
        rust.ShouldNotContain("let label = \"std\";");
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
    /// Issue #1325 (superseded by #1437): an <b>optional</b> entity constant-default field must be
    /// coerced to its declared underlying Rust type <i>and</i> <c>Some(...)</c>-wrapped. Since #1437,
    /// this member class is a trailing, overridable <c>Option&lt;T&gt;</c> constructor parameter (the
    /// entity dual of #1380's non-optional case) rather than a hardcoded local — the coercion itself is
    /// unchanged, only unwrapped from the parameter instead of the bare literal.
    /// </summary>
    [Fact]
    public void Entity_optional_constant_default_fields_coerce_and_some_wrap()
    {
        var result = new KoineCompiler().Compile(OptionalEntityConstantDefaultCoercionModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn new(id: ProductId, amount: Decimal, tax_rate: Option<Decimal>, label: Option<String>) -> Result<Self, DomainError>");

        rust.ShouldContain("let tax_rate = tax_rate.unwrap_or_else(|| Decimal::from(2));");
        rust.ShouldContain("let tax_rate = Some(tax_rate);");
        rust.ShouldNotContain("let tax_rate = Some(Decimal::from(2));");
        rust.ShouldNotContain("let tax_rate = 2;");

        rust.ShouldContain("let label = label.unwrap_or_else(|| \"std\".to_string());");
        rust.ShouldContain("let label = Some(label);");
        rust.ShouldNotContain("let label = Some(\"std\".to_string());");
        rust.ShouldNotContain("let label = \"std\";");
    }

    private const string EntityInvariantReferencingConstantDefaultedOptionalMemberModel = """
        context Shop {
          entity Product identified by ProductId {
            amount: Decimal
            taxRate: Decimal? = 2
            invariant taxRate >= amount when taxRate.isPresent "tax rate must be at least amount"
          }
        }
        """;

    /// <summary>
    /// Issue #1472: an entity invariant's <c>isPresent</c> guard on a constant-defaulted, optional-
    /// declared member must short-circuit to the literal <c>true</c> — by the time the invariant guards
    /// run, the ctor's <c>unwrap_or_else</c> has already resolved the member to a bare, always-present
    /// value (the <c>Some(...)</c> re-wrap now happens after, see #1472's entity/VO reorder fix), so
    /// <c>.is_some()</c> would be a real <c>cargo check</c> <c>E0599</c> against that bare local.
    /// </summary>
    [Fact]
    public void Entity_invariant_isPresent_on_constant_defaulted_member_short_circuits_to_true()
    {
        var result = new KoineCompiler().Compile(EntityInvariantReferencingConstantDefaultedOptionalMemberModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("if true && !(tax_rate >= amount) {");
        rust.ShouldNotContain("tax_rate.is_some()");
    }

    private const string ValueObjectInvariantReferencingConstantDefaultedOptionalMemberModel = """
        context Shop {
          value Money {
            amount: Decimal
            taxRate: Decimal? = 2
            invariant taxRate >= amount when taxRate.isPresent "tax rate must be at least amount"
          }
        }
        """;

    /// <summary>
    /// Issue #1472: the value-object dual of the entity case above — <c>WriteSmartConstructor</c>'s
    /// invariant guards must see the same short-circuited <c>isPresent</c>.
    /// </summary>
    [Fact]
    public void Value_object_invariant_isPresent_on_constant_defaulted_member_short_circuits_to_true()
    {
        var result = new KoineCompiler().Compile(ValueObjectInvariantReferencingConstantDefaultedOptionalMemberModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("if true && !(tax_rate >= amount) {");
        rust.ShouldNotContain("tax_rate.is_some()");
    }

    /// <summary>
    /// Issue #1472 edge case: the short-circuit is scoped to the smart-constructor window, where
    /// <c>unwrap_or_else</c> has already resolved the member to a bare local. A <b>derived</b> member's
    /// getter is a different call site — it reads the stored <c>self.tax_rate</c>, which really is an
    /// <c>Option&lt;Decimal&gt;</c> — so its <c>isPresent</c> must fall through to a real
    /// <c>.is_some()</c> and NOT be folded to <c>true</c>.
    /// </summary>
    [Fact]
    public void Derived_member_isPresent_on_constant_defaulted_member_still_emits_is_some()
    {
        const string model = """
            context Shop {
              value Money {
                amount: Decimal
                taxRate: Decimal? = 2
                hasTaxRate: Bool = taxRate.isPresent
              }
            }
            """;

        var result = new KoineCompiler().Compile(model, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("self.tax_rate.is_some()");
    }

    private const string EntityOptionalDefaultedMemberBecomesTrailingParamModel = """
        context Shop {
          entity Product identified by ProductId {
            taxRate: Decimal? = 2
          }
        }
        """;

    /// <summary>
    /// Issue #1437: an entity member that is both optional-declared (<c>T?</c>) and constant-defaulted
    /// must become a trailing, overridable <c>Option&lt;T&gt;</c> constructor parameter — #1380 only
    /// merged the non-optional-declared bucket into this shape, leaving the already-optional bucket
    /// hardcoded and un-overridable.
    /// </summary>
    [Fact]
    public void Entity_optional_declared_defaulted_member_becomes_trailing_option_ctor_parameter()
    {
        var result = new KoineCompiler().Compile(EntityOptionalDefaultedMemberBecomesTrailingParamModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn new(id: ProductId, tax_rate: Option<Decimal>) -> Result<Self, DomainError>");
        rust.ShouldContain("let tax_rate = tax_rate.unwrap_or_else(|| Decimal::from(2));");
        rust.ShouldContain("let tax_rate = Some(tax_rate);");
        rust.ShouldNotContain("let tax_rate = Some(Decimal::from(2));");
    }

    private const string ValueObjectOptionalDefaultedMemberBecomesTrailingParamModel = """
        context Shop {
          value Money {
            amount: Decimal
            taxRate: Decimal? = 2
            invariant amount >= 0 "an amount cannot be negative"
          }
        }
        """;

    /// <summary>
    /// Issue #1463 (value-object dual of #1437): a value object's optional-declared (<c>T?</c>) *and*
    /// constant-defaulted member must become a trailing, overridable <c>Option&lt;T&gt;</c> constructor
    /// parameter — #1436 only merged the non-optional-declared bucket into this shape, leaving the
    /// already-optional bucket hardcoded and un-overridable via <c>Money::new(...)</c>.
    /// </summary>
    [Fact]
    public void Value_object_optional_declared_defaulted_member_becomes_trailing_option_ctor_parameter()
    {
        var result = new KoineCompiler().Compile(ValueObjectOptionalDefaultedMemberBecomesTrailingParamModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn new(amount: Decimal, tax_rate: Option<Decimal>) -> Result<Self, DomainError>");
        rust.ShouldContain("let tax_rate = tax_rate.unwrap_or_else(|| Decimal::from(2));");
        rust.ShouldContain("let tax_rate = Some(tax_rate);");
        rust.ShouldNotContain("tax_rate: Some(Decimal::from(2)),");
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

    private const string NestedCoalesceBothOptionalModel = """
        context Shop {
          value Money {
            amount: Int
            bonus: Int?
            fallback: Int?
            backup: Int?
            total: Int? = bonus ?? (fallback ?? backup)
          }
        }
        """;

    /// <summary>
    /// Issue #1333 edge case: a nested <c>CoalesceExpr</c> as the right operand of an outer coalesce
    /// (<c>bonus ?? (fallback ?? backup)</c>) must pick <c>.or_else(...)</c> at BOTH levels — the outer
    /// method-name choice depends on the inner coalesce's own inferred optionality, and
    /// <c>WriteOperandValue</c>'s leaf-place clone logic must not append a spurious <c>.clone()</c> after
    /// the inner coalesce's rendered call chain (a <c>CoalesceExpr</c> is not an <c>IdentifierExpr</c>/
    /// <c>MemberAccessExpr</c> place).
    /// </summary>
    [Fact]
    public void Value_object_coalesce_with_nested_optional_coalesce_right_operand_renders_or_else_at_both_levels()
    {
        var result = new KoineCompiler().Compile(NestedCoalesceBothOptionalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn total(&self) -> Option<i64> {");
        rust.ShouldContain("self.bonus.clone().or_else(|| self.fallback.clone().or_else(|| self.backup.clone()))");
        rust.ShouldNotContain(".unwrap_or_else(");
    }

    private const string OptionalDerivedTrimOwnershipModel = """
        context Shop {
          value Person {
            name: String
            nickname: String? = name.trim
            slug: String = name.trim
          }
        }
        """;

    /// <summary>
    /// Issue #1332: an optional-declared <c>String?</c> derived member whose bare body ends in
    /// <c>.trim()</c> must own the result via <c>.to_string()</c> before <c>WriteDerived</c>'s
    /// <c>Some(...)</c>-wrap (#1329) is applied — the <c>.trim()</c>-owning branch's gate previously
    /// only recognized a non-optional-declared <c>String</c> member (<c>m.Type is { Name: "String",
    /// IsOptional: false }</c>), so an optional-declared sibling fell through to the generic
    /// <c>.clone()</c> fallback, which is a no-op on a borrowed <c>&amp;str</c> — a real <c>cargo
    /// check</c> <c>E0308</c>. <c>slug</c> is the non-optional-declared sibling: the condition change
    /// is a no-op for it (<c>underlyingType == m.Type</c> when not optional), so it isn't exercising the
    /// fix itself — it pins the pre-existing, previously-uncovered baseline rendering so a future change
    /// to this branch can't silently regress it too.
    /// </summary>
    [Fact]
    public void Value_object_optional_derived_member_with_trim_body_owns_the_result()
    {
        var result = new KoineCompiler().Compile(OptionalDerivedTrimOwnershipModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("pub fn nickname(&self) -> Option<String> {");
        rust.ShouldContain("Some(self.name.trim().to_string())");
        rust.ShouldNotContain("Some(self.name.trim().clone())");

        rust.ShouldContain("pub fn slug(&self) -> String {");
        rust.ShouldContain("self.name.trim().to_string()");
    }

    private const string ConditionalOptionalIntWidenBranchModel = """
        context Shop {
          value Money {
            decimalAmount: Decimal
            intBonus: Int?
            total: Decimal? = if decimalAmount > 0 then decimalAmount else intBonus
          }
        }
        """;

    /// <summary>
    /// Issue #1335: a <c>ConditionalExpr</c> derived-member body whose numeric-widen-needing branch
    /// (a bare <c>Int</c>-named type) is itself <b>optional</b> (<c>Int?</c>), while its sibling is a
    /// non-optional <c>Decimal</c>, must render as <c>&lt;owned rendering&gt;.map(Decimal::from)</c> —
    /// not the bare <c>Decimal::from(...)</c> prefix, which is invalid for an <c>Option&lt;i64&gt;</c>
    /// operand and does not produce the <c>Option&lt;Decimal&gt;</c> the arm's type requires.
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_maps_instead_of_wrapping()
    {
        var result = new KoineCompiler().Compile(ConditionalOptionalIntWidenBranchModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("if self.decimal_amount > Decimal::from(0i64) { Some(self.decimal_amount) } else { self.int_bonus.clone().map(Decimal::from) }");
        rust.ShouldNotContain("Decimal::from(self.int_bonus");
    }

    private const string ConditionalOptionalIntWidenBothOptionalModel = """
        context Shop {
          value Money {
            amount: Int
            bonusDecimal: Decimal?
            bonusInt: Int?
            total: Decimal? = if amount > 0 then bonusDecimal else bonusInt
          }
        }
        """;

    /// <summary>
    /// Issue #1335: the same optional-Int-widen-needing branch, but its sibling is ITSELF optional
    /// (<c>Decimal?</c>, not a bare <c>Decimal</c>) — the branch still needs
    /// <c>.map(Decimal::from)</c> to reach <c>Option&lt;Decimal&gt;</c>, matching the sibling's own
    /// already-<c>Option</c>-shaped rendering (no <c>Some(...)</c> involved on either side).
    /// </summary>
    [Fact]
    public void Conditional_branch_with_optional_int_widen_maps_against_an_optional_decimal_sibling()
    {
        var result = new KoineCompiler().Compile(ConditionalOptionalIntWidenBothOptionalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("if self.amount > 0 { self.bonus_decimal.clone() } else { self.bonus_int.clone().map(Decimal::from) }");
        rust.ShouldNotContain("Decimal::from(self.bonus_int");
    }

    private const string OptionalIntIdentifierComparedToDecimalModel = """
        context Shop {
          value Money {
            a: Int?
            c: Decimal
            isEq: Bool = a == c
          }
        }
        """;

    /// <summary>
    /// Issue #1343: a bare optional <c>Int?</c> identifier compared via <c>==</c> to a non-optional
    /// <c>Decimal</c> reaches <c>EmitCoerced</c> (via <c>WriteIdentifier</c>), which previously wrapped
    /// it in a bare <c>Decimal::from(...)</c> prefix — invalid Rust for an <c>Option&lt;i64&gt;</c>
    /// operand (E0277), the same defect class #1335 fixed for <c>WriteReconciledBranch</c>. The coerced
    /// operand must map inside its Option instead, and — since the two sides of <c>==</c> must share the
    /// same Rust type — the opposite (non-optional) <c>Decimal</c> operand must itself become
    /// <c>Some(...)</c>-wrapped to match.
    /// </summary>
    [Fact]
    public void Optional_int_identifier_compared_via_equality_to_decimal_maps_instead_of_wrapping()
    {
        var result = new KoineCompiler().Compile(OptionalIntIdentifierComparedToDecimalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("self.a.map(Decimal::from) == Some(self.c)");
        rust.ShouldNotContain("Decimal::from(self.a)");
    }

    private const string OptionalIntConditionalComparedToDecimalModel = """
        context Shop {
          value Money {
            flag: Bool
            x: Int
            y: Int?
            c: Decimal
            isEq: Bool = (if flag then x else y) == c
          }
        }
        """;

    /// <summary>
    /// Issue #1343: a compound (conditional) operand that itself yields an optional <c>Int?</c> (per
    /// #975's branch-optionality join) compared via <c>==</c> to a non-optional <c>Decimal</c> reaches
    /// <c>WriteArithmeticOperand</c>'s compound-operand wrap, which previously wrapped the whole
    /// rendered <c>if</c>/<c>else</c> in a bare <c>Decimal::from(...)</c> prefix — invalid Rust once the
    /// block itself evaluates to <c>Option&lt;i64&gt;</c>. Mirrors the bare-identifier case above, one
    /// level up.
    /// </summary>
    [Fact]
    public void Compound_optional_int_conditional_compared_via_equality_to_decimal_maps_instead_of_wrapping()
    {
        var result = new KoineCompiler().Compile(OptionalIntConditionalComparedToDecimalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain(
            "(if self.flag { Some(self.x) } else { self.y.clone() }).map(Decimal::from) == Some(self.c)");
        rust.ShouldNotContain("Decimal::from(if ");
    }

    private const string OptionalIntComparedToOptionalDecimalModel = """
        context Shop {
          value Money {
            a: Int?
            d: Decimal?
            isEq: Bool = a == d
          }
        }
        """;

    /// <summary>
    /// Issue #1343 edge case: when the opposite operand is ITSELF optional (<c>Decimal?</c>, not a bare
    /// <c>Decimal</c>), the coerced operand still needs <c>.map(Decimal::from)</c> to reach
    /// <c>Option&lt;Decimal&gt;</c> — matching the sibling's own already-<c>Option</c>-shaped rendering,
    /// with no <c>Some(...)</c> wrap needed on either side (mirrors #1335's identical "both optional"
    /// edge case for <c>WriteReconciledBranch</c>).
    /// </summary>
    [Fact]
    public void Optional_int_compared_to_optional_decimal_maps_with_no_some_wrap_on_either_side()
    {
        var result = new KoineCompiler().Compile(OptionalIntComparedToOptionalDecimalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("self.a.map(Decimal::from) == self.d");
        rust.ShouldNotContain("Some(");
    }

    private const string NonOptionalIntComparedToOptionalDecimalModel = """
        context Shop {
          value Money {
            c: Decimal?
            a: Int
            isEq: Bool = c == a
          }
        }
        """;

    /// <summary>
    /// Issue #1343 code-review finding: the mirror of the bare-identifier case above — here the
    /// Int-named operand (<c>a</c>) is NOT optional, but the opposite, already-<c>Decimal</c>-named
    /// operand (<c>c</c>) IS optional (<c>Decimal?</c>). The Int side still widens bare (no
    /// <c>.map(...)</c> needed, since it isn't itself optional), but the widened result must now become
    /// <c>Some(...)</c>-wrapped to match its optional sibling — composing as <c>Some(Decimal::from(...))</c>
    /// (wrap outside, widen inside), the same nesting order #1331 established for
    /// <c>WriteReconciledBranch</c>. <c>someWrapLeft</c>/<c>someWrapRight</c> must key off EACH side's own
    /// optionality, not off which side happens to be the Int-named one.
    /// </summary>
    [Fact]
    public void Non_optional_int_compared_to_optional_decimal_some_wraps_the_widened_side()
    {
        var result = new KoineCompiler().Compile(NonOptionalIntComparedToOptionalDecimalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("self.c == Some(Decimal::from(self.a))");
        rust.ShouldNotContain("Decimal::from(Some(");
    }

    private const string OptionalIntMemberAccessComparedToDecimalModel = """
        context Shop {
          value Discount {
            amount: Int?
          }
          value Money {
            d: Discount
            c: Decimal
            isEq: Bool = d.amount == c
          }
        }
        """;

    /// <summary>
    /// Issue #1354: a <c>MemberAccessExpr</c> operand (<c>d.amount</c>, a nested value object's optional
    /// <c>Int?</c> member read through its accessor) compared via <c>==</c> to a non-optional
    /// <c>Decimal</c> reaches <c>WriteArithmeticOperand</c>'s <c>MemberAccessExpr</c>/<c>CallExpr</c>/
    /// <c>UnaryExpr</c> wrap branch (added by #1316/#1321 for a non-optional tight-binding operand),
    /// which — unlike the identifier and compound-operand branches #1343/#1347 already fixed — still
    /// wrapped it in a bare <c>Decimal::from(...)</c> prefix, invalid Rust for an accessor returning
    /// <c>&amp;Option&lt;i64&gt;</c> (E0277). The coerced operand must map inside its Option instead,
    /// with the opposite (non-optional) <c>Decimal</c> operand becoming <c>Some(...)</c>-wrapped to
    /// match.
    /// </summary>
    [Fact]
    public void Optional_int_member_access_operand_compared_via_equality_to_decimal_maps_instead_of_wrapping()
    {
        var result = new KoineCompiler().Compile(OptionalIntMemberAccessComparedToDecimalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain("self.d.amount().map(Decimal::from) == Some(self.c)");
        rust.ShouldNotContain("Decimal::from(self.d.amount())");
    }

    private const string OptionalIntCallOperandComparedToDecimalModel = """
        context Shop {
          value LineItem {
            bonus: Int?
          }
          value Invoice {
            items: List<LineItem>
            taxRate: Decimal
            isEq: Bool = items.max(i => i.bonus) == taxRate
          }
        }
        """;

    /// <summary>
    /// Issue #1354, second shape: a <c>CallExpr</c> operand (<c>items.max(i =&gt; i.bonus)</c>, an
    /// aggregate over an optional <c>Int?</c> selector) compared via <c>==</c> to a non-optional
    /// <c>Decimal</c> hits the SAME <c>WriteArithmeticOperand</c> branch as the <c>MemberAccessExpr</c>
    /// case above — confirms the fix keys off the operand's own <c>type</c>, not its expression shape.
    /// </summary>
    [Fact]
    public void Optional_int_call_operand_compared_via_equality_to_decimal_maps_instead_of_wrapping()
    {
        var result = new KoineCompiler().Compile(OptionalIntCallOperandComparedToDecimalModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        rust.ShouldContain(
            "crate::koine_runtime::koine_max(self.items.iter().map(|i| i.bonus().clone()))" +
            ".map(Decimal::from) == Some(self.tax_rate)");
        rust.ShouldNotContain("Decimal::from(crate::koine_runtime::koine_max(");
    }

    private const string NestedLetShadowingOuterBindingModel = """
        context Shop {
          value Money {
            amount: Int?
            rate: Decimal
            hasMatchingRate: Bool = let n = amount in (let n = rate in n == rate) && n == rate
          }
        }
        """;

    /// <summary>
    /// Issue #1370: <c>PopLocal</c> unconditionally evicted a name from the flat <c>_locals</c>/
    /// <c>_localTypes</c> tracking instead of restoring whatever was there before the matching
    /// <c>PushLocal</c>. Here the inner <c>let n = rate in n == rate</c> shadows the outer
    /// <c>let n = amount in ...</c> binding; once the inner <c>let</c>'s block closes, the corrupted
    /// pop evicts <c>n</c> entirely rather than restoring the outer <c>n: Int?</c> binding — so the
    /// second, outer <c>n == rate</c> comparison no longer recognizes <c>n</c> as a local at all and
    /// renders it as a bare, uncoerced identifier instead of widening it via
    /// <c>.map(Decimal::from)</c> against the <c>Decimal</c>-typed <c>rate</c> — a real
    /// <c>cargo check</c> E0308 (comparing <c>Option&lt;i64&gt;</c> to <c>Decimal</c>).
    /// </summary>
    [Fact]
    public void Nested_let_shadowing_an_outer_binding_restores_the_outer_binding_after_the_inner_pop()
    {
        var result = new KoineCompiler().Compile(NestedLetShadowingOuterBindingModel, new RustEmitter());
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));

        var rust = string.Join("\n", result.Files.Select(f => f.Contents));

        // The inner `let n = rate in n == rate` legitimately renders as `n == self.rate` (both operands
        // Decimal, no coercion needed) — asserting on the whole method body (rather than a bare
        // `ShouldNotContain("n == self.rate")`) avoids colliding with that correct inner occurrence while
        // still pinning that the OUTER `n` (still `Int?`, restored after the inner pop) is widened.
        rust.ShouldContain(
            "{ let n = self.amount.clone(); ({ let n = self.rate; n == self.rate }) && " +
            "(n.map(Decimal::from) == Some(self.rate)) }");
    }
}
