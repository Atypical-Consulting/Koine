using Koine.Compiler.Ast;

namespace Koine.Compiler.Services;

/// <summary>
/// A serializable projection of one <see cref="KoineNode"/> in the parsed syntax tree, for
/// editor/tooling consumers (e.g. Studio's syntax-tree panel). Target-agnostic: it carries only
/// the node's structural facts plus the pure position data (<see cref="SourceSpan"/>) — no
/// C#/target concept.
/// </summary>
/// <param name="Kind">The node's runtime type name (<c>node.GetType().Name</c>), e.g. <c>ValueObjectDecl</c>.</param>
/// <param name="Name">The identifier text under the node's <see cref="KoineNode.NameSpan"/>, or <c>null</c> when it has none.</param>
/// <param name="Span">The node's full source range (<see cref="KoineNode.Span"/>).</param>
/// <param name="IsMissing">Whether this is an ANTLR-inserted phantom (missing) node (<see cref="KoineNode.IsMissing"/>).</param>
/// <param name="IsError">Whether this node is an error-recovery marker (<see cref="ErrorNode"/>).</param>
/// <param name="Leaf">A truncated <see cref="KoineNode.ToFullString"/> preview — set only for a CHILDLESS node, else <c>null</c>.</param>
/// <param name="Children">The node's child projections, in child-walk order.</param>
public sealed record SyntaxTreeNode(
    string Kind,
    string? Name,
    SourceSpan Span,
    bool IsMissing,
    bool IsError,
    string? Leaf,
    IReadOnlyList<SyntaxTreeNode> Children);

/// <summary>
/// Projects a parsed <see cref="KoineNode"/> subtree (the model root, or any node) into a
/// serializable <see cref="SyntaxTreeNode"/> tree by recursing the source-generated child walk
/// (<c>Koine.Compiler.Ast.ChildNodes.Of</c> / <c>KoineSyntaxChildEnumerator</c>) — the same
/// enumeration <see cref="SyntaxGraph"/> navigation uses, so sibling order is deterministic and
/// cross-runtime stable (not the implementation-defined order of the reflection oracle
/// <see cref="NodeWalker.ChildNodes"/>). No per-construct code: a new node kind is projected for
/// free. Runs equally over a clean parse and an error-tolerant (recovered) tree — recovered
/// <see cref="ErrorNode"/> markers and ANTLR-inserted <see cref="KoineNode.IsMissing"/> phantoms
/// surface flagged, rather than being dropped (the generated walk does not filter them).
/// </summary>
public static class SyntaxTreeProvider
{
    /// <summary>Max characters of a childless node's <see cref="KoineNode.ToFullString"/> preview before it is truncated.</summary>
    private const int MaxLeafLength = 40;

    /// <summary>
    /// Builds the <see cref="SyntaxTreeNode"/> projection of <paramref name="root"/> and every
    /// descendant. <paramref name="source"/> is the original text the node spans were computed
    /// over — it is sliced by each node's <see cref="KoineNode.NameSpan"/> to recover the
    /// declaration name.
    /// </summary>
    public static SyntaxTreeNode Build(KoineNode root, string source)
    {
        var children = new List<SyntaxTreeNode>();
        // Order children via the source-generated child walk — the same enumeration SyntaxGraph
        // navigation uses — so the DTO's sibling order is deterministic and cross-runtime stable.
        // Fully qualified so 'ChildNodes' can't be misread as a member of this type.
        foreach (KoineNode child in Koine.Compiler.Ast.ChildNodes.Of(root))
        {
            children.Add(Build(child, source));
        }

        // A childless node carries a truncated source preview; a composite node's text is its
        // children, so it gets none.
        string? leaf = children.Count == 0 ? Truncate(root.ToFullString()) : null;

        return new SyntaxTreeNode(
            Kind: root.GetType().Name,
            Name: NameSlice(root.NameSpan, source),
            Span: root.Span,
            IsMissing: root.IsMissing,
            IsError: root is ErrorNode,
            Leaf: leaf,
            Children: children);
    }

    /// <summary>The <paramref name="source"/> text under <paramref name="nameSpan"/>, or <c>null</c> when the node has no name or the span is out of range.</summary>
    private static string? NameSlice(SourceSpan nameSpan, string source)
    {
        if (nameSpan.IsNone)
        {
            return null;
        }

        int start = nameSpan.Offset;
        int length = nameSpan.Length;
        if (start < 0 || length <= 0 || start > source.Length - length)
        {
            return null;
        }

        return source.Substring(start, length);
    }

    private static string Truncate(string text) =>
        text.Length <= MaxLeafLength ? text : string.Concat(text.AsSpan(0, MaxLeafLength), "…");
}
