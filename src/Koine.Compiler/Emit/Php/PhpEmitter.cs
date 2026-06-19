using Koine.Compiler.Ast;
using Koine.Compiler.Emit.CSharp;

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
    private readonly PhpEmitterOptions _options;

    /// <summary>Creates a <see cref="PhpEmitter"/> with default options
    /// (<see cref="PhpEmitterOptions.Empty"/>).</summary>
    public PhpEmitter() : this(PhpEmitterOptions.Empty) { }

    /// <summary>Creates a <see cref="PhpEmitter"/> with the supplied options.</summary>
    internal PhpEmitter(PhpEmitterOptions options)
    {
        _options = options;
    }

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
        var typeMapper = new PhpTypeMapper(index);

        var emit = new PhpEmitContext(
            index,
            BuildEnumMemberMap(model),
            OperatorNeedsAnalyzer.BuildAdditiveOperatorNeeds(model, index),
            OperatorNeedsAnalyzer.BuildScalarOperatorNeeds(model, index));

        var files = new List<EmittedFile>();

        // 1. Runtime support files, emitted once at the output root.
        files.Add(new EmittedFile(PhpRuntime.FileName, PhpRuntime.Source));
        files.Add(new EmittedFile("composer.json", PhpRuntime.ComposerJson));
        files.Add(new EmittedFile("phpstan.neon", PhpRuntime.PhpStanNeon));

        // 2. Per-type dispatch: value objects and quantities in Task 5; other constructs are no-ops.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                EmitType(emit, files, type, ctx.Name, typeMapper);
            }
        }

        return files;
    }

    /// <summary>
    /// Dispatches a single <see cref="TypeDecl"/> to its construct emitter.
    /// Value objects and quantities emit in Task 5; other construct kinds are no-ops until
    /// their respective tasks land.
    /// </summary>
    private void EmitType(
        PhpEmitContext emit, List<EmittedFile> files, TypeDecl type, string contextName, PhpTypeMapper typeMapper)
    {
        switch (type)
        {
            case ValueObjectDecl vo:
                files.Add(EmitValueObject(emit, vo, contextName, typeMapper));
                break;
            case EnumDecl enumDecl:
                files.Add(EmitEnum(emit, enumDecl, contextName, typeMapper));
                break;
            case EntityDecl entity:
                EmitEntity(emit, files, entity, contextName, typeMapper);
                break;
            case AggregateDecl agg:
                // Recurse into aggregate-nested types (entities, events).
                foreach (TypeDecl nested in agg.Types)
                {
                    EmitType(emit, files, nested, contextName, typeMapper);
                }
                break;
            // EventDecl, IntegrationEventDecl → no-op until later tasks.
        }
    }
}
