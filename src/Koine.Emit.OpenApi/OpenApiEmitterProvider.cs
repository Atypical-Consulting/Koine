using Koine.Compiler.Emit.OpenApi;

namespace Koine.Compiler.Emit;

/// <summary>Provider for the OpenAPI 3.1 spec emitter (issue #126; no per-emit options).</summary>
public sealed class OpenApiEmitterProvider : IEmitterProvider
{
    public string Target => "openapi";

    public string DisplayName => "OpenAPI";

    public string FileExtension => ".yaml";

    public IEmitter Create(EmitterOptions options) => new OpenApiEmitter();
}
