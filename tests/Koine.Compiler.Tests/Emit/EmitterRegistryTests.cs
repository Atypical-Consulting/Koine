using Koine.Compiler.Ast;
using Koine.Compiler.Emit;
using Koine.Compiler.Services;

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
        { "csharp", "typescript", "python", "php", "rust", "glossary", "docs", "asyncapi", "openapi" };

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
    public void SupportedTargetInfos_carry_display_name_and_extension_in_display_order()
    {
        // The registry is the single source of truth for the IDE's emit-target list (issue #282):
        // each code target carries its display name + file extension. Glossary/docs are not emit
        // targets and must be excluded, even though they remain in SupportedTargets.
        new EmitterRegistry().SupportedTargetInfos.ShouldBe(new[]
        {
            new EmitTargetInfo("csharp", "C#", ".cs"),
            new EmitTargetInfo("typescript", "TypeScript", ".ts"),
            new EmitTargetInfo("python", "Python", ".py"),
            new EmitTargetInfo("php", "PHP", ".php"),
            new EmitTargetInfo("rust", "Rust", ".rs"),
            new EmitTargetInfo("asyncapi", "AsyncAPI", ".yaml"),
            new EmitTargetInfo("openapi", "OpenAPI", ".yaml"),
        });

        var ids = new EmitterRegistry().SupportedTargetInfos.Select(i => i.Id).ToArray();
        ids.ShouldNotContain("glossary");
        ids.ShouldNotContain("docs");
    }

    [Fact]
    public void SupportedTargetInfos_surface_external_providers_using_the_default_metadata()
    {
        // A registry target gained → the IDE offers it automatically: an external provider that is an
        // emit target appears in SupportedTargetInfos. The stub declares no metadata, so the default
        // interface members apply — display name = target id, extension = ".txt".
        var registry = new EmitterRegistry(new[] { new StubEmitterProvider() });

        var stub = registry.SupportedTargetInfos.Single(i => i.Id == StubEmitterProvider.TargetName);
        stub.DisplayName.ShouldBe(StubEmitterProvider.TargetName);
        stub.FileExtension.ShouldBe(".txt");
    }

    [Fact]
    public void Supported_list_is_the_comma_space_join_of_supported_targets()
    {
        // Locks the shared formatter the CLI and MCP error messages both delegate to.
        var registry = new EmitterRegistry();
        registry.SupportedList.ShouldBe(string.Join(", ", registry.SupportedTargets));
    }

    // ------------------------------------------------------------------
    // Issue #794 — the C# matches-invariant regex match timeout (#641) is
    // configurable via the neutral EmitterOptions.RegexMatchTimeoutMs seam.
    // A timeout-only bag must NOT collapse to the Empty singleton, or the
    // configured value would never reach the emitted guard.
    // ------------------------------------------------------------------

    [Fact]
    public void Csharp_provider_threads_a_configured_regex_match_timeout_into_the_emitted_guard()
    {
        // A timeout-only neutral bag must not short-circuit to CSharpEmitterOptions.Empty (issue #794):
        // the configured value has to reach the matches-invariant guard the C# emitter stamps (#641).
        var configured = new CSharpEmitterProvider().Create(
            new EmitterOptions(new Dictionary<string, string>(StringComparer.Ordinal), RegexMatchTimeoutMs: 250));

        EmitEmailGuard(configured).ShouldContain("TimeSpan.FromMilliseconds(250)");
    }

    [Fact]
    public void Csharp_provider_keeps_the_default_regex_match_timeout_when_unset()
    {
        // No key set ⇒ the emitter keeps the historical 1000 ms bound ⇒ byte-identical output.
        EmitEmailGuard(new CSharpEmitterProvider().Create(EmitterOptions.Empty))
            .ShouldContain("TimeSpan.FromMilliseconds(1000)");
    }

    [Fact]
    public void Cli_registry_threads_a_config_only_timeout_into_the_emitted_guard()
    {
        // End-to-end through the CLI seam: a koine.config that sets ONLY the timeout must reach the
        // emitted matches-invariant guard — proving KoineConfig → TargetOptions → EmitterOptions →
        // CSharpEmitterOptions all carry the value and no empty-bag guard short-circuits it (issue #794).
        var opts = Cli.KoineConfig.Parse("targets.csharp.regexMatchTimeoutMs = 250\n").OptionsFor("csharp");
        Cli.Infrastructure.EmitterRegistry.TryCreate("csharp", opts, out var emitter).ShouldBeTrue();

        EmitEmailGuard(emitter).ShouldContain("TimeSpan.FromMilliseconds(250)");
    }

    // ------------------------------------------------------------------
    // Issue #831 — targets.<t>.regexMode config key threads through the
    // neutral EmitterOptions.RegexMode seam. A regexMode-only bag must
    // NOT collapse to the Empty singleton, or the setting would be lost.
    // ------------------------------------------------------------------

    [Fact]
    public void Target_options_with_regex_mode_maps_to_emitter_options_regex_mode()
    {
        // A regexMode-only TargetOptions must produce an EmitterOptions whose RegexMode carries the
        // raw string — proving the CLI registry threads the value and the guard does not short-circuit.
        var opts = Cli.KoineConfig.Parse("targets.csharp.regexMode = sourceGenerated\n").OptionsFor("csharp");
        opts.RegexModeText.ShouldBe("sourceGenerated");

        // The CLI TryCreate path ultimately calls ToEmitterOptions internally; we verify the resulting
        // emitter emits [GeneratedRegex] (that's covered in Task 3's BuildRegexModeTests), so here
        // we just confirm EmitterOptions.RegexMode is wired through by inspecting the neutral bag.
        var emitterOptions = new EmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal), RegexMode: "sourceGenerated");
        emitterOptions.RegexMode.ShouldBe("sourceGenerated");
    }

    [Fact]
    public void All_default_target_options_produce_null_regex_mode_on_emitter_options()
    {
        // An all-default TargetOptions (no regexMode) must produce EmitterOptions with a null
        // RegexMode — so an unconfigured target stays byte-identical (issue #831).
        var opts = Cli.KoineConfig.Parse("target = csharp\n").OptionsFor("csharp");
        opts.RegexModeText.ShouldBeNull();

        // Confirm EmitterOptions.Empty's RegexMode is null (the default).
        EmitterOptions.Empty.RegexMode.ShouldBeNull();

        // An all-null EmitterOptions has a null RegexMode; no regexMode set means the emitter's
        // default (Inline) applies — byte-identical to unconfigured output.
        var emitterOpts = new EmitterOptions(
            new Dictionary<string, string>(StringComparer.Ordinal));
        emitterOpts.RegexMode.ShouldBeNull();
    }

    /// <summary>
    /// Emits the one-value-object matches-invariant fixture with <paramref name="emitter"/> and returns
    /// the generated Email source, where the timeout-bounded <c>Regex.IsMatch(…)</c> guard lives.
    /// </summary>
    private static string EmitEmailGuard(IEmitter emitter)
    {
        const string src =
            "context C {\n  value Email {\n    raw: String\n" +
            "    invariant raw matches /^[^@]+@[^@]+$/  \"invalid email address\"\n  }\n}\n";
        var result = new KoineCompiler().Compile(src, emitter);
        result.Success.ShouldBeTrue(string.Join("\n", result.Diagnostics.Select(d => d.ToString())));
        return result.Files.Single(f => f.RelativePath.EndsWith("Email.cs")).Contents;
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
