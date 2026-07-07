using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit;

/// <summary>
/// A single generated source file: a relative path and its contents, plus an
/// optional <paramref name="SourceMap"/> tying runs of generated lines back to
/// the originating Koine source. The map is <c>null</c> by default so back-ends
/// that do not emit one (and all existing call sites) keep working unchanged.
/// <paramref name="Kind"/> is an optional DDD-stereotype slug (e.g. <c>"aggregate"</c>,
/// <c>"value"</c>, <c>"event"</c>) used by UIs to tint generated files by building
/// block; <c>null</c> for files with no stereotype (or emitters that don't set one).
/// </summary>
public sealed record EmittedFile(
    string RelativePath,
    string Contents,
    IReadOnlyList<SourceMapSegment>? SourceMap = null,
    string? Kind = null);

/// <summary>
/// Target-agnostic emitter seam. A backend turns a validated
/// <see cref="KoineModel"/> into a set of source files. The C# emitter is the
/// only implementation for v0; a second target plugs in here without touching
/// the parser or semantic model.
/// </summary>
public interface IEmitter
{
    /// <summary>The target identifier, e.g. <c>"csharp"</c>.</summary>
    string TargetName { get; }

    /// <summary>
    /// A stable fingerprint of everything about THIS emitter that affects emitted bytes — its type
    /// plus every option that changes output (source maps, reference-only, namespace/module remaps,
    /// instant mode, …). It feeds <see cref="Services.KoineCompiler"/>'s content-addressed emit cache:
    /// two emitters that would produce different bytes for the same model MUST yield different
    /// discriminators, so toggling any output-affecting option busts the cache. The default is the
    /// concrete type name (correct for emitters with no output-affecting options); the C# and
    /// TypeScript backends override it to encode their options. Must be deterministic across runs
    /// (no <c>GetHashCode</c>/random/timestamps).
    /// </summary>
    string CacheDiscriminator => GetType().FullName!;

    /// <summary>Emits source files for the whole model.</summary>
    IReadOnlyList<EmittedFile> Emit(KoineModel model);

    /// <summary>
    /// Emits using a shared <see cref="SemanticModel"/> so resolution is reused rather than rebuilt.
    /// Defaults to <see cref="Emit(KoineModel)"/> for backends that build their own; the C# backend
    /// overrides it to consume the shared model.
    /// </summary>
    IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic) => Emit(model);
}
