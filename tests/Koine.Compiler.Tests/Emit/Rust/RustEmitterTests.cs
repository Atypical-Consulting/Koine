using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Rust;
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
}
