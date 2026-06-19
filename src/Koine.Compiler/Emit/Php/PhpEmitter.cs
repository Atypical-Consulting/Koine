using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Php;

/// <summary>
/// The PHP backend. Turns a validated <see cref="KoineModel"/> into PHP 8.1+ code that
/// preserves Koine's domain semantics. Modeled on the Python backend: one file per type,
/// DDD subfolders (<c>ValueObjects/</c>, <c>Entities/</c>, <c>Enums/</c>, <c>Events/</c>,
/// <c>Repositories/</c>), and a fixed-string runtime emitted once at the output root.
/// <para>
/// For Task 1 only the root support files are emitted (<c>KoineRuntime.php</c>,
/// <c>composer.json</c>, <c>phpstan.neon</c>). Per-type dispatch will be added in later tasks.
/// All PHP-specific decisions live in this folder; the AST stays agnostic.
/// </para>
/// </summary>
public sealed partial class PhpEmitter : IEmitter
{
    /// <inheritdoc/>
    public string TargetName => "php";

    /// <summary>Emits source files for the whole model.</summary>
    public IReadOnlyList<EmittedFile> Emit(KoineModel model) => Emit(model, null);

    /// <summary>
    /// Emits using a shared <see cref="SemanticModel"/> so resolution is reused rather than
    /// rebuilt. Builds the <see cref="ModelIndex"/> and returns the root support files plus any
    /// per-type files.
    /// </summary>
    public IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic)
    {
        ModelIndex index = (semantic ?? new SemanticModel(model)).Index;

        var files = new List<EmittedFile>();

        // 1. Runtime support files, emitted once at the output root.
        files.Add(new EmittedFile(PhpRuntime.FileName, PhpRuntime.Source));
        files.Add(new EmittedFile("composer.json", PhpRuntime.ComposerJson));
        files.Add(new EmittedFile("phpstan.neon", PhpRuntime.PhpStanNeon));

        // 2. Per-type dispatch (no-op in Task 1; populated in later tasks).
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                EmitType(files, type, ctx.Name, index);
            }
        }

        return files;
    }

    /// <summary>
    /// Dispatches a single <see cref="TypeDecl"/> to its construct emitter.
    /// In Task 1 this is a no-op; subsequent tasks will add emit logic for each construct.
    /// </summary>
    private static void EmitType(
        List<EmittedFile> files, TypeDecl type, string contextName, ModelIndex index)
    {
        // no-op for Task 1 — per-type emit arrives in later tasks
        _ = files;
        _ = type;
        _ = contextName;
        _ = index;
    }
}
