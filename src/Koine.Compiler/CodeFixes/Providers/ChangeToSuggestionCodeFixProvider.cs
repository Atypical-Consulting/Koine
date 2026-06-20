using Koine.Compiler.Diagnostics;

namespace Koine.Compiler.CodeFixes.Providers;

/// <summary>
/// The "Change to 'X'" quick fix. For any diagnostic carrying a structured
/// <see cref="Diagnostic.Suggestion"/>, offers a single edit replacing the diagnostic's own span with
/// the suggested identifier. The fixable codes are the "did you mean" diagnostics whose span is exactly
/// the mistyped identifier — unknown type, unknown field, unknown enum member for a typed default, and
/// an unknown read-model field — so replacing the whole span is the correct edit. (Member-access typos
/// such as KOI0202 are deliberately excluded: their span covers the whole <c>receiver.member</c>, so a
/// whole-span replacement would be wrong.) The replacement and the span come ENTIRELY from the
/// structured diagnostic — never from the message prose — so the fix is correct even when the message
/// text is blank.
/// </summary>
public sealed class ChangeToSuggestionCodeFixProvider : ICodeFixProvider
{
    public IReadOnlyCollection<string> FixableDiagnosticCodes { get; } =
    [
        DiagnosticCodes.UnknownType,
        DiagnosticCodes.UnknownField,
        DiagnosticCodes.UnknownEnumMemberForType,
        DiagnosticCodes.ReadModelUnknownField,
    ];

    public IReadOnlyList<CodeFix> GetFixes(CodeFixContext context)
    {
        if (context.Diagnostic is not { Suggestion: { Length: > 0 } suggestion } diagnostic)
        {
            return [];
        }

        return
        [
            new CodeFix(
                $"Change to '{suggestion}'",
                "quickfix",
                // Batchable across diagnostics: every "change to the same suggestion" fix shares a key,
                // so a fix-all aggregates all unknown-type typos resolving to the same name.
                $"ChangeTo:{suggestion}",
                [new CodeFixEdit(diagnostic.Span, suggestion)]),
        ];
    }
}
