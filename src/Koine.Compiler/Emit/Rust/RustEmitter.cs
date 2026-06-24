using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The Rust backend (issue #24). Turns a validated <see cref="KoineModel"/> into an idiomatic,
/// self-contained Rust crate that preserves Koine's domain semantics: value objects as structs with
/// private fields and smart constructors returning <c>Result&lt;Self, DomainError&gt;</c>, smart enums
/// as Rust <c>enum</c>s matched exhaustively, entities/aggregates as structs whose mutating behaviors
/// re-check invariants, domain/integration events as a <c>Vec</c>-friendly enum, and repositories as
/// <c>trait</c>s.
/// <para>
/// Modeled on the C#/Python backends — split-by-concern partial classes — but laid out the Rust way:
/// one module per bounded context (<c>src/&lt;context&gt;.rs</c>), a shared dependency-light
/// <c>koine_runtime</c> module, and a <c>lib.rs</c> that wires them together. Every Rust-specific
/// decision lives in this folder; the <see cref="Ast"/> model stays target-agnostic.
/// </para>
/// </summary>
public sealed partial class RustEmitter : IEmitter
{
    private readonly RustEmitterOptions _options;

    /// <summary>Creates a <see cref="RustEmitter"/> with default options (<see cref="RustEmitterOptions.Empty"/>).</summary>
    public RustEmitter() : this(RustEmitterOptions.Empty) { }

    /// <summary>Creates a <see cref="RustEmitter"/> with the supplied options.</summary>
    internal RustEmitter(RustEmitterOptions options)
    {
        _options = options;
    }

    public string TargetName => "rust";

    /// <summary>
    /// Encodes the Rust option that changes emitted bytes (the sorted module remap pairs) so toggling
    /// it busts <see cref="Services.KoineCompiler"/>'s emit cache. Without this override the default
    /// (type-name-only) discriminator would let two emits of the same source under different
    /// <see cref="RustEmitterOptions.ModuleMap"/>s collide.
    /// </summary>
    public string CacheDiscriminator
    {
        get
        {
            var map = string.Join(
                ",",
                _options.ModuleMap
                    .OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .Select(kv => kv.Key + "=" + kv.Value));
            return string.Join("|", GetType().FullName, "modules=" + map);
        }
    }

    public IReadOnlyList<EmittedFile> Emit(KoineModel model) => Emit(model, null);

    public IReadOnlyList<EmittedFile> Emit(KoineModel model, SemanticModel? semantic)
    {
        ModelIndex index = (semantic ?? new SemanticModel(model)).Index;
        var emit = new RustEmitContext(
            index,
            BuildEnumMemberMap(model),
            // Demand-driven operator emission (R9), shared with the C#/Python emitters so the targets
            // stay semantically aligned: a value object only gets an additive `Add` where the model
            // `sum`s it, or a scalar `Mul` where the model multiplies it by a scalar.
            CSharp.OperatorNeedsAnalyzer.BuildAdditiveOperatorNeeds(model, index),
            CSharp.OperatorNeedsAnalyzer.BuildScalarOperatorNeeds(model, index));

        var files = new List<EmittedFile>
        {
            new("Cargo.toml", RustRuntime.CargoToml(ModelUsesGuidFactories(model)) + "\n"),
            new(RustRuntime.FileName, RustRuntime.Source + "\n"),
            new("src/lib.rs", EmitLibRs(model)),
        };

        foreach (ContextNode ctx in model.Contexts)
        {
            files.Add(EmitContextModule(emit, ctx));
        }

        return files;
    }

    /// <summary>Emits one bounded context as a single Rust module file (all its types, flat).</summary>
    private EmittedFile EmitContextModule(RustEmitContext emit, ContextNode ctx)
    {
        var body = new StringBuilder();
        WriteDomainError(body);

        foreach (TypeDecl type in ctx.Types)
        {
            EmitType(emit, body, type, ctx.Name);
        }

        // The context-wide DomainEvent enum (empty when the context declares no events).
        EmitDomainEventEnum(body, ctx);

        // Foreign *Id types referenced but not owned by a local entity: materialize a branded newtype
        // so the references resolve (e.g. billing's `ProductId`, used but with no `Product` entity).
        foreach (var idName in OrderedUnownedIds(ctx, emit.Index))
        {
            EmitUnownedIdType(body, idName);
        }

        var moduleDoc = $"//! The `{ctx.Name}` bounded context.";
        return new EmittedFile($"src/{ModuleNameFor(ctx.Name)}.rs", Assemble(body.ToString(), moduleDoc));
    }

    /// <summary>
    /// True when any entity in the model has a factory on a String-backed (Guid) identity — the case
    /// that calls <c>&lt;Id&gt;::generate()</c> and so pulls in the <c>uuid</c> crate. A factory-free
    /// model (or one whose factory ids are numeric) keeps the dependency-light manifest.
    /// </summary>
    private static bool ModelUsesGuidFactories(KoineModel model) =>
        model.Contexts
            .SelectMany(c => c.AllEntities())
            .Any(e => e.Factories.Count > 0 && IdBacking(e).IsString);

    /// <summary>Dispatches a single declaration to its construct emitter.</summary>
    private void EmitType(RustEmitContext emit, StringBuilder body, TypeDecl type, string context)
    {
        switch (type)
        {
            case EnumDecl @enum:
                body.Append('\n');
                EmitEnum(body, @enum);
                break;
            case ValueObjectDecl vo:
                body.Append('\n');
                EmitValueObject(body, emit, vo, context);
                break;
            case AggregateDecl agg:
                foreach (TypeDecl nested in agg.Types)
                {
                    EmitType(emit, body, nested, context);
                }
                EmitAggregateExtras(emit, body, agg, context);
                break;
            case EntityDecl entity:
                body.Append('\n');
                EmitEntity(body, emit, entity, context);
                break;
            case EventDecl ev:
                body.Append('\n');
                EmitEvent(body, emit, context, ev.Name, ev.Doc, ev.Members);
                break;
            case IntegrationEventDecl iev:
                body.Append('\n');
                EmitEvent(body, emit, context, iev.Name, iev.Doc, iev.Members);
                break;
            case ReadModelDecl rm:
                body.Append('\n');
                EmitReadModel(body, emit, rm, context);
                break;
            case QueryDecl q:
                body.Append('\n');
                EmitQuery(body, emit, q, context);
                break;
        }
    }
}
