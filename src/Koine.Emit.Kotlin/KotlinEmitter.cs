using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The Kotlin backend (issue #1066). Turns a validated <see cref="KoineModel"/> into an idiomatic,
/// dependency-free Kotlin 2.x/JVM source tree that preserves Koine's domain semantics: value objects as
/// <c>data class</c>es with <c>init</c>-block invariants, generated IDs as <c>@JvmInline value class</c>es,
/// smart enums as Kotlin <c>enum class</c>es, entities/aggregates as classes with identity equality and
/// invariant-guarded behaviors, events/commands as <c>data class</c>es under a per-context
/// <c>sealed interface DomainEvent</c>, repositories as <c>interface</c>s, and a shared
/// <c>koine.runtime</c> package carrying <see cref="KotlinRuntime"/>'s <c>DomainException</c>.
/// <para>
/// Modeled on the Rust/Java backends — split-by-concern partial classes — and laid out the JVM way like
/// its sibling <see cref="JavaEmitter"/>: one package per bounded context
/// (<c>&lt;base&gt;.&lt;context&gt;</c>) and one top-level type per <c>.kt</c> file (not a language rule
/// as in Java, but it keeps snapshots granular and diffs reviewable; a <c>sealed</c> hierarchy stays
/// within one package as Kotlin requires). Every Kotlin-specific decision lives in this folder; the
/// <see cref="Ast"/> model stays target-agnostic.
/// </para>
/// </summary>
public sealed partial class KotlinEmitter : IEmitter
{
    private readonly KotlinEmitterOptions _options;

    /// <summary>Creates a <see cref="KotlinEmitter"/> with default options (<see cref="KotlinEmitterOptions.Empty"/>).</summary>
    public KotlinEmitter() : this(KotlinEmitterOptions.Empty) { }

    /// <summary>Creates a <see cref="KotlinEmitter"/> with the supplied options.</summary>
    internal KotlinEmitter(KotlinEmitterOptions options)
    {
        _options = options;
    }

    public string TargetName => "kotlin";

    /// <summary>
    /// Encodes the Kotlin options that change emitted bytes (the base package and the sorted package remap
    /// pairs) so toggling either busts <see cref="Services.KoineCompiler"/>'s emit cache. Without this
    /// override the default (type-name-only) discriminator would let two emits of the same source under
    /// different <see cref="KotlinEmitterOptions"/> collide.
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
        var emit = new KotlinEmitContext(
            index,
            // Demand-driven operator emission (R9), shared with the C#/Java/Rust/Python/TS emitters so the
            // targets stay semantically aligned: a value object only gets a `plus`/`minus` where the model
            // sums or adds/subtracts it, or a `times`/`div` where it is scaled by a scalar.
            OperatorNeedsAnalyzer.BuildAdditiveOperatorNeeds(model, index),
            OperatorNeedsAnalyzer.BuildScalarOperatorNeeds(model, index),
            OperatorNeedsAnalyzer.BuildScalarDivisionNeeds(model, index),
            OperatorNeedsAnalyzer.BuildValueObjectArithmeticNeeds(model, index),
            BuildEnumMemberMap(model));

        var files = new List<EmittedFile>
        {
            // The shared koine.runtime package (DomainException + the Range<T> interval type), always
            // emitted like the JVM sibling's DomainException/Range so a `Range<T>`-typed member and every
            // invariant guard always resolve.
            new(KotlinRuntime.FileName, KotlinRuntime.Source + "\n"),
        };

        // Phase 1 tactical core — value objects, generated IDs, smart enums, entities, aggregates, events,
        // and repositories — is emitted one top-level type per file by the split partials, dispatched from
        // EmitType. The construct cases are wired incrementally per task (VOs + generated IDs first).
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
    /// per top-level Kotlin type. Mirrors the Java backend's <c>EmitType</c> switch; cases are wired
    /// incrementally as the split partials land. An aggregate recurses into its nested types; each entity
    /// contributes its generated identity <c>value class</c> (the entity class body itself is the entity
    /// task). The Phase-2 application/CQRS kinds (read models, queries) fall through the <c>default</c>.
    /// </summary>
    private void EmitType(KotlinEmitContext emit, List<EmittedFile> files, string context, TypeDecl type)
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
                files.Add(EmitEvent(emit, context, ev.Name, ev.Members));
                break;
            case IntegrationEventDecl iev:
                files.Add(EmitEvent(emit, context, iev.Name, iev.Members));
                break;
            default:
                break;
        }
    }
}
