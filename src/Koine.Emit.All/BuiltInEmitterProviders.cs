using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The built-in <see cref="IEmitterProvider"/> set, in display order. This is the single source of
/// truth for which targets ship with the compiler; the CLI and MCP registries both seed an
/// <see cref="EmitterRegistry"/> from here so they can never drift (issue #69, Task 5). Each provider
/// now lives in its own <c>Koine.Emit.&lt;Target&gt;</c> assembly (issue #861); this aggregator is the
/// one place that references them all, so <see cref="EmitterRegistry"/> (in the core compiler) can take
/// the list as input rather than reaching down into the emitter assemblies (which would be a cycle).
/// </summary>
public static class BuiltInEmitterProviders
{
    /// <summary>The built-in providers, in the order targets are listed for help and errors.</summary>
    public static IReadOnlyList<IEmitterProvider> All { get; } = new IEmitterProvider[]
    {
        new CSharpEmitterProvider(),
        new TypeScriptEmitterProvider(),
        new PythonEmitterProvider(),
        new PhpEmitterProvider(),
        new RustEmitterProvider(),
        new JavaEmitterProvider(),
        new KotlinEmitterProvider(),
        new GlossaryEmitterProvider(),
        new DocsEmitterProvider(),
        new AsyncApiEmitterProvider(),
        new OpenApiEmitterProvider(),
    };
}
