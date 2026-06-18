using Koine.Compiler.Ast;

namespace Koine.Compiler.Emit.Glossary;

/// <summary>
/// One entry in the structured glossary (#67): a single named declaration (a context or a type)
/// with its kind, owning context, stable qualified id, doc-comment presence (for documentation
/// coverage), and the source span of its name (for navigation / doc-comment editing). Purely
/// target-agnostic — built from the <see cref="KoineModel"/>, carries no emitter concept.
/// </summary>
/// <param name="Id">Stable address for the entry; equal to <see cref="QualifiedName"/>.</param>
/// <param name="Name">The declaration's simple name.</param>
/// <param name="Kind">The construct kind: <c>context</c>, <c>aggregate</c>, <c>enum</c>, <c>value</c>,
/// <c>quantity</c>, <c>event</c>, <c>integration event</c>, or <c>entity</c> (matches the glossary doc).</param>
/// <param name="Context">The owning bounded context's name.</param>
/// <param name="QualifiedName">Dotted path from the context (e.g. <c>Ordering.Money</c>, or
/// <c>Sales.Cart.CartLine</c> for an aggregate-nested type).</param>
/// <param name="Doc">The <c>///</c> doc comment (already <c>///</c>-stripped) or <c>null</c> when undocumented.</param>
/// <param name="NameSpan">The 1-based source span of the declaration's name.</param>
public sealed record GlossaryEntry(
    string Id,
    string Name,
    string Kind,
    string Context,
    string QualifiedName,
    string? Doc,
    SourceSpan NameSpan);

/// <summary>The structured glossary: every context/type entry in declaration order (deterministic).</summary>
public sealed record GlossaryModel(IReadOnlyList<GlossaryEntry> Entries);
