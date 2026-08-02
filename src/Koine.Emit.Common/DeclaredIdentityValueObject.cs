using Koine.Compiler.Ast;

namespace Koine.Compiler;

/// <summary>
/// Whether an entity's <c>identified by</c> name is already declared as a <c>value</c> in its OWN
/// bounded context (#1848). Every code emitter synthesizes a conventional identity value object for
/// <c>identified by</c> unconditionally, without asking this question first — so a model that ALSO
/// declares <c>value OrderId { … }</c> explicitly gets that type emitted twice, under the same
/// relative path, and the generated code fails to compile.
/// </summary>
/// <remarks>
/// Routed entirely through <see cref="ModelIndex.TryGetDeclIn"/> — the one context-aware resolution
/// seam every emitter, validator and <see cref="ModelIndex.TryGetDecl(string?, string, out TypeDecl)"/>
/// already share — so a same-named value object declared only in a SIBLING context (the #1834/#1816
/// flat-resolution trap) never suppresses synthesis it shouldn't: <c>TryGetDeclIn</c> resolves within
/// <paramref name="context"/> itself, or through a single-owner import/map-permit into it, never a
/// name some unrelated context happens to also declare.
/// </remarks>
public static class DeclaredIdentityValueObject
{
    /// <summary>
    /// True when <paramref name="context"/> declares (or unambiguously imports/map-permits) a
    /// <c>value <paramref name="idName"/></c> — the case where the caller must reference the DECLARED
    /// type rather than synthesize a second one.
    /// </summary>
    public static bool IsDeclaredIn(ModelIndex index, string context, string idName) =>
        index.TryGetDeclIn(context, idName, out TypeDecl decl) && decl is ValueObjectDecl;
}
