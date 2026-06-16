using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit;

/// <summary>A single generated source file: a relative path and its contents.</summary>
public sealed record EmittedFile(string RelativePath, string Contents);

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

    /// <summary>Emits source files for the whole model.</summary>
    IReadOnlyList<EmittedFile> Emit(KoineModel model);

    /// <summary>
    /// Emits using a shared <see cref="SemanticModel"/> so resolution is reused rather than rebuilt.
    /// Defaults to <see cref="Emit(KoineModel)"/> for backends that build their own; the C# backend
    /// overrides it to consume the shared model.
    /// </summary>
    IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic) => Emit(model);
}
