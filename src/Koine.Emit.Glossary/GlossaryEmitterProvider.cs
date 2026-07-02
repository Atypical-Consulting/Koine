using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>Provider for the ubiquitous-language glossary emitter (no per-emit options).</summary>
public sealed class GlossaryEmitterProvider : IEmitterProvider
{
    public string Target => "glossary";

    /// <summary>The glossary is documentation, not a code-emit target the IDE offers (issue #282).</summary>
    public bool IsEmitTarget => false;

    public IEmitter Create(EmitterOptions options) => new GlossaryEmitter();
}
