using Koine.Compiler.Services;

namespace Koine.Compiler.CodeFixes.Providers;

/// <summary>
/// The selection-driven "Extract value object" refactor. It fixes no diagnostic code (it is offered
/// against a selection, not a diagnostic), so <see cref="FixableDiagnosticCodes"/> is empty. When the
/// <see cref="CodeFixContext.Selection"/> lands on one or more contiguous member fields of a
/// value/entity/event type, it offers a <c>refactor.extract</c> fix that lifts those fields into a new
/// sibling value object and rewires the origin — the exact behavior of <see cref="RefactorService"/>.
/// </summary>
public sealed class ExtractValueObjectCodeFixProvider : ICodeFixProvider
{
    public IReadOnlyCollection<string> FixableDiagnosticCodes { get; } = [];

    public IReadOnlyList<CodeFix> GetFixes(CodeFixContext context)
    {
        if (context.Selection is not { } selection || context.Model is not { } model)
        {
            return [];
        }

        return RefactorService.RefactorsFor(
            context.SourceText, model, selection.StartOffset, selection.EndOffset);
    }
}
