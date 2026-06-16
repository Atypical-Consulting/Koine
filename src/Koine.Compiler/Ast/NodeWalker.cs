using System.Collections;
using System.Reflection;

namespace Koine.Compiler.Ast;

/// <summary>
/// Enumerates the <see cref="KoineNode"/> descendants of a model subtree, reflecting over each
/// node's public properties (a <see cref="KoineNode"/> or a sequence of them). Target-agnostic
/// and grammar-agnostic: a new node kind is walked automatically without touching this code.
/// Used by <see cref="SemanticModel.NodeAt"/> for the position→node map.
/// </summary>
internal static class NodeWalker
{
    // Per-type cache of the properties that can yield child nodes, so reflection is paid once.
    private static readonly Dictionary<Type, PropertyInfo[]> ChildProps = new();

    /// <summary>The node itself, then every descendant node, in a depth-first pre-order walk.</summary>
    public static IEnumerable<KoineNode> Descendants(KoineNode root)
    {
        yield return root;
        foreach (KoineNode child in ChildNodes(root))
        {
            foreach (KoineNode d in Descendants(child))
            {
                yield return d;
            }
        }
    }

    internal static IEnumerable<KoineNode> ChildNodes(KoineNode node)
    {
        foreach (PropertyInfo prop in PropertiesFor(node.GetType()))
        {
            object? value = prop.GetValue(node);
            switch (value)
            {
                case KoineNode child:
                    yield return child;
                    break;
                case IEnumerable seq and not string:
                    foreach (var item in seq)
                    {
                        if (item is KoineNode n)
                        {
                            yield return n;
                        }
                    }

                    break;
            }
        }
    }

    private static PropertyInfo[] PropertiesFor(Type type)
    {
        lock (ChildProps)
        {
            if (ChildProps.TryGetValue(type, out PropertyInfo[]? cached))
            {
                return cached;
            }

            PropertyInfo[] props = type
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.GetIndexParameters().Length == 0 && CanYieldNodes(p.PropertyType))
                .ToArray();
            ChildProps[type] = props;
            return props;
        }
    }

    /// <summary>True for a property whose value could (transitively) be a <see cref="KoineNode"/>.</summary>
    private static bool CanYieldNodes(Type t)
    {
        if (typeof(KoineNode).IsAssignableFrom(t))
        {
            return true;
        }

        // A sequence (but not a string) that might contain nodes — element type checked at runtime
        // so a generic collection of an abstract node base (e.g. Expr, TypeDecl) is included.
        return t != typeof(string)
            && typeof(IEnumerable).IsAssignableFrom(t)
            && t != typeof(SourceSpan);
    }
}
