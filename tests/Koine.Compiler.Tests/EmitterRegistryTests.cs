using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler.Tests;

/// <summary>
/// The emitter lookup is unified behind <see cref="Koine.Compiler.Emit.IEmitterProvider"/> +
/// <see cref="Koine.Compiler.Emit.EmitterRegistry"/> (issue #69, Task 5). The CLI's
/// <see cref="Koine.Cli.Infrastructure.EmitterRegistry"/> and the MCP's
/// <see cref="Koine.Mcp.EmitterFactory"/> both delegate to it, so the two surfaces can never
/// drift in which targets they support — the bug this task removes (the MCP list was missing
/// <c>php</c>). External providers named in config flow through both entry points.
/// </summary>
public class EmitterRegistryTests
{
    private static readonly string[] UnifiedTargets =
        { "csharp", "typescript", "python", "php", "rust", "glossary", "docs" };

    [Fact]
    public void Unified_registry_exposes_the_full_target_list_in_display_order()
    {
        new EmitterRegistry().SupportedTargets.ShouldBe(UnifiedTargets);
    }

    [Fact]
    public void Cli_and_mcp_both_expose_the_same_unified_target_list()
    {
        // No drift: both registries equal the unified list (and so equal each other). The MCP
        // list, in particular, now includes `php` — the historical gap this task closes.
        Cli.Infrastructure.EmitterRegistry.SupportedTargets.ShouldBe(UnifiedTargets);
        Mcp.EmitterFactory.Targets.ShouldBe(UnifiedTargets);

        Mcp.EmitterFactory.Targets.ShouldContain("php");
    }

    [Fact]
    public void Empty_options_create_emitters_byte_identical_to_the_parameterless_path()
    {
        var registry = new EmitterRegistry();
        foreach (var target in UnifiedTargets)
        {
            registry.IsSupported(target).ShouldBeTrue();
            registry.TryCreate(target, EmitterOptions.Empty, out var emitter).ShouldBeTrue();
            emitter.ShouldNotBeNull();
        }
    }

    [Fact]
    public void External_provider_resolves_through_the_compiler_registry()
    {
        var registry = new EmitterRegistry(new[] { new StubEmitterProvider() });

        registry.SupportedTargets.ShouldBe(UnifiedTargets.Append(StubEmitterProvider.TargetName));
        registry.IsSupported(StubEmitterProvider.TargetName).ShouldBeTrue();
        registry.TryCreate(StubEmitterProvider.TargetName, EmitterOptions.Empty, out var emitter).ShouldBeTrue();

        emitter.Emit(EmptyModel()).Single().ShouldBe(StubEmitter.File);
    }

    [Fact]
    public void External_provider_is_discovered_from_an_assembly_by_the_loader()
    {
        // Point the loader at this already-loaded test assembly; it must find the public stub.
        var providers = EmitterLoader.Load(new[] { typeof(StubEmitterProvider).Assembly.GetName().Name! });
        providers.ShouldContain(p => p.Target == StubEmitterProvider.TargetName);
    }

    [Fact]
    public void External_provider_resolves_through_the_cli_path()
    {
        Cli.Infrastructure.EmitterRegistry.TryCreate(
            StubEmitterProvider.TargetName,
            Cli.TargetOptions.Empty,
            new[] { typeof(StubEmitterProvider).Assembly.GetName().Name! },
            out var emitter).ShouldBeTrue();

        emitter.Emit(EmptyModel()).Single().ShouldBe(StubEmitter.File);
    }

    [Fact]
    public void Supported_list_is_the_comma_space_join_of_supported_targets()
    {
        // Locks the shared formatter the CLI and MCP error messages both delegate to.
        var registry = new EmitterRegistry();
        registry.SupportedList.ShouldBe(string.Join(", ", registry.SupportedTargets));
    }

    private static KoineModel EmptyModel() => new(Array.Empty<ContextNode>(), ContextMap: null);

    /// <summary>An out-of-tree provider that any registered registry must surface and create.</summary>
    public sealed class StubEmitterProvider : IEmitterProvider
    {
        public const string TargetName = "stub";

        public string Target => TargetName;

        public IEmitter Create(EmitterOptions options) => new StubEmitter();
    }

    /// <summary>The emitter the stub provider builds: emits one known file.</summary>
    public sealed class StubEmitter : IEmitter
    {
        public static readonly EmittedFile File = new("stub/output.txt", "stub-emitter-output");

        public string TargetName => StubEmitterProvider.TargetName;

        public IReadOnlyList<EmittedFile> Emit(KoineModel model) => new[] { File };
    }
}
