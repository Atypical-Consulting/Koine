using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// The aggregate slice of <see cref="JavaEmitter"/>. A Koine <c>aggregate</c> is a consistency boundary,
/// not a Java type of its own: its nested types are emitted <b>flat</b> into the context package — each
/// value object, entity (with its generated identity), enum, and event getting its own <c>.java</c> file
/// via the same <see cref="EmitType"/> dispatch as a top-level declaration. The aggregate root is simply
/// the nested entity named by <see cref="AggregateDecl.RootName"/>, so its class (invariant-guarded, with
/// identity equality and any recorded domain events) already falls out of the entity slice. Mirrors the
/// Rust backend's aggregate handling (recurse <c>agg.Types</c>, then the aggregate extras); the root's
/// persistence-ignorant repository <c>interface</c> is the follow-on events/repositories task.
/// </summary>
public sealed partial class JavaEmitter
{
    /// <summary>Emits an aggregate by recursing into each nested type (one <c>.java</c> file each); the root entity is one of them.</summary>
    private void EmitAggregate(JavaEmitContext emit, List<EmittedFile> files, string context, AggregateDecl agg)
    {
        foreach (TypeDecl nested in agg.Types)
        {
            EmitType(emit, files, context, nested);
        }

        // The aggregate root's persistence-ignorant repository interface (the Rust backend's
        // EmitAggregateExtras analogue). The per-context DomainEvent sealed interface is emitted once per
        // context by EmitContextExtras, not here, so a same-named event nested in the aggregate still lands
        // in the single context-wide sum.
        EmitAggregateExtras(emit, files, context, agg);
    }
}
