using Koine.Compiler.Ast;
using Koine.Compiler.CodeFixes.Providers;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;

namespace Koine.Compiler.CodeFixes;

/// <summary>
/// The unified front door to Koine's code fixes (issue #69): runs the registered
/// <see cref="ICodeFixProvider"/>s for quick fixes (from a diagnostic) and refactors (from a
/// selection), and aggregates same-kind fixes across diagnostics for fix-all. Every host — the stdio
/// LSP, the WASM bridge — drives fixes through this one service so the offered set is identical.
/// </summary>
public sealed class CodeFixService
{
    private readonly IReadOnlyList<ICodeFixProvider> _providers;

    /// <summary>Creates the service with the built-in provider set.</summary>
    public CodeFixService()
        : this(DefaultProviders())
    {
    }

    /// <summary>Creates the service with an explicit provider set (for tests/embedding).</summary>
    public CodeFixService(IReadOnlyList<ICodeFixProvider> providers)
    {
        _providers = providers;
    }

    /// <summary>The built-in providers, in offer order.</summary>
    public static IReadOnlyList<ICodeFixProvider> DefaultProviders() =>
    [
        new ChangeToSuggestionCodeFixProvider(),
        new ExtractValueObjectCodeFixProvider(),
    ];

    /// <summary>
    /// The quick fixes offered for a single <paramref name="diagnostic"/> over <paramref name="sourceText"/>:
    /// every provider that declares the diagnostic's code is asked for fixes. <paramref name="model"/> is the
    /// parsed source when available (a quick fix may not need it). The diagnostic span/<c>Suggestion</c> drive
    /// the edits — no message prose is read.
    /// </summary>
    public IReadOnlyList<CodeFix> FixesForDiagnostic(string sourceText, KoineModel? model, Diagnostic diagnostic)
    {
        var context = new CodeFixContext(_compiler, sourceText, model, diagnostic, selection: null);
        var fixes = new List<CodeFix>();
        foreach (var provider in _providers)
        {
            if (provider.FixableDiagnosticCodes.Contains(diagnostic.Code))
            {
                fixes.AddRange(provider.GetFixes(context));
            }
        }

        return fixes;
    }

    /// <summary>
    /// The selection-driven refactors offered for the selection <c>[startOffset, endOffset)</c> over
    /// <paramref name="sourceText"/> with the parsed <paramref name="model"/>: every refactor provider
    /// (one with no fixable diagnostic codes) is offered the selection.
    /// </summary>
    public IReadOnlyList<CodeFix> RefactorsForSelection(string sourceText, KoineModel model, int startOffset, int endOffset)
    {
        var context = new CodeFixContext(
            _compiler, sourceText, model, diagnostic: null, new SelectionRange(startOffset, endOffset));
        var fixes = new List<CodeFix>();
        foreach (var provider in _providers)
        {
            if (provider.FixableDiagnosticCodes.Count == 0)
            {
                fixes.AddRange(provider.GetFixes(context));
            }
        }

        return fixes;
    }

    /// <summary>
    /// Fix-all: given several diagnostics of the SAME code over one document, produces ONE aggregated
    /// fix set keyed by <see cref="CodeFix.EquivalenceKey"/> — every per-diagnostic fix sharing a key
    /// collapses into a single <see cref="CodeFix"/> whose edits are the union (de-duplicated, ordered by
    /// source offset). A fix with a <c>null</c> key opts out and is omitted from the batch. The title and
    /// kind are taken from the first fix in each group.
    /// </summary>
    public IReadOnlyList<CodeFix> FixAll(string sourceText, KoineModel? model, IEnumerable<Diagnostic> diagnostics)
    {
        // Preserve first-seen order of equivalence keys for a deterministic result.
        var order = new List<string>();
        var groups = new Dictionary<string, List<CodeFix>>(StringComparer.Ordinal);

        foreach (var diagnostic in diagnostics)
        {
            foreach (var fix in FixesForDiagnostic(sourceText, model, diagnostic))
            {
                if (fix.EquivalenceKey is not { } key)
                {
                    continue; // a non-batchable fix is not part of any fix-all.
                }

                if (!groups.TryGetValue(key, out var bucket))
                {
                    bucket = [];
                    groups[key] = bucket;
                    order.Add(key);
                }

                bucket.Add(fix);
            }
        }

        var result = new List<CodeFix>();
        foreach (var key in order)
        {
            var bucket = groups[key];
            var head = bucket[0];
            var edits = bucket
                .SelectMany(f => f.Edits)
                .GroupBy(e => (e.Range.Offset, e.Range.Length, e.NewText))
                .Select(g => g.First())
                .OrderBy(e => e.Range.Offset)
                .ToList();

            result.Add(new CodeFix($"Fix all '{head.Kind}': {head.Title}", head.Kind, key, edits));
        }

        return result;
    }

    private readonly KoineCompiler _compiler = new();
}
