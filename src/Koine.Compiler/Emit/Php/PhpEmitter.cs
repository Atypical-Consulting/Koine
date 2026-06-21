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

    /// <summary>
    /// Encodes the PHP option that changes emitted bytes (the sorted namespace remap pairs) so
    /// toggling it busts <see cref="Services.KoineCompiler"/>'s emit cache. Without this override the
    /// default (type-name-only) discriminator would let two emits of the same source under different
    /// <see cref="PhpEmitterOptions.NamespaceMap"/>s collide.
    /// </summary>
    public string CacheDiscriminator
    {
        get
        {
            var map = string.Join(
                ",",
                _options.NamespaceMap
                    .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .Select(kv => kv.Key + "=" + kv.Value));
            return string.Join("|", GetType().FullName, "ns=" + map);
        }
    }

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

        // Build the cross-namespace type catalog (short class name → FQN) so each emitted file can
        // import the sibling-namespace types it references via `use`. Includes the runtime types
        // referenced by short name and any unowned branded ids that need a self-contained class.
        _typeCatalog = BuildTypeCatalog(model, index);

        var files = new List<EmittedFile>();

        // 1. Runtime support files, emitted once at the output root.
        files.Add(new EmittedFile(PhpRuntime.FileName, PhpRuntime.Source));
        files.Add(new EmittedFile("composer.json", PhpRuntime.ComposerJson));
        files.Add(new EmittedFile("phpstan.neon", PhpRuntime.PhpStanNeon));

        // 2. Per-type dispatch.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                EmitType(emit, files, type, ctx.Name, typeMapper);
            }
        }

        // 3. Self-containment: emit a minimal branded id value object for any id type referenced by
        //    the model but not emitted from a declared entity (e.g. a foreign aggregate's id).
        EmitUnownedIds(emit, model, files);

        return files;
    }

    /// <summary>
    /// Dispatches a single <see cref="TypeDecl"/> to its construct emitter.
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
            case EventDecl ev:
                files.Add(EmitEvent(emit, ev.Name, ev.Doc, ev.Members, contextName, typeMapper));
                break;
            case IntegrationEventDecl iev:
                files.Add(EmitEvent(emit, iev.Name, iev.Doc, iev.Members, contextName, typeMapper));
                break;
            case AggregateDecl agg:
                // Recurse into aggregate-nested types (entities, events).
                foreach (TypeDecl nested in agg.Types)
                {
                    EmitType(emit, files, nested, contextName, typeMapper);
                }
                // Emit the repository interface for the aggregate root.
                var root = agg.Types.OfType<EntityDecl>().FirstOrDefault(e => e.Name == agg.RootName);
                var repo = EmitRepository(agg, root, contextName, typeMapper);
                if (repo is not null)
                {
                    files.Add(repo);
                }
                break;
        }
    }
}
