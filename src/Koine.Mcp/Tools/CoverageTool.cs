using System.ComponentModel;
using Koine.Compiler.Ast;
using Koine.Compiler.Services;
using ModelContextProtocol;
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
        (default), typescript, python, php, rust, glossary, docs, asyncapi, or openapi. Returns { Target, Total, Covered, IsComplete,
        Items[] } where each item has { Kind, Name, Context, State } and State is "Covered" or "Missing".
        IsComplete is true when nothing is Missing. An unknown `target`, malformed file input, or a
        model that fails to compile (a parse or semantic error) is reported as a tool error — never an
        empty, vacuously-"complete" report; run koine_validate to see a failing model's diagnostics.
        """)]
    public static CoverageReport Coverage(
        [Description("The .koi files to analyze. Provide a single entry for a one-file model.")]
        KoineFile[] files,
        [Description("Output target: csharp (default), typescript, python, php, rust, glossary, docs, asyncapi, or openapi.")]
        string target = "csharp")
    {
        // Same transport-level input guard as koine_validate/koine_compile: reject empty/duplicate/
        // null/oversized file inputs before the compiler runs. Coverage has no diagnostics channel, so
        // a guard failure must surface as a tool error (the way koine_compile reports it) — NOT a
        // vacuously-complete empty report an agent would read as success (#622). Carry the real guard
        // messages instead of discarding them with `out _`.
        if (!ToolGuards.TryValidateFiles(files, out var guardErrors))
        {
            throw new McpException(string.Join("; ", guardErrors.Select(e => e.Message)));
        }

        // An unknown/typo'd target has nothing to measure coverage against. Surface the real
        // EmitterFactory message (it names the supported targets) rather than discarding it and
        // returning a counterfeit "complete" report.
        if (!EmitterFactory.TryCreate(target, out var emitter, out var error))
        {
            throw new McpException(error!);
        }

        // A model that fails to parse or has semantic errors emits no files, so a coverage report would
        // be either all-Missing or — for an empty recovered model — vacuously Covered. Either way the
        // number is meaningless: error out and point the caller at koine_validate for the diagnostics.
        // (Parsing is error-tolerant, so a syntax error yields a partial model rather than a null one;
        // `!result.Success` catches both that and any semantic error, with `Model is null` as a guard.)
        var result = new KoineCompiler().Compile(KoineFile.ToSources(files), emitter);
        if (result.Model is null || !result.Success)
        {
            throw new McpException(
                $"the model could not be compiled for target '{target}', so coverage cannot be measured — run koine_validate to see the diagnostics");
        }

        return ModelCoverage.Compute(result.Model, result.Files, target);
    }
}
