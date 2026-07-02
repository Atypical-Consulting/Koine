using Koine.Compiler.Emit.AsyncApi;

namespace Koine.Compiler.Emit;

/// <summary>Provider for the AsyncAPI 3.0 emitter (no per-emit options).</summary>
public sealed class AsyncApiEmitterProvider : IEmitterProvider
{
    public string Target => "asyncapi";

    public string DisplayName => "AsyncAPI";

    public string FileExtension => ".yaml";

    public IEmitter Create(EmitterOptions options) => new AsyncApiEmitter();
}
