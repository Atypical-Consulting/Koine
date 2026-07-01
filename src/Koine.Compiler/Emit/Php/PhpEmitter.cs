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
            OperatorNeedsAnalyzer.BuildValueObjectOperatorNeeds(model, index));

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

            // Application services and pure domain operations: a `service` lives on
            // `ContextNode.Services` (not in `Types`), so iterate it separately.
            // Each emits a stateless domain-service class (operations) and/or an interface
            // (use cases), mirroring PythonEmitter.EmitServiceFiles.
            foreach (ServiceDecl svc in ctx.Services)
            {
                EmitServiceFiles(emit, files, svc, ctx.Name, typeMapper);
            }

            // Specifications (R10.1): a context's `spec` declarations (plus specs nested inside
            // aggregates) gather into a single <Context>Specifications final class of static
            // boolean predicate methods — mirrors C# and TypeScript spec emission.
            var contextSpecs = ctx.Specs
                .Concat(ctx.Types.OfType<AggregateDecl>().SelectMany(a => a.Specs))
                .ToList();
            if (contextSpecs.Count > 0)
            {
                files.Add(EmitSpecifications(emit, contextSpecs, ctx.Name, typeMapper));
            }

            // Policies (R10.3): an event→command reactor lives on `ContextNode.Policies` (not in
            // `Types`), so iterate it separately. Each emits a reactor `interface` seam the consumer
            // wires — the intended cross-aggregate call is documented, never generated.
            foreach (PolicyDecl policy in ctx.Policies)
            {
                files.Add(EmitPolicy(emit, policy, ctx.Name, typeMapper));
            }

            // Integration-event subscriber seams (R14.3): each `subscribes <Pub>.<Event>` emits a
            // `Handle<Event>` interface into THIS (subscriber) context's `Abstractions/` folder. The
            // published integration-event class itself already emits via the regular event path.
            foreach (SubscribeDecl sub in ctx.Subscribes)
            {
                files.Add(EmitIntegrationSubscriber(emit, sub, ctx.Name));
            }
        }

        // 3. Anti-corruption-layer translator seams (R14.2): one per ACL relation carrying a mapping
        //    block, emitted into the downstream context. Cross-context refs resolve to qualified
        //    `use` imports via the shared type catalog.
        if (model.ContextMap is { } map)
        {
            foreach (ContextRelation r in map.Relations)
            {
                if (r.Kind == ContextRelationKind.AntiCorruptionLayer && r.AclMappings.Count > 0)
                {
                    files.Add(EmitAclTranslator(emit, r));
                }
            }
        }

        // 4. Self-containment: emit a minimal branded id value object for any id type referenced by
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
            case ReadModelDecl rm:
                files.Add(EmitReadModel(emit, rm, contextName, typeMapper));
                break;
            case QueryDecl q:
                files.Add(EmitQuery(emit, q, contextName, typeMapper));
                break;
        }
    }

    // -------------------------------------------------------------------------
    // Constructor parameter ordering
    // -------------------------------------------------------------------------

    /// <summary>
    /// Orders constructor parameters so those carrying a PHP default value (constant-initializer
    /// defaults and optional <c>= null</c> fields) come last, as PHP requires — a required parameter
    /// after an optional/defaulted one is illegal (PHP silently drops the default and
    /// <c>phpstan --level max</c> reports <c>parameter.requiredAfterOptional</c>). Within each group
    /// declaration order is preserved (stable sort), mirroring the C# emitter's <c>OrderCtorParams</c>.
    /// <para>
    /// Every site that builds a PHP constructor signature — and every positional <c>new self(...)</c> /
    /// event-construction call that must line up with it — routes through this so signatures and call
    /// sites stay consistent.
    /// </para>
    /// </summary>
    private static IEnumerable<Member> OrderCtorParams(IEnumerable<Member> members) =>
        members.OrderBy(m => HasCtorDefault(m) ? 1 : 0);

    /// <summary>
    /// True when a stored member emits with a PHP constructor default: a constant-initializer member
    /// (<c>= &lt;default&gt;</c>) or an optional member (<c>= null</c>). The caller passes the already
    /// stored-field-filtered list, so derived members never reach here.
    /// </summary>
    private static bool HasCtorDefault(Member m) => m.Initializer is not null || m.Type.IsOptional;
}
