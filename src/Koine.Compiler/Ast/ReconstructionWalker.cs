namespace Koine.Compiler.Ast;

/// <summary>
/// The child nodes to use when reconstructing source text from the tree (<see
/// cref="KoineNode.ToFullString"/> / <see cref="Koine.Compiler.Formatting.AstPrinter"/>): real syntax
/// children in source order (ascending <see cref="SourceSpan.Offset"/>), EXCLUDING error-recovery
/// markers. <see cref="ErrorNode"/> markers are a side-channel (e.g. <c>ContextNode.Errors</c>) whose
/// offsets overlap the recovered real children, so emitting them inline would double-count and
/// interleave stray fragments. Synthesized children with no position (<see cref="SourceSpan.None"/>)
/// sort stably to the end, preserving their enumeration order.
/// <para>
/// Backed by the source-GENERATED <c>ChildNodes.Of</c> (see
/// <c>Koine.Compiler.SourceGen.SyntaxVisitorGenerator</c>), so the production reconstruction path
/// carries no runtime reflection. The reflection-based <see cref="NodeWalker.ReconstructionChildren"/>
/// is kept as the independent test oracle that this walk is checked against.
/// </para>
/// </summary>
internal static class ReconstructionWalker
{
    /// <summary>The reconstruction children of <paramref name="node"/>, error markers excluded, in source order.</summary>
    internal static IEnumerable<KoineNode> Children(KoineNode node) =>
        ChildNodes.Of(node)
            .Where(c => c is not ErrorNode)
            .OrderBy(c => c.Span.IsNone ? int.MaxValue : c.Span.Offset);
}
