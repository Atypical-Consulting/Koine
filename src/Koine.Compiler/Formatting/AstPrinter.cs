using System.Text;
using Koine.Compiler.Ast;

namespace Koine.Compiler.Formatting;

/// <summary>
/// Lossless AST → source printer (#5). Re-emits a node (or subtree) reproducing its
/// <see cref="KoineNode.LeadingTrivia"/>, its text, and its <see cref="KoineNode.TrailingTrivia"/>
/// so that <c>Print(Parse(src)) == src</c> for the printed node. This is the AST-level fidelity
/// capability that lets a refactor rebuild a subtree without losing whitespace, comments, or blank
/// lines.
///
/// <para><b>Tree-driven reconstruction (#B).</b> The printer composes a node's body <b>from the
/// tree</b>, mirroring <see cref="KoineNode.ToFullString"/>: a leaf node emits its verbatim
/// <see cref="KoineNode.LeafText"/>; a composite node recurses into its child nodes (via
/// <see cref="NodeWalker.ChildNodes"/>, reflection-driven and grammar-agnostic) in source order.
/// Because Koine has no <c>SyntaxToken</c> layer — structural keywords/punctuation (<c>value</c>,
/// <c>{</c>, <c>:</c>, operators) are not nodes — a composite node interspersed with such tokens
/// cannot be byte-reconstructed from the tree alone. For those, when the original source is in hand,
/// the printer falls back to slicing the node's <see cref="SourceSpan"/> (which includes the
/// structural tokens and any inner trivia), keeping the full-file round-trip byte-for-byte. A
/// printer built with <b>no source</b> (the synthesized/mutated-subtree case) reconstructs purely
/// from leaf text + trivia + child recursion.</para>
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
/// </summary>
public sealed class AstPrinter
{
    private readonly string? _source;

    /// <param name="source">The original source the model was parsed from; node spans index into it.</param>
    public AstPrinter(string source) => _source = source;

    /// <summary>
    /// Creates a printer with <b>no source</b>: nodes are reconstructed purely from the tree
    /// (leaf text + trivia + child recursion). Use for synthesized or mutated subtrees that were
    /// never parsed from a source string.
    /// </summary>
    public AstPrinter() => _source = null;

    /// <summary>
    /// Re-emits <paramref name="node"/> verbatim: its leading trivia, its text (from leaf text or by
    /// recursing children, with a source-slice fallback when the original source is available), then
    /// its trailing trivia. For a top-level node parsed from a whole file this reproduces the file
    /// byte-for-byte.
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

        if (node.LeafText is not null)
        {
            // Leaf node: its verbatim text is stored on the node — fully tree-driven.
            sb.Append(node.LeafText);
        }
        else if (TryAppendSourceSlice(sb, node.Span))
        {
            // Composite node with the original source in hand: slice the span verbatim. This
            // reproduces the structural keywords/punctuation that are not nodes, keeping the
            // full-file round-trip byte-for-byte.
        }
        else
        {
            // No usable source (synthesized/mutated subtree, or a span outside the source):
            // reconstruct from the tree by recursing children in source order (error markers
            // excluded, ordering centralized in NodeWalker — shared with KoineNode.ToFullString).
            foreach (KoineNode child in NodeWalker.ReconstructionChildren(node))
            {
                Append(sb, child);
            }
        }

        foreach (SyntaxTrivia t in node.TrailingTrivia)
        {
            sb.Append(t.Text);
        }
    }

    /// <summary>Appends the verbatim source slice for <paramref name="span"/>; false when no source covers it.</summary>
    private bool TryAppendSourceSlice(StringBuilder sb, SourceSpan span)
    {
        if (_source is null || span.IsNone || span.Length <= 0
            || span.Offset < 0 || span.Offset + span.Length > _source.Length)
        {
            return false;
        }

        sb.Append(_source, span.Offset, span.Length);
        return true;
    }
}
