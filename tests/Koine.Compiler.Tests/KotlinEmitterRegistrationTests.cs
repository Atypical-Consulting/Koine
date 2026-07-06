using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Kotlin backend (issue #1066) plugs in behind the existing <see cref="IEmitterProvider"/> /
/// <see cref="IEmitter"/> seam, exactly like the Rust (#24) and Java (#858) backends: registering
/// <c>KotlinEmitterProvider</c> in <see cref="BuiltInEmitterProviders.All"/> is all it takes for the
/// unified <see cref="EmitterRegistry"/> — and thus the CLI, MCP, and Studio — to offer
/// <c>--target kotlin</c>. This suite locks the skeleton: the target resolves, the provider carries the
/// <c>Kotlin</c>/<c>.kt</c> metadata, and the emitter names itself <c>kotlin</c>.
/// </summary>
public class KotlinEmitterRegistrationTests
{
    [Fact]
    public void Registry_supports_the_kotlin_target()
    {
        new EmitterRegistry(BuiltInEmitterProviders.All).IsSupported("kotlin").ShouldBeTrue();
    }

    [Fact]
    public void Provider_metadata_is_kotlin_display_and_extension()
    {
        var provider = BuiltInEmitterProviders.All.Single(p => p.Target == "kotlin");

        provider.DisplayName.ShouldBe("Kotlin");
        provider.FileExtension.ShouldBe(".kt");
        provider.IsEmitTarget.ShouldBeTrue();
    }

    [Fact]
    public void Provider_creates_an_emitter_named_kotlin()
    {
        new EmitterRegistry(BuiltInEmitterProviders.All)
            .TryCreate("kotlin", EmitterOptions.Empty, out var emitter).ShouldBeTrue();

        emitter.TargetName.ShouldBe("kotlin");
    }
}
