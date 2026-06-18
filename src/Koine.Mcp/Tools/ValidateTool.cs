using System.ComponentModel;
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
        var diagnostics = new KoineCompiler().DiagnoseWorkspace(KoineFile.ToSources(files));
        return ValidationResult.From(diagnostics);
    }
}
