namespace Koine.Compiler.Ast;

/// <summary>
/// A source range over the originating <see cref="File"/> (when known), used to attach
/// diagnostics and editor navigation to AST nodes. Target-agnostic: carries no
/// language-specific information.
///
/// <para><see cref="Line"/>/<see cref="Column"/> are the 1-based START position (line and
/// column of the first character). <see cref="EndLine"/>/<see cref="EndColumn"/> are 1-based
/// and <b>end-EXCLUSIVE</b>: the line/column just past the last character of the range
/// (so a zero-length point span has <c>EndLine == Line</c> and <c>EndColumn == Column</c>).
/// LSP conversion is <c>start.character = Column - 1</c>, <c>end.character = EndColumn - 1</c>.</para>
///
/// <para><see cref="Offset"/> is the 0-based absolute character offset of the first character
/// and <see cref="Length"/> the character length, giving an integer-compare containment test
/// for position→node lookups.</para>
/// </summary>
public readonly record struct SourceSpan(
    int Line, int Column,
    int EndLine, int EndColumn,
    int Offset, int Length,
    string? File = null)
{
    /// <summary>Sentinel for nodes with no known position (all-zero; <c>== None</c> uses record-struct equality).</summary>
    public static readonly SourceSpan None = default;

    /// <summary>
    /// Source-compatibility constructor: a 1-based <paramref name="line"/>/<paramref name="column"/>
    /// point with no width (zero length, end == start). Keeps existing
    /// <c>new SourceSpan(line, col[, file])</c> call sites compiling; real ranges come from
    /// the parser's <c>SpanOf</c> helpers.
    /// </summary>
    public SourceSpan(int line, int column, string? file = null)
        : this(line, column, line, column, 0, 0, file)
    {
    }

    /// <summary>True when this is the all-zero <see cref="None"/> sentinel.</summary>
    public bool IsNone => this == None;
}
