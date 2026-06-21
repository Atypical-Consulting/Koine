using System.Collections;
using System.Diagnostics.CodeAnalysis;
using System.Reflection;

namespace Koine.Compiler.Ast;

/// <summary>
/// Enumerates the <see cref="KoineNode"/> descendants of a model subtree, reflecting over each
/// node's public properties (a <see cref="KoineNode"/> or a sequence of them). Target-agnostic
/// and grammar-agnostic: a new node kind is walked automatically without touching this code.
/// <para>
/// This reflection-based walk is the independent ORACLE the test suite cross-checks the
/// source-generated child enumeration (<c>ChildNodes.Of</c> / <c>KoineSyntaxChildEnumerator</c>) and
/// the production <see cref="ReconstructionWalker"/> against. The production paths no longer use it:
/// the position→node map (<see cref="SyntaxGraph"/>, behind <see cref="SemanticModel.NodeAt"/>) and
/// source reconstruction (<see cref="KoineNode.ToFullString"/> / <see
/// cref="Koine.Compiler.Formatting.AstPrinter"/>) both run on the generated, reflection-free walk.
/// </para>
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

    /// <summary>
    /// The reflection oracle for <see cref="ReconstructionWalker.Children"/>: the child nodes to use
    /// when reconstructing source text from the tree — real syntax children in source order (ascending
    /// <see cref="SourceSpan.Offset"/>), EXCLUDING error-recovery markers. <see cref="ErrorNode"/>
    /// markers are a side-channel (e.g. <see cref="ContextNode.Errors"/>) whose offsets overlap the
    /// recovered real children, so emitting them inline would double-count and interleave stray
    /// fragments. Synthesized children with no position (<see cref="SourceSpan.None"/>) sort stably to
    /// the end, preserving their reflection order. Production reconstruction uses the generated
    /// <see cref="ReconstructionWalker"/>; this method exists so the test suite can prove the two agree.
    /// </summary>
    internal static IEnumerable<KoineNode> ReconstructionChildren(KoineNode node) =>
        ChildNodes(node)
            .Where(c => c is not ErrorNode)
            .OrderBy(c => c.Span.IsNone ? int.MaxValue : c.Span.Offset);

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

    [UnconditionalSuppressMessage("Trimming", "IL2070",
        Justification = "Reflects over Koine.Compiler's own node types. The only trimmed build " +
            "(the browser-wasm publish) roots the whole Koine.Compiler assembly via " +
            "<TrimmerRootAssembly> (see src/Koine.Wasm/Koine.Wasm.csproj), so every node type's " +
            "public properties are preserved regardless of dataflow analysis. Annotating the " +
            "parameter would only move the warning to the open-hierarchy GetType() call site.")]
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
