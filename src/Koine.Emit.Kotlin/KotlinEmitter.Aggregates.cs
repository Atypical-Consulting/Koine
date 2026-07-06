using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The aggregate slice of <see cref="KotlinEmitter"/>. A Koine <c>aggregate</c> is a consistency boundary, not
/// a Kotlin type of its own: its nested types are emitted <b>flat</b> into the context package — each value
/// object, entity (with its generated identity), enum, and event getting its own <c>.kt</c> file via the same
/// <see cref="EmitType"/> dispatch as a top-level declaration. The aggregate root is simply the nested entity
/// named by <see cref="AggregateDecl.RootName"/>, so its class (invariant-guarded, with identity equality and
/// any recorded domain events) already falls out of the entity slice. Mirrors the Java/Rust backends' aggregate
/// handling (recurse the nested types, then the aggregate extras); the root's persistence-ignorant repository
/// <c>interface</c> is emitted by the messages/repository slice.
/// </summary>
public sealed partial class KotlinEmitter
{
    /// <summary>Emits an aggregate by recursing into each nested type (one <c>.kt</c> file each); the root entity is one of them.</summary>
    private void EmitAggregate(KotlinEmitContext emit, List<EmittedFile> files, string context, AggregateDecl agg)
    {
        foreach (TypeDecl nested in agg.Types)
        {
            EmitType(emit, files, context, nested);
        }
    }
}
