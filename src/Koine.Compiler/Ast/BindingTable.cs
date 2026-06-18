namespace Koine.Compiler.Ast;

/// <summary>
/// The reference → symbol map (Commit 3, TARGET-AGNOSTIC): every reference-bearing syntax node
/// (<see cref="IdentifierExpr"/>, <see cref="TypeRef"/>, a <see cref="MemberAccessExpr"/> selector,
/// a <see cref="SpecDecl"/>'s target type) maps to the interned <see cref="Symbol"/> it resolves to.
///
/// <para><b>Reference-identity keying is MANDATORY.</b> <see cref="KoineNode"/> is a value-equality
/// <c>record</c>: the many <c>IdentifierExpr("amount")</c> reference nodes in a file are all
/// value-equal. The dictionary therefore uses the BCL
/// <see cref="ReferenceEqualityComparer.Instance"/> — exactly as <see cref="SyntaxGraph"/> does — or
/// every same-named reference would collide to one binding and the table would be silently wrong.</para>
/// </summary>
internal sealed class BindingTable
{
    private readonly Dictionary<KoineNode, Symbol> _bindings = new(ReferenceEqualityComparer.Instance);

    internal void Bind(KoineNode reference, Symbol symbol) => _bindings[reference] = symbol;

    /// <summary>
    /// The symbol a reference-bearing node resolves to; <see cref="ErrorSymbol.Instance"/> when the
    /// node is reference-bearing but unresolved, or is not a reference node at all (callers ask only
    /// about reference nodes). Never <c>null</c>, mirroring <see cref="ErrorType.Instance"/>.
    /// </summary>
    public Symbol GetSymbolInfo(KoineNode node) =>
        _bindings.TryGetValue(node, out Symbol? s) ? s : ErrorSymbol.Instance;
}
