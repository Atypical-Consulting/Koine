using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.CodeFixes.Providers;

/// <summary>
/// The "Make '&lt;field&gt;' optional" quick fix for <see cref="DiagnosticCodes.OptionalAssignedToNonOptional"/>
/// (KOI0401): an optional value initializes a non-optional field with no <c>??</c> fallback. The fix marks
/// the field's type optional by inserting a <c>?</c> immediately after the type name. The target member and
/// the insertion point come ENTIRELY from the structured diagnostic span and the parsed
/// <see cref="CodeFixContext.Model"/> — never the message prose — so the fix is correct even when the
/// message text is blank. The field is located by matching the diagnostic span (which covers the offending
/// <c>name: Type = init</c> member) against the model's members; the <c>?</c> is inserted at the END of the
/// member's <see cref="Member.Type"/> span. When no member with a usable type span can be resolved (e.g. a
/// KOI0401 raised in a non-field context), the provider offers nothing.
/// </summary>
public sealed class AddOptionalMarkerCodeFixProvider : ICodeFixProvider
{
    public IReadOnlyCollection<string> FixableDiagnosticCodes { get; } =
    [
        DiagnosticCodes.OptionalAssignedToNonOptional,
    ];

    public IReadOnlyList<CodeFix> GetFixes(CodeFixContext context)
    {
        if (context.Diagnostic is not { } diagnostic || context.Model is not { } model)
        {
            return [];
        }

        // Find the field member whose span the diagnostic points at (the validator raises KOI0401 with the
        // offending member's span). We need its Type span to know where to insert the '?'.
        Member? target = FindMemberBySpan(model, diagnostic.Span);
        if (target is not { } member || member.Type.Span.IsNone)
        {
            return [];
        }

        // The insertion point is just past the type name occurrence (so 'Int' -> 'Int?'). A zero-width span
        // there is a pure insertion.
        var insertAt = member.Type.Span.Offset + member.Type.Span.Length;
        var insertion = new SourceSpan(
            member.Type.Span.EndLine, member.Type.Span.EndColumn,
            member.Type.Span.EndLine, member.Type.Span.EndColumn,
            insertAt, 0, member.Type.Span.File);

        return
        [
            new CodeFix(
                $"Make '{member.Name}' optional",
                "quickfix",
                EquivalenceKey: null,
                [new CodeFixEdit(insertion, "?")]),
        ];
    }

    /// <summary>
    /// The model member whose span exactly matches the diagnostic span (same start offset), searched across
    /// every type that carries members, or <c>null</c> when none matches.
    /// </summary>
    private static Member? FindMemberBySpan(KoineModel model, SourceSpan span)
    {
        foreach (Member member in AllMembers(model))
        {
            if (!member.Span.IsNone && member.Span.Offset == span.Offset)
            {
                return member;
            }
        }

        return null;
    }

    /// <summary>Every field member declared anywhere in the model, across all contexts and aggregates.</summary>
    private static IEnumerable<Member> AllMembers(KoineModel model)
    {
        foreach (ContextNode ctx in model.Contexts)
        {
            foreach (TypeDecl type in ctx.AllTypeDecls())
            {
                foreach (Member member in MembersOf(type))
                {
                    yield return member;
                }
            }
        }
    }

    /// <summary>The field members of <paramref name="type"/>, or empty for a kind that carries none.</summary>
    private static IReadOnlyList<Member> MembersOf(TypeDecl type) => type switch
    {
        ValueObjectDecl v => v.Members,
        EntityDecl e => e.Members,
        EventDecl ev => ev.Members,
        IntegrationEventDecl ie => ie.Members,
        _ => [],
    };
}
