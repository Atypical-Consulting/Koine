using System.Reflection;
using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Koine.Compiler;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
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
    /// The built-in emitter registry (<c>BuiltInEmitterProviders.All</c>) — the single source of truth
    /// for target → emitter resolution, shared by <see cref="Compile"/>, <see cref="EmitPreview"/> and
    /// <see cref="SupportedEmitTargets"/>. Built once and held statically (it is immutable after
    /// construction and the providers are stateless) rather than rebuilt per call, since
    /// <see cref="Compile"/>/<see cref="EmitPreview"/> run on every playground keystroke.
    /// </summary>
    private static readonly EmitterRegistry Registry = new(BuiltInEmitterProviders.All);

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
    /// Compiles <paramref name="source"/> with the emitter named by <paramref name="target"/> — any
    /// target the shared <see cref="Registry"/> resolves (<c>BuiltInEmitterProviders.All</c>, the same
    /// list <see cref="EmitPreview"/> / <see cref="ListEmitTargets"/> use), case-insensitively. An
    /// unknown/empty/null target falls back to C#. Returns
    /// <c>{ ok, target, diagnostics, files:[{path, contents}] }</c> as JSON.
    /// </summary>
    [JSExport]
    public static string Compile(string source, string target)
    {
        try
        {
            // Resolve the emitter from the SAME EmitterRegistry that EmitPreview / ListEmitTargets use
            // (issues #282, #301), so target → emitter has ONE source of truth — the registry's
            // BuiltInEmitterProviders.All. Every registered target (code emitter AND the doc/spec
            // generators glossary/docs/asyncapi/openapi, which TryCreate resolves too) is reachable,
            // so a newly-registered target can never silently fall back to C# the way the old
            // hand-maintained switch could. The switch's short aliases (ts/py/rs/md) are intentionally
            // dropped: the registry is canonical-id only, matching EmitPreview, and no caller passes
            // them. `target` is non-null per the annotation, but it is marshalled across the JS-interop
            // boundary where a JS `null`/`undefined` can still arrive, so an empty/unknown target
            // normalizes to the CSharpEmitter fallback (today's `default` behavior). No `koine.config`
            // in the browser ⇒ EmitterOptions.Empty is byte-identical to a parameterless emitter —
            // matching EmitPreview.
            var normalizedTarget = string.IsNullOrEmpty(target) ? "csharp" : target;
            IEmitter emitter = Registry.TryCreate(normalizedTarget, EmitterOptions.Empty, out var resolved)
                ? resolved
                : new CSharpEmitter();

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
            // Same as above: `target` can be a marshalled-in JS null at runtime.
            var dto = new CompileResultDto(
                Ok: false,
                Target: string.IsNullOrEmpty(target) ? "csharp" : target,
                Diagnostics: [CrashDiagnostic(ex)],
                Files: []);
            return JsonSerializer.Serialize(dto, InteropJson.Default.CompileResultDto);
        }
    }

    /// <summary>
    /// The module's self-description (issue #330): its <c>version</c>, the <c>exports</c> names of every
    /// <c>[JSExport]</c> it ships, and the <c>targets</c> it can emit — one call that answers "what is this
    /// bundle?". Returns <c>{ version, exports:[string], targets:[{id, displayName, fileExtension}] }</c> as
    /// JSON. The single source of truth Koine Studio verifies its surface against at boot (so the browser
    /// host drops its hand-maintained export list) and the docs-site reads its version line from.
    /// </summary>
    [JSExport]
    public static string Capabilities()
    {
        // targets: the SAME mapping ListEmitTargets (#282) serves — shared via SupportedEmitTargets() so
        // there is no second target list.
        var dto = new WCapabilities(CompilerVersion(), JsExportNames, SupportedEmitTargets());
        return JsonSerializer.Serialize(dto, LangJson.Default.WCapabilities);
    }

    /// <summary>
    /// The compiler version from <see cref="AssemblyInformationalVersionAttribute"/> (set from
    /// <c>Directory.Build.props</c>'s <c>&lt;Version&gt;</c>), trimming any SDK-appended
    /// <c>+&lt;commit&gt;</c> build-metadata suffix. Delegates to the shared
    /// <see cref="VersionInfo.Display"/> — the same logic as <c>Koine.Cli.Program.GetVersion()</c>,
    /// so the wasm bundle and <c>koine --version</c> stay in lock-step. Falls back to the four-part
    /// assembly version (then <c>0.0.0</c>) only if the attribute is absent.
    /// </summary>
    private static string CompilerVersion()
        => VersionInfo.Display(typeof(CompilerInterop).Assembly);

    /// <summary>
    /// The names of every <c>[JSExport]</c> this module ships — the staleness signal Koine Studio builds
    /// its boot-time guard set from (issue #330), letting the browser host drop its hand-maintained copy.
    /// Curated rather than reflected on purpose: under <c>TrimMode=full</c>, reflecting <c>[JSExport]</c>
    /// attributes off the trimmed wasm assembly is fragile — so this is the ONE authoritative list, built
    /// with <c>nameof</c> so a rename can't leave a dangling string, and <c>CapabilitiesTests</c> reflects
    /// the real (un-trimmed) surface to assert it never drifts. Must include <c>Capabilities</c> itself.
    /// </summary>
    private static readonly string[] JsExportNames =
    [
        nameof(Diagnose), nameof(Compile), nameof(Capabilities),
        nameof(DiagnoseWorkspace), nameof(EmitPreview), nameof(ListEmitTargets), nameof(GbnfGrammar), nameof(SemanticTokens),
        nameof(Glossary), nameof(ContextMap), nameof(GlossaryModel), nameof(SetDoc),
        nameof(Model), nameof(ModelMembers), nameof(EmitKoine), nameof(ApplyModelEdit),
        nameof(Hover), nameof(Completions), nameof(SignatureHelp), nameof(Definition),
        nameof(DocumentSymbols), nameof(WorkspaceSymbols), nameof(FoldingRanges), nameof(SelectionRanges),
        nameof(DocumentHighlightsAt), nameof(CodeLenses), nameof(Format), nameof(FormatRange),
        nameof(Check), nameof(References), nameof(InlayHints),
        nameof(PrepareCallHierarchy), nameof(IncomingCalls), nameof(OutgoingCalls),
        nameof(PrepareTypeHierarchy), nameof(Supertypes), nameof(Subtypes),
        nameof(PrepareRename), nameof(Rename), nameof(CodeActions), nameof(Docs),
        nameof(RunScenario), nameof(ScenarioCatalog),
    ];

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
