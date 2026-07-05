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
        // events, commands, and repositories — is emitted one public type per file by the split
        // partials (JavaEmitter.ValueObjects.cs, .Enums.cs, .Entities.cs, .Aggregates.cs, .Events.cs),
        // dispatched from EmitType as each task lands.
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.Types)
            {
                EmitType(emit, files, ctx.Name, type);
            }
        }

        return files;
    }

    /// <summary>
    /// Dispatches one top-level declaration to its construct emitter, appending one <see cref="EmittedFile"/>
    /// per public Java type (the one-public-type-per-file rule). Mirrors the Rust backend's
    /// <c>EmitType</c> switch, but each case adds a whole file rather than appending to a shared module
    /// buffer. Task 4 wires the value-object case; later tasks add their own <c>case</c> (enums, entities +
    /// aggregate recursion + generated IDs, events, repositories). Unimplemented kinds fall through the
    /// <c>default</c> so the walk stays green as tasks land.
    /// </summary>
    private void EmitType(JavaEmitContext emit, List<EmittedFile> files, string context, TypeDecl type)
    {
        switch (type)
        {
            case ValueObjectDecl vo:
                files.Add(EmitValueObject(emit, context, vo));
                break;
            // Task 5: case EnumDecl
            // Task 6: case EntityDecl / case AggregateDecl (recurse into nested types) + generated IDs
            // Task 7: case EventDecl / case IntegrationEventDecl / case ReadModelDecl / case QueryDecl
            default:
                break;
        }
    }
}
