using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The events/CQRS slice of <see cref="RustEmitter"/>. (Implemented in issue #24 Task 7.)
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitEvent(StringBuilder body, RustEmitContext emit, string name, string? doc, IReadOnlyList<Member> members, string context)
    {
        // Implemented in Task 7.
    }
}
