using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>Provider for the living-documentation emitter (no per-emit options).</summary>
public sealed class DocsEmitterProvider : IEmitterProvider
{
    public string Target => "docs";

    /// <summary>Living docs is documentation, not a code-emit target the IDE offers (issue #282).</summary>
    public bool IsEmitTarget => false;

    public IEmitter Create(EmitterOptions options) => new DocsEmitter();
}
