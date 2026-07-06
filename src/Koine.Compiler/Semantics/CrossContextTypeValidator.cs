using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.Semantics;

/// <summary>
/// Issue #1091 — warns (KOI1419) when a type declared in <b>more than one</b> bounded context (and not
/// a shared-kernel type) is referenced from a <b>third</b> context. The flat-module emitters (Rust,
/// Java) cannot emit a bare name there — they must pick a deterministic canonical owner to qualify the
/// reference (<see cref="ModelIndex.ResolveCanonicalOwner"/>). This focused validator surfaces that
/// otherwise-silent choice to the modeller, naming the declaring contexts and the owner the reference
/// qualifies to, so a genuine cross-context name collision is visible rather than hidden behind
/// generated code.
///
/// <para>It mirrors the emitters' resolution exactly, so the cases that do NOT need a canonical choice
/// never warn: a reference that binds locally within one of the type's own owning contexts (#437), a
/// uniquely-owned type, and a shared-kernel type (physically homed by R14.2) are all silent.
/// TARGET-AGNOSTIC — it reports a diagnostic only.</para>
/// </summary>
internal static class CrossContextTypeValidator
{
    /// <summary>Reports the multi-owner cross-context warning for every reference a context names.</summary>
    public static void Validate(ContextNode ctx, ModelIndex index, List<Diagnostic> diagnostics)
    {
        foreach (TypeRef tr in ModelIndex.AllTypeRefsIn(ctx))
        {
            Check(ctx.Name, tr, index, diagnostics);
        }
    }

    private static void Check(string fromContext, TypeRef tr, ModelIndex index, List<Diagnostic> diagnostics)
    {
        // A shared-kernel type is physically homed in one canonical module (R14.2) — never ambiguous.
        // A type declared in >1 context and referenced from a context that is NOT one of its owners is
        // the multi-owner case the emitters qualify to a canonical owner; surface that choice once.
        if (!index.IsSharedKernelType(tr.Name))
        {
            IReadOnlyList<string> declaring = index.DeclaringContextsOf(tr.Name);
            if (declaring.Count > 1
                && !Contains(declaring, fromContext)
                && index.ResolveCanonicalOwner(tr.Name, fromContext) is { } owner)
            {
                diagnostics.Add(Diagnostic.Warning(DiagnosticCodes.AmbiguousMultiOwnerReference,
                    $"type '{tr.Name}' is declared in contexts '{string.Join("', '", declaring)}' and referenced from '{fromContext}'; qualifying to '{owner}'",
                    tr.Span));
            }
        }

        // A generic's element / value type argument may itself be a multi-owner reference.
        if (tr.Element is not null)
        {
            Check(fromContext, tr.Element, index, diagnostics);
        }

        if (tr.Value is not null)
        {
            Check(fromContext, tr.Value, index, diagnostics);
        }
    }

    private static bool Contains(IReadOnlyList<string> contexts, string value)
    {
        foreach (var c in contexts)
        {
            if (string.Equals(c, value, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }
}
