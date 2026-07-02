using System.Text;
using Koine.Compiler.Ast;
using Koine.Compiler.Emit;

namespace Koine.Compiler;

/// <summary>
/// Coverage slice of <see cref="DocsEmitter"/>: appends a "Coverage" section to each context
/// document that reports which of the context's declared constructs the docs target rendered.
/// It reuses the target-agnostic <see cref="ModelCoverage"/> analyzer against the narrative built
/// so far (the Coverage section is appended LAST), so the report is a faithful, deterministic
/// accounting of what the page above actually documents.
/// </summary>
public sealed partial class DocsEmitter
{
    /// <summary>
    /// Appends the "## Coverage" section for one context: a per-kind covered/total table computed
    /// from the narrative already in <paramref name="sb"/>, ending in a single ✅/⚠️ status line.
    /// </summary>
    private static void WriteCoverageSection(StringBuilder sb, ContextNode ctx)
    {
        var ctxModel = new KoineModel(new[] { ctx });
        var emitted = new[] { new EmittedFile($"docs/{ctx.Name}.md", sb.ToString()) };
        CoverageReport report = ModelCoverage.Compute(ctxModel, emitted, "docs");

        sb.Append("\n## Coverage\n\n");

        if (report.Total == 0)
        {
            sb.Append("_No declared constructs._\n");
            return;
        }

        sb.Append("| Kind | Covered | Total |\n");
        sb.Append("| --- | --- | --- |\n");
        foreach (IGrouping<string, CoverageItem> kind in report.Items
            .GroupBy(i => i.Kind, StringComparer.Ordinal)
            .OrderBy(g => g.Key, StringComparer.Ordinal))
        {
            int covered = kind.Count(i => i.State == CoverageState.Covered);
            int total = kind.Count();
            sb.Append("| ").Append(kind.Key).Append(" | ")
              .Append(covered).Append(" | ").Append(total).Append(" |\n");
        }

        if (report.IsComplete)
        {
            sb.Append("\n_All declared constructs are documented._ ✅\n");
        }
        else
        {
            int missing = report.Total - report.Covered;
            sb.Append("\n⚠️ ").Append(missing).Append(" not documented\n");
        }
    }
}
