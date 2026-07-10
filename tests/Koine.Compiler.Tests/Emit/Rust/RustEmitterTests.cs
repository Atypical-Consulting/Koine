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
}
