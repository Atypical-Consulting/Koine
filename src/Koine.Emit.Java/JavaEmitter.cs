using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The Java backend (issue #858). Turns a validated <see cref="KoineModel"/> into an idiomatic,
/// dependency-free Java 17 source tree that preserves Koine's domain semantics: value objects and
/// events as <c>record</c>s with validating compact constructors, smart enums as Java <c>enum</c>s,
/// entities/aggregates as classes with identity equality and invariant-guarded behaviors, repositories
/// as <c>interface</c>s, and a shared <c>koine.runtime</c> package carrying <see cref="JavaRuntime"/>'s
/// <c>DomainException</c>.
/// <para>
/// Modeled on the Rust/Python backends — split-by-concern partial classes — but laid out the Java way:
/// one package per bounded context (<c>&lt;base&gt;.&lt;context&gt;</c>) and, the one genuinely
/// Java-specific structural rule, <b>one public top-level type per <c>.java</c> file</b>. Every
/// Java-specific decision lives in this folder; the <see cref="Ast"/> model stays target-agnostic.
/// </para>
/// </summary>
public sealed partial class JavaEmitter : IEmitter
{
    private readonly JavaEmitterOptions _options;

    /// <summary>Creates a <see cref="JavaEmitter"/> with default options (<see cref="JavaEmitterOptions.Empty"/>).</summary>
    public JavaEmitter() : this(JavaEmitterOptions.Empty) { }

    /// <summary>Creates a <see cref="JavaEmitter"/> with the supplied options.</summary>
    internal JavaEmitter(JavaEmitterOptions options)
    {
        _options = options;
    }

    public string TargetName => "java";

    /// <summary>
    /// Encodes the Java options that change emitted bytes (the base package and the sorted package remap
    /// pairs) so toggling either busts <see cref="Services.KoineCompiler"/>'s emit cache. Without this
    /// override the default (type-name-only) discriminator would let two emits of the same source under
    /// different <see cref="JavaEmitterOptions"/> collide.
    /// </summary>
    public string CacheDiscriminator
    {
        get
        {
            var map = string.Join(
                ",",
                _options.PackageMap
                    .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .Select(kv => kv.Key + "=" + kv.Value));
            return string.Join("|", GetType().FullName, "base=" + _options.BasePackage, "packages=" + map);
        }
    }

    public IReadOnlyList<EmittedFile> Emit(KoineModel model) => Emit(model, null);

    public IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic)
    {
        ModelIndex index = (semantic ?? new SemanticModel(model)).Index;
        var emit = new JavaEmitContext(index);

        var files = new List<EmittedFile>
        {
            new(JavaRuntime.DomainExceptionFileName, JavaRuntime.DomainExceptionSource + "\n"),
        };

        // Phase 1 tactical core — value objects, generated IDs, smart enums, entities, aggregates,
        // events, and repositories — is emitted one public type per file by the split partials
        // (JavaEmitter.ValueObjects.cs, .Enums.cs, .Entities.cs, .Aggregates.cs, .Events.cs),
        // dispatched from EmitType. After a context's declarations, EmitContextExtras adds the pieces
        // that are context-wide rather than a single declaration: the DomainEvent sealed interface over
        // its events, and a branded record for every identity it references but does not locally own.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                EmitType(emit, files, ctx.Name, type);
            }

            EmitContextExtras(emit, files, ctx);
        }

        return files;
    }

    /// <summary>
    /// Dispatches one top-level declaration to its construct emitter, appending one <see cref="EmittedFile"/>
    /// per public Java type (the one-public-type-per-file rule). Mirrors the Rust backend's
    /// <c>EmitType</c> switch, but each case adds a whole file rather than appending to a shared module
    /// buffer. Value objects, enums, entities (with aggregate recursion + generated IDs), aggregates,
    /// and events/integration events are wired; the Phase-2 application/CQRS kinds (read models, queries)
    /// fall through the <c>default</c>. A repository lives on its aggregate, so it is emitted by
    /// <c>EmitAggregate</c>, not dispatched here.
    /// </summary>
    private void EmitType(JavaEmitContext emit, List<EmittedFile> files, string context, TypeDecl type)
    {
        switch (type)
        {
            case ValueObjectDecl vo:
                files.Add(EmitValueObject(emit, context, vo));
                break;
            case EnumDecl e:
                files.Add(EmitEnum(emit, context, e));
                break;
            case EntityDecl entity:
                EmitEntity(emit, files, context, entity);
                break;
            case AggregateDecl agg:
                EmitAggregate(emit, files, context, agg);
                break;
            case EventDecl ev:
                files.Add(EmitEvent(emit, context, ev.Name, ev.Doc, ev.Members));
                break;
            case IntegrationEventDecl iev:
                files.Add(EmitEvent(emit, context, iev.Name, iev.Doc, iev.Members));
                break;
            // ReadModelDecl / QueryDecl are the Phase-2 application/CQRS layer — deliberately skipped here.
            default:
                break;
        }
    }
}
