using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit;

/// <summary>
/// Maps a contiguous run of generated lines back to its originating Koine source range.
/// Emit-side (it ties generated output to the model), but references only the
/// target-agnostic <see cref="SourceSpan"/> source location.
/// </summary>
/// <param name="GeneratedStartLine">1-based first generated line covered by this segment.</param>
/// <param name="GeneratedEndLine">1-based last generated line covered by this segment.</param>
/// <param name="SourceFile">The originating <c>.koi</c> file the segment maps back to.</param>
/// <param name="Source">The source range in the originating file.</param>
public sealed record SourceMapSegment(
    int GeneratedStartLine,
    int GeneratedEndLine,
    string SourceFile,
    SourceSpan Source);
