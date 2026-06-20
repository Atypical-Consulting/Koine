using System.ComponentModel;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Services;
using ModelContextProtocol.Server;

namespace Koine.Mcp.Tools;

/// <summary>The <c>koine_validate</c> tool: parse + full semantic validation, no emission.</summary>
[McpServerToolType]
public static class ValidateTool
{
    [McpServerTool(Name = "koine_validate")]
    [Description("""
        Validate Koine (.koi) source: parse it and run the full semantic checks, without emitting code.
        Pass one file, or several — a multi-file model is compiled together so cross-file imports,
        context maps, and integration events resolve. Returns { ok, errorCount, warningCount,
        diagnostics[] }, where each diagnostic has a stable code (e.g. KOI0201), a message, and a
        1-based line/column span. This is the loop-closer: keep fixing the source and re-validating
        until `ok` is true. If you are unsure of Koine syntax, call koine_reference and koine_examples
        first.
        """)]
    public static ValidationResult Validate(
        [Description("The .koi files to validate. Provide a single entry for a one-file model.")]
        KoineFile[] files)
    {
        if (!ToolGuards.TryValidateFiles(files, out var guardErrors))
        {
            return new ValidationResult(false, guardErrors.Count, 0, guardErrors);
        }

        var sources = KoineFile.ToSources(files);
        var diagnostics = new KoineCompiler().DiagnoseWorkspace(sources);

        // Mirror koine_compile: apply the diagnostic filter so in-source `# koine:disable CODE`
        // directives suppress the same diagnostics here. DiagnosticFilterOptions.None carries no
        // overrides and no warnings-as-errors, so the only effect is honoring those directives —
        // keeping validate and compile in agreement about what is suppressed.
        var filtered = DiagnosticFilter.Apply(
            diagnostics,
            DiagnosticFilterOptions.None,
            sources.Select(s => ((string?)s.Path, s.Source)).ToList());
        return ValidationResult.From(filtered);
    }
}
