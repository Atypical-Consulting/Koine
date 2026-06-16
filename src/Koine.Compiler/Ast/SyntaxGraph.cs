using System.Runtime.CompilerServices;

namespace Koine.Compiler.Ast;

/// <summary>
/// A build-once, query-many companion to an immutable <see cref="KoineNode"/> tree — Koine's
/// equivalent of Roslyn's "red layer". Because nodes are value-equality records, a mutable parent
/// pointer would break their value semantics, so the parent relation lives here in a
/// reference-keyed table. Built in a single DFS that also records each node's children (source
/// order) and its <c>FullSpan</c> (a bounding range over the node and all descendants), which
/// powers O(depth) position lookup via top-down descent (the Roslyn <c>FindNode</c> model).
/// TARGET-AGNOSTIC.
/// </summary>
internal sealed class SyntaxGraph
{
    /// <summary>Reference (identity) equality for node keys — never the records' value equality.</summary>
    private sealed class IdentityComparer : IEqualityComparer<KoineNode>
    {
        public static readonly IdentityComparer Instance = new();
        public bool Equals(KoineNode? a, KoineNode? b) => ReferenceEquals(a, b);
        public int GetHashCode(KoineNode node) => RuntimeHelpers.GetHashCode(node);
    }

    private readonly KoineNode _root;
    private readonly Dictionary<KoineNode, KoineNode?> _parent = new(IdentityComparer.Instance);
    private readonly Dictionary<KoineNode, IReadOnlyList<KoineNode>> _children = new(IdentityComparer.Instance);

    /// <summary>Bounding span per node as a half-open <c>[Start, End)</c>; an empty range never contains an offset.</summary>
    private readonly Dictionary<KoineNode, (int Start, int End)> _fullSpan = new(IdentityComparer.Instance);

    public SyntaxGraph(KoineNode root)
    {
        _root = root;
        Build(root, null);
    }

    private void Build(KoineNode node, KoineNode? parent)
    {
        _parent[node] = parent;
        IReadOnlyList<KoineNode> children = NodeWalker.ChildNodes(node).ToList();
        _children[node] = children;

        // Seed with the node's own span (if positioned), then union in each child's FullSpan.
        var start = node.Span.Length > 0 ? node.Span.Offset : int.MaxValue;
        var end = node.Span.Length > 0 ? node.Span.Offset + node.Span.Length : int.MinValue;

        foreach (KoineNode child in children)
        {
            Build(child, node);
            (int childStart, int childEnd) = _fullSpan[child];
            if (childStart < start)
            {
                start = childStart;
            }

            if (childEnd > end)
            {
                end = childEnd;
            }
        }

        _fullSpan[node] = (start, end);
    }

    /// <summary>The node's parent, or <c>null</c> for the root (or an unknown node).</summary>
    public KoineNode? Parent(KoineNode node) => _parent.GetValueOrDefault(node);

    /// <summary>The node's child nodes in source order (empty for a leaf or unknown node).</summary>
    public IReadOnlyList<KoineNode> ChildNodes(KoineNode node) =>
        _children.TryGetValue(node, out IReadOnlyList<KoineNode>? kids) ? kids : Array.Empty<KoineNode>();

    /// <summary>The parent chain, nearest-first, excluding <paramref name="node"/> and stopping at the root.</summary>
    public IEnumerable<KoineNode> Ancestors(KoineNode node)
    {
        for (KoineNode? p = Parent(node); p is not null; p = Parent(p))
        {
            yield return p;
        }
    }

    /// <summary><paramref name="node"/> first, then its <see cref="Ancestors(KoineNode)"/>.</summary>
    public IEnumerable<KoineNode> AncestorsAndSelf(KoineNode node)
    {
        yield return node;
        foreach (KoineNode a in Ancestors(node))
        {
            yield return a;
        }
    }

    /// <summary>The nearest <typeparamref name="T"/> in <see cref="AncestorsAndSelf(KoineNode)"/>, or <c>null</c>.</summary>
    public T? FirstAncestorOrSelf<T>(KoineNode node) where T : KoineNode
    {
        foreach (KoineNode n in AncestorsAndSelf(node))
        {
            if (n is T match)
            {
                return match;
            }
        }

        return null;
    }
}
