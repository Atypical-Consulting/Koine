using System.ComponentModel;
using Koine.Compiler.Ast;
using Koine.Compiler.Services;
using ModelContextProtocol.Server;

namespace Koine.Mcp.Tools;

/// <summary>
/// The <c>koine_coverage</c> tool: which of a model's declared types a chosen target actually emits.
/// It runs the same compile path as <c>koine_compile</c> and then walks the semantic model's declared
/// types against the emitted file text, returning a <see cref="CoverageReport"/> (per-type
/// <c>Covered</c>/<c>Missing</c> plus <c>Total</c>/<c>Covered</c>/<c>IsComplete</c> rollups).
/// </summary>
[McpServerToolType]
public static class CoverageTool
{
    [McpServerTool(Name = "koine_coverage")]
    [Description("""
        Report which of a Koine model's declared types a chosen `target` actually emits. Compiles the
        .koi files (same path as koine_compile) and matches every declared value/entity/aggregate/enum/
        event/integrationEvent/readModel/query against the generated output. `target` is one of: csharp
        (default), typescript, python, php, rust, glossary, or docs. Returns { Target, Total, Covered, IsComplete,
        Items[] } where each item has { Kind, Name, Context, State } and State is "Covered" or "Missing".
        IsComplete is true when nothing is Missing. If the model has semantic errors no files are
        produced (run koine_validate to see why) and every type reports as Missing.
        """)]
    public static CoverageReport Coverage(
        [Description("The .koi files to analyze. Provide a single entry for a one-file model.")]
        KoineFile[] files,
        [Description("Output target: csharp (default), typescript, python, php, rust, glossary, or docs.")]
        string target = "csharp")
    {
        // Same transport-level input guard as koine_validate/koine_compile: reject empty/duplicate/
        // null/oversized file inputs before the compiler runs. Coverage surfaces no diagnostics, so a
        // guard failure degrades to an empty report — matching how a bad target / unparseable model
        // already report (every type Missing / nothing covered).
        if (!ToolGuards.TryValidateFiles(files, out _))
        {
            return new CoverageReport(target, Array.Empty<CoverageItem>());
        }

        if (!EmitterFactory.TryCreate(target, out var emitter, out _))
        {
            return new CoverageReport(target, Array.Empty<CoverageItem>());
        }

        var result = new KoineCompiler().Compile(KoineFile.ToSources(files), emitter);
        if (result.Model is null)
        {
            return new CoverageReport(target, Array.Empty<CoverageItem>());
        }

        return ModelCoverage.Compute(result.Model, result.Files, target);
    }
}
