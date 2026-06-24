using System.ComponentModel;
using Koine.Compiler.Services;
using ModelContextProtocol.Server;

namespace Koine.Mcp.Tools;

/// <summary>The <c>koine_compile</c> tool: full pipeline through a chosen emitter.</summary>
[McpServerToolType]
public static class CompileTool
{
    [McpServerTool(Name = "koine_compile")]
    [Description("""
        Compile Koine (.koi) source and return the generated output files. `target` is one of:
        csharp (default), typescript, python, php, rust, glossary, docs, or openapi. Multi-file models compile together.
        If the model has semantic errors, no files are produced and `diagnostics` explains why — fix
        them (koine_validate shows the same diagnostics) and retry. Returns { success, errorCount,
        warningCount, diagnostics[], files[] } where each file has a relative path and its contents.
        """)]
    public static CompilationResult Compile(
        [Description("The .koi files to compile. Provide a single entry for a one-file model.")]
        KoineFile[] files,
        [Description("Output target: csharp (default), typescript, python, php, rust, glossary, docs, or openapi.")]
        string target = "csharp")
    {
        if (!ToolGuards.TryValidateFiles(files, out var guardErrors))
        {
            return CompilationResult.Failed(guardErrors);
        }

        if (!EmitterFactory.TryCreate(target, out var emitter, out var error))
        {
            return CompilationResult.Failed(error!);
        }

        var result = new KoineCompiler().Compile(KoineFile.ToSources(files), emitter);
        return CompilationResult.From(result);
    }
}
