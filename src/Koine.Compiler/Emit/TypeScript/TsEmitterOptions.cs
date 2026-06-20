namespace Koine.Compiler.Emit.TypeScript;

/// <summary>
/// Per-emit configuration for the TypeScript backend (production-grade emit). Kept minimal and
/// shaped to grow: Task 6 will extend this record with module-map / reference-only / empty
/// surfaces. <see cref="EmitSourceMaps"/> defaults to <c>false</c> so the unconfigured emitter
/// (and every existing call site) produces byte-for-byte identical TypeScript — no sidecar
/// <c>*.ts.map</c> and no <c>sourceMappingURL</c> comment.
/// </summary>
internal sealed record TsEmitterOptions
{
    /// <summary>
    /// When <c>true</c>, each emitted module is paired with a Source Map v3 sidecar
    /// (<c>&lt;module&gt;.ts.map</c>) and gets a trailing <c>//# sourceMappingURL</c> comment. The
    /// default (<c>false</c>) leaves output identical to the historical emitter.
    /// </summary>
    public bool EmitSourceMaps { get; init; }

    /// <summary>The unconfigured options: no source maps, byte-identical output.</summary>
    public static readonly TsEmitterOptions Default = new();
}
