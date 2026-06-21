using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The entity/event slice of <see cref="RustEmitter"/>. (Implemented in issue #24 Tasks 6–8.)
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitEntity(StringBuilder body, RustEmitContext emit, EntityDecl entity, string context, bool isAggregateRoot, bool versioned)
    {
        // Implemented in Task 6.
    }

    private void EmitEvent(StringBuilder body, RustEmitContext emit, string name, string? doc, IReadOnlyList<Member> members, string context)
    {
        // Implemented in Task 7.
    }
}
