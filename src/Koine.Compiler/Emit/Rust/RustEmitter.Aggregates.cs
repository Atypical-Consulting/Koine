using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Rust;

/// <summary>
/// The aggregate/repository slice of <see cref="RustEmitter"/>. (Implemented in issue #24 Task 8.)
/// </summary>
public sealed partial class RustEmitter
{
    private void EmitAggregateExtras(RustEmitContext emit, StringBuilder body, AggregateDecl agg, string context)
    {
        // The repository trait (and any aggregate-level emission) is implemented in Task 8.
    }
}
