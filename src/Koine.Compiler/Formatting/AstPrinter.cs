using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Formatting;

/// <summary>
/// Lossless AST → source printer (#5). Re-emits a node (or subtree) reproducing its
/// <see cref="KoineNode.LeadingTrivia"/>, its verbatim source text, and its
/// <see cref="KoineNode.TrailingTrivia"/> so that <c>Print(Parse(src)) == src</c> for the
/// printed node. This is the AST-level fidelity capability that lets a future refactor rebuild
/// a subtree without losing whitespace, comments, or blank lines.
///
/// <para><b>Roles of the three source-emission paths — keep them distinct:</b></para>
/// <list type="bullet">
///   <item><description><see cref="AstPrinter"/> (this type) — AST-driven, <b>verbatim</b>: faithful
///   reproduction of the original layout from the model, for round-trip / AST refactors.</description></item>
///   <item><description><see cref="KoineFormatter"/> — token-stream, <b>canonical</b>: normalizes
///   layout (idempotent <c>Format(Format(x)) == Format(x)</c>). The file-level pretty-printer; it
///   is NOT AST-driven and is the right tool for "format my file".</description></item>
///   <item><description>Rename — text-level edits over the original source; layout-preserving by
///   construction. Untouched by trivia.</description></item>
/// </list>
/// The printer relies on every node carrying a real <see cref="SourceSpan"/> range (#4): the
/// verbatim body is the source slice <c>[Offset .. Offset + Length)</c>, so inner trivia
/// (comments, blank-line runs, irregular indentation between a node's own tokens) is preserved
/// exactly without having to attach trivia to every token.
/// </summary>
public sealed class AstPrinter
{
    private readonly string _source;

    /// <param name="source">The original source the model was parsed from; node spans index into it.</param>
    public AstPrinter(string source) => _source = source;

    /// <summary>
    /// Re-emits <paramref name="node"/> verbatim: its leading trivia, its source text (the slice its
    /// <see cref="SourceSpan"/> covers), then its trailing trivia. For a top-level node parsed from a
    /// whole file this reproduces the file byte-for-byte.
    /// </summary>
    public string Print(KoineNode node)
    {
        var sb = new StringBuilder();
        Append(sb, node);
        return sb.ToString();
    }

    private void Append(StringBuilder sb, KoineNode node)
    {
        foreach (SyntaxTrivia t in node.LeadingTrivia)
        {
            sb.Append(t.Text);
        }

        SourceSpan span = node.Span;
        if (!span.IsNone && span.Length > 0 && span.Offset >= 0 && span.Offset + span.Length <= _source.Length)
        {
            sb.Append(_source, span.Offset, span.Length);
        }

        foreach (SyntaxTrivia t in node.TrailingTrivia)
        {
            sb.Append(t.Text);
        }
    }
}
