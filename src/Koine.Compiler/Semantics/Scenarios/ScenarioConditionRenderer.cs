using Koine.Compiler.Ast;
using Koine.Compiler.Formatting;

namespace Koine.Compiler.Semantics.Scenarios;

/// <summary>
/// Renders a <c>requires</c>/<c>invariant</c> condition for scenario-runner display text (#1752):
/// source-backed via <see cref="AstPrinter"/> when the node's originating file's source is known —
/// preserving the author's own operators and punctuation, which a pure tree walk
/// (<see cref="KoineNode.ToFullString"/>) cannot reconstruct, since Koine has no <c>SyntaxToken</c>
/// layer — falling back to <c>ToFullString()</c> otherwise (a synthesized node, or a file whose source
/// isn't in hand). Shared by <c>ScenarioInterpreter</c> (interpreted mode) and <c>ScenarioExecutor</c>
/// (executed mode, #236) so the two runners' condition text can never drift.
/// </summary>
internal static class ScenarioConditionRenderer
{
    private static readonly IReadOnlyDictionary<string, AstPrinter> Empty =
        new Dictionary<string, AstPrinter>(0);

    /// <summary>
    /// Builds a per-file printer lookup from workspace sources (file path → source text). A file
    /// missing from <paramref name="sourcesByFile"/> — or a node with no <see cref="SourceSpan.File"/>
    /// (a synthesized node) — falls back to the tree-walk rendering in <see cref="Render"/>.
    /// </summary>
    public static IReadOnlyDictionary<string, AstPrinter> BuildPrinters(
        IReadOnlyDictionary<string, string>? sourcesByFile)
    {
        if (sourcesByFile is null || sourcesByFile.Count == 0)
        {
            return Empty;
        }

        var printers = new Dictionary<string, AstPrinter>(sourcesByFile.Count, StringComparer.Ordinal);
        foreach ((string file, string source) in sourcesByFile)
        {
            printers[file] = new AstPrinter(source);
        }

        return printers;
    }

    /// <summary>
    /// Renders <paramref name="condition"/> through the printer for its originating file, or
    /// <see cref="KoineNode.ToFullString"/> when no source is resolvable for it — never throws (the
    /// printer's own source-slice fallback is bounds-checked, and an unresolved file simply misses the
    /// dictionary lookup).
    /// </summary>
    public static string Render(Expr condition, IReadOnlyDictionary<string, AstPrinter> printers) =>
        condition.Span.File is { } file && printers.TryGetValue(file, out AstPrinter? printer)
            ? printer.Print(condition)
            : condition.ToFullString();
}
