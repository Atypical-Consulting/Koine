namespace Koine.Compiler.Ast;

/// <summary>
/// A 1-based source position (line, column) plus the originating source
/// <see cref="File"/> (when known), used to attach diagnostics to AST nodes.
/// Target-agnostic: carries no language-specific information.
/// </summary>
public readonly record struct SourceSpan(int Line, int Column, string? File = null)
{
    /// <summary>Sentinel for nodes with no known position.</summary>
    public static readonly SourceSpan None = new(0, 0);
}
