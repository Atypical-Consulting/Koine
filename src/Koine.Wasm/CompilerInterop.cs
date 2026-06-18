using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Python;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Services;

namespace Koine.Wasm;

/// <summary>
/// The JS-callable surface of the Koine compiler. Both methods take .koi source text and
/// return a JSON string, so the JavaScript boundary stays trivial (string in / string out).
/// Exposed to the Playground via <c>getAssemblyExports(...).Koine.Wasm.CompilerInterop.*</c>.
/// </summary>
/// <remarks>
/// This whole assembly only ever runs in the browser-wasm runtime (see the project header in
/// <c>Koine.Wasm.csproj</c>), so the type is marked browser-only — that matches the platform of
/// <see cref="JSExportAttribute"/> and keeps the <c>[JSExport]</c> methods CA1416-clean.
/// </remarks>
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
    private static readonly KoineCompiler Compiler = new();

    /// <summary>
    /// Parses + validates <paramref name="source"/> and returns the diagnostics as a JSON array
    /// (<c>[{severity, code, message, line, col, endLine, endCol}]</c>) for live editor squiggles.
    /// </summary>
    [JSExport]
    public static string Diagnose(string source)
    {
        try
        {
            var diagnostics = Compiler.Diagnose(source, "playground.koi");
            return JsonSerializer.Serialize(diagnostics.Select(ToDto).ToArray(), InteropJson.Default.DiagnosticDtoArray);
        }
        catch (Exception ex)
        {
            return JsonSerializer.Serialize(new[] { CrashDiagnostic(ex) }, InteropJson.Default.DiagnosticDtoArray);
        }
    }

    /// <summary>
    /// Compiles <paramref name="source"/> with the emitter named by <paramref name="target"/>
    /// (<c>csharp</c> | <c>typescript</c> | <c>python</c> | <c>glossary</c>) and returns
    /// <c>{ ok, target, diagnostics, files:[{path, contents}] }</c> as JSON.
    /// </summary>
    [JSExport]
    public static string Compile(string source, string target)
    {
        try
        {
            IEmitter emitter = (target ?? "csharp").ToLowerInvariant() switch
            {
                "typescript" or "ts" => new TypeScriptEmitter(),
                "python" or "py" => new PythonEmitter(),
                "glossary" or "md" => new GlossaryEmitter(),
                _ => new CSharpEmitter(),
            };

            var result = Compiler.Compile(source, emitter);
            var dto = new CompileResultDto(
                Ok: result.Success,
                Target: emitter.TargetName,
                Diagnostics: result.Diagnostics.Select(ToDto).ToArray(),
                Files: result.Files.Select(f => new EmittedFileDto(f.RelativePath, f.Contents)).ToArray());

            return JsonSerializer.Serialize(dto, InteropJson.Default.CompileResultDto);
        }
        catch (Exception ex)
        {
            var dto = new CompileResultDto(
                Ok: false,
                Target: target ?? "csharp",
                Diagnostics: [CrashDiagnostic(ex)],
                Files: []);
            return JsonSerializer.Serialize(dto, InteropJson.Default.CompileResultDto);
        }
    }

    private static DiagnosticDto ToDto(Diagnostic d) => new(
        Severity: d.Severity == DiagnosticSeverity.Error ? "error" : "warning",
        Code: d.Code,
        Message: d.Message,
        Line: d.Line,
        Col: d.Column,
        EndLine: d.HasEnd ? d.EndLine : d.Line,
        EndCol: d.HasEnd ? d.EndColumn : d.Column + 1);

    private static DiagnosticDto CrashDiagnostic(Exception ex) => new(
        Severity: "error",
        Code: "KOIWASM",
        Message: "internal compiler error: " + ex.Message,
        Line: 1, Col: 1, EndLine: 1, EndCol: 2);
}

/// <summary>JSON shape for a single diagnostic (1-based positions; end is exclusive).</summary>
public sealed record DiagnosticDto(
    string Severity, string Code, string Message,
    int Line, int Col, int EndLine, int EndCol);

/// <summary>JSON shape for one emitted source file.</summary>
public sealed record EmittedFileDto(string Path, string Contents);

/// <summary>JSON shape for a full compile.</summary>
public sealed record CompileResultDto(
    bool Ok, string Target, DiagnosticDto[] Diagnostics, EmittedFileDto[] Files);

/// <summary>Source-generated (trim-safe) serialization context for the interop DTOs.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(DiagnosticDto[]))]
[JsonSerializable(typeof(CompileResultDto))]
internal sealed partial class InteropJson : JsonSerializerContext;
