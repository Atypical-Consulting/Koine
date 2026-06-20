using System.ComponentModel;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;
using ModelContextProtocol.Server;

namespace Koine.Mcp.Tools;

/// <summary>The <c>koine_format</c> tool: canonical whitespace formatting of one source.</summary>
[McpServerToolType]
public static class FormatTool
{
    [McpServerTool(Name = "koine_format")]
    [Description("""
        Canonically format a single Koine (.koi) source string: 2-space indentation, aligned field
        types, K&R braces, normalized spacing. Returns { text, changed, diagnostics[] }. Formatting
        only adjusts whitespace — it never rewrites code or fixes syntax. If the source does not parse,
        `changed` is false, `text` is the original input, and the syntax `diagnostics` are returned so
        you can fix them first.
        """)]
    public static FormattingResult Format(
        [Description("The .koi source text to format.")]
        string source)
    {
        // The formatter cannot fix syntax; surface parse errors instead of silently echoing the input.
        // Parsing is error-tolerant and returns a partial model even for broken input, so a null
        // check alone no longer detects a syntax error — gate on diagnostic severity instead.
        var (model, diagnostics) = new KoineCompiler().Parse(source);
        if (model is null || diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new FormattingResult(source, Changed: false, DiagnosticInfo.From(diagnostics));
        }

        var result = new KoineFormatter().Format(source);
        return new FormattingResult(result.Text, result.Changed, Array.Empty<DiagnosticInfo>());
    }
}
