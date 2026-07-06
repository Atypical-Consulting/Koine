using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// The Java backend (issue #858) plugs in behind the existing <see cref="IEmitterProvider"/> /
/// <see cref="IEmitter"/> seam, exactly like the Rust backend (#24): registering
/// <c>JavaEmitterProvider</c> in <see cref="BuiltInEmitterProviders.All"/> is all it takes for the
/// unified <see cref="EmitterRegistry"/> — and thus the CLI, MCP, and Studio — to offer
/// <c>--target java</c>. This suite locks the skeleton: the target resolves, the emitter names itself
/// <c>java</c>, and even an empty model ships the shared <c>koine.runtime</c> support package.
/// </summary>
public class JavaEmitterTests
{
    [Fact]
    public void Registry_supports_the_java_target()
    {
        new EmitterRegistry(BuiltInEmitterProviders.All).IsSupported("java").ShouldBeTrue();
    }

    [Fact]
    public void Provider_creates_an_emitter_named_java()
    {
        new EmitterRegistry(BuiltInEmitterProviders.All)
            .TryCreate("java", EmitterOptions.Empty, out var emitter).ShouldBeTrue();

        emitter.TargetName.ShouldBe("java");
    }

    [Fact]
    public void Emit_of_an_empty_model_ships_the_runtime_DomainException()
    {
        var files = new JavaEmitter().Emit(new KoineModel(Array.Empty<ContextNode>(), ContextMap: null));

        files.ShouldContain(f => f.RelativePath == "koine/runtime/DomainException.java");
        files.Single(f => f.RelativePath == "koine/runtime/DomainException.java")
            .Contents.ShouldContain("class DomainException extends RuntimeException");
    }
}
