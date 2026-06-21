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
        if (!ToolGuards.TryValidateSource(source, out var sizeErr))
        {
            // We only reach here when the guard rejected the input — which includes the null-source
            // case (the argument is deserialized from an MCP tool call, so a JSON `null` can arrive
            // despite the non-null annotation). `IsNullOrEmpty` absorbs that runtime null.
            return new FormattingResult(string.IsNullOrEmpty(source) ? string.Empty : source, Changed: false, new[] { sizeErr! });
        }

        // The formatter only LEXES the source (it strips lexer error listeners and re-emits tokens);
        // it does not parse, and so cannot surface syntax diagnostics itself. We therefore parse here
        // purely as a gate: if the source has syntax errors we return them and leave the text untouched
        // rather than formatting partially-valid input. Parsing is error-tolerant and returns a partial
        // model even for broken input, so a null check alone no longer detects a syntax error — gate on
        // diagnostic severity instead. (The later Format() call lexes the source independently.)
        var (model, diagnostics) = new KoineCompiler().Parse(source);
        if (model is null || diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
        {
            return new FormattingResult(source, Changed: false, DiagnosticInfo.From(diagnostics));
        }

        var result = new KoineFormatter().Format(source);
        return new FormattingResult(result.Text, result.Changed, Array.Empty<DiagnosticInfo>());
    }
}
