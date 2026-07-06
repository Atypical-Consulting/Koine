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
        // Skeleton (issue #1066, Task 1): the shared koine.runtime package (Task 3) and the per-construct
        // partials — value objects, enums, entities, aggregates, events/commands, repositories (Tasks 5-8)
        // — append to this list as they land. The provider/registry wiring is complete now, so the target
        // resolves end-to-end from an empty file set.
        return new List<EmittedFile>();
    }
}
