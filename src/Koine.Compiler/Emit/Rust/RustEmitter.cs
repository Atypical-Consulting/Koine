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
        _ = semantic ?? new SemanticModel(model);
        // Walking skeleton (Task 1): the construct emitters land in later tasks. Returns an empty
        // file set so a `--target rust` build runs end-to-end without throwing.
        return Array.Empty<EmittedFile>();
    }
}
