using System.Runtime.InteropServices.JavaScript;
using System.Text.Json;
using System.Text.Json.Serialization;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.TypeScript;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

// Both Ast and Services declare a SymbolKind; the document-outline kind is the Services one.
using SymbolKind = Koine.Compiler.Services.SymbolKind;

namespace Koine.Wasm;

/// <summary>
/// The browser language-service surface of the Koine compiler — the in-browser counterpart of
/// the stdio LSP server (<c>src/Koine.Cli/LspServer.cs</c>). Each method is stateless: the caller
/// (Koine Studio's browser backend) passes the full open-document snapshot as JSON on every call,
/// and the method returns a JSON payload shaped exactly like the corresponding LSP response so the
/// TypeScript client (<c>tooling/koine-studio/src/lsp.ts</c>) can consume it unchanged.
///
/// <para>This mirrors a subset of <see cref="Koine.Cli"/>'s <c>LspServer</c> handlers — the nine
/// requests Koine Studio actually uses — reusing the same <see cref="KoineCompiler"/>,
/// <see cref="KoineLanguageService"/>, <see cref="KoineFormatter"/>, emitters and
/// <see cref="CompatibilityChecker"/>. The LSP <c>koine.config</c>-driven per-target options are
/// not applied here (no filesystem in the browser), matching the docs-site Playground.</para>
///
/// <para>All DTOs are source-generated (trim-safe under <c>TrimMode=full</c>) and camelCased to
/// match the protocol shapes declared in <c>lsp.ts</c>.</para>
/// </summary>
public static partial class CompilerInterop
{
    private static readonly KoineLanguageService LanguageService = new();

    /// <summary>
    /// Diagnoses the merged workspace (every open <c>.koi</c> parsed together, as the build does)
    /// and returns diagnostics bucketed per file, so the caller can publish one
    /// <c>textDocument/publishDiagnostics</c> per document. Files with no diagnostic get an empty
    /// array (clearing stale squiggles). Input is <c>[{uri, text}]</c>.
    /// </summary>
    [JSExport]
    public static string DiagnoseWorkspace(string filesJson)
    {
        try
        {
            var files = DeserializeFiles(filesJson);
            var byUri = files.ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var sources = files.Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var diags = Compiler.DiagnoseWorkspace(sources);

            var buckets = files.ToDictionary(f => f.Uri, _ => new List<WDiagnostic>(), StringComparer.Ordinal);
            foreach (var d in diags)
            {
                if (d.File is { } file && buckets.TryGetValue(file, out var list))
                {
                    list.Add(ToLspDiagnostic(d, byUri.TryGetValue(file, out var t) ? SplitLines(t) : []));
                }
            }

            var result = files
                .Select(f => new WFileDiagnostics(f.Uri, buckets[f.Uri].ToArray()))
                .ToArray();
            return JsonSerializer.Serialize(result, LangJson.Default.WFileDiagnosticsArray);
        }
        catch (Exception ex)
        {
            // Surface the crash on the first file so the editor shows something rather than going silent.
            var files = TryDeserializeFiles(filesJson);
            var uri = files.FirstOrDefault()?.Uri ?? "file:///model.koi";
            var crash = new[] { new WFileDiagnostics(uri, [CrashLspDiagnostic(ex)]) };
            return JsonSerializer.Serialize(crash, LangJson.Default.WFileDiagnosticsArray);
        }
    }

    /// <summary>
    /// Previews the emitter output for the merged workspace through the shared compile pipeline, so
    /// the returned files match <c>koine build</c> (modulo <c>koine.config</c> options). Only
    /// <c>csharp</c>/<c>typescript</c> are valid; any other target yields a structured error result
    /// rather than a throw. Returns <c>{ target, files, diagnostics, error }</c>.
    /// </summary>
    [JSExport]
    public static string EmitPreview(string filesJson, string target)
    {
        target = string.IsNullOrWhiteSpace(target) ? "csharp" : target;
        try
        {
            if (!string.Equals(target, "csharp", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(target, "typescript", StringComparison.OrdinalIgnoreCase))
            {
                return SerializeEmit(new WEmitPreviewResult(
                    target, [], [], $"unknown target '{target}'; expected 'csharp' or 'typescript'"));
            }

            var files = DeserializeFiles(filesJson);
            var byUri = files.ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var sources = files.Select(f => new SourceFile(f.Uri, f.Text)).ToList();

            Koine.Compiler.Emit.IEmitter emitter =
                string.Equals(target, "typescript", StringComparison.OrdinalIgnoreCase)
                    ? new TypeScriptEmitter()
                    : new CSharpEmitter();

            var result = Compiler.Compile(sources, emitter);
            var emittedFiles = result.Files
                .Select(f => new WEmitFile(f.RelativePath, f.Contents))
                .ToArray();
            var diagnostics = result.Diagnostics
                .Select(d => ToLspDiagnostic(
                    d, d.File is { } file && byUri.TryGetValue(file, out var t) ? SplitLines(t) : []))
                .ToArray();

            return SerializeEmit(new WEmitPreviewResult(emitter.TargetName, emittedFiles, diagnostics, null));
        }
        catch (Exception ex)
        {
            return SerializeEmit(new WEmitPreviewResult(
                target, [], [CrashLspDiagnostic(ex)], "internal compiler error: " + ex.Message));
        }
    }

    /// <summary>
    /// Emits the ubiquitous-language glossary (markdown) for the whole merged workspace. A model that
    /// fails to parse degrades to an empty string rather than throwing.
    /// </summary>
    [JSExport]
    public static string Glossary(string filesJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, _) = Compiler.Parse(sources);
            var markdown = model is null ? "" : new GlossaryEmitter().Emit(model)[0].Contents;
            return JsonSerializer.Serialize(new WGlossaryResult(markdown), LangJson.Default.WGlossaryResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WGlossaryResult(""), LangJson.Default.WGlossaryResult);
        }
    }

    /// <summary>
    /// Projects the strategic context map of the merged workspace: context names plus each relation
    /// (upstream/downstream/kind/bidirectional/sharedTypes/acl). A null model yields the empty DTO.
    /// </summary>
    [JSExport]
    public static string ContextMap(string filesJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, _) = Compiler.Parse(sources);
            if (model is null)
            {
                return SerializeContextMap(new WContextMapResult([], []));
            }

            var contexts = model.Contexts.Select(c => c.Name).ToArray();
            var relations = model.ContextMap is null
                ? []
                : model.ContextMap.Relations.Select(MapRelation).ToArray();
            return SerializeContextMap(new WContextMapResult(contexts, relations));
        }
        catch
        {
            return SerializeContextMap(new WContextMapResult([], []));
        }
    }

    /// <summary>
    /// Hover at a 0-based position in <paramref name="activeUri"/>, resolved against the whole
    /// workspace. Returns an LSP <c>Hover</c> (<c>{ contents: { kind, value } }</c>) or the JSON
    /// literal <c>null</c> when there is nothing to show.
    /// </summary>
    [JSExport]
    public static string Hover(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var hover = LanguageService.HoverAt(docs, activeUri, line, character);
            var dto = hover is null ? null : new WHoverResult(new WMarkupContent("markdown", hover.Markdown));
            return JsonSerializer.Serialize(dto, LangJson.Default.WHoverResult);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>
    /// Go-to-definition at a 0-based position in <paramref name="activeUri"/>. Returns an LSP
    /// <c>Location</c> (<c>{ uri, range }</c>) — possibly in another file — or the JSON literal
    /// <c>null</c>.
    /// </summary>
    [JSExport]
    public static string Definition(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var def = LanguageService.DefinitionAt(docs, activeUri, line, character);
            var dto = def is null ? null : new WLocation(def.Uri, SpanRange(def.Target));
            return JsonSerializer.Serialize(dto, LangJson.Default.WLocation);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>Document outline (a single-file <c>DocumentSymbol</c> tree) for <paramref name="source"/>.</summary>
    [JSExport]
    public static string DocumentSymbols(string source)
    {
        try
        {
            var symbols = LanguageService.DocumentSymbols(source).Select(ToLspSymbol).ToArray();
            return JsonSerializer.Serialize(symbols, LangJson.Default.WDocumentSymbolArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Canonical formatting edits for <paramref name="source"/>. Returns a single full-document
    /// <c>TextEdit</c> when formatting changes anything, or an empty array when it is already canonical.
    /// </summary>
    [JSExport]
    public static string Format(string source)
    {
        try
        {
            var result = new KoineFormatter().Format(source);
            if (!result.Changed)
            {
                return "[]";
            }

            var lines = SplitLines(source);
            var lastLine = lines.Length - 1;
            var lastChar = lines.Length == 0 ? 0 : lines[lastLine].Length;
            var edit = new WTextEdit(
                new WRange(new WPosition(0, 0), new WPosition(lastLine, lastChar)),
                result.Text);
            return JsonSerializer.Serialize(new[] { edit }, LangJson.Default.WTextEditArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Model-versioning compatibility of the current merged workspace against a baseline workspace.
    /// Both are passed as <c>[{uri, text}]</c> (the browser has no filesystem, so the baseline files
    /// are read by the caller and passed in). Every failure mode returns a normal result carrying an
    /// <c>error</c> string rather than throwing.
    /// </summary>
    [JSExport]
    public static string Check(string currentFilesJson, string baselineFilesJson)
    {
        try
        {
            var baselineSources = DeserializeFiles(baselineFilesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            if (baselineSources.Count == 0)
            {
                return SerializeCheck(new WCheckResult("no .koi files found in the baseline folder", false, []));
            }

            var (baselineModel, baselineDiags) = Compiler.Parse(baselineSources);
            if (baselineModel is null)
            {
                return SerializeCheck(new WCheckResult(
                    "baseline failed to parse: " + string.Join("; ", baselineDiags.Select(d => d.Message)), false, []));
            }

            var currentSources = DeserializeFiles(currentFilesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (currentModel, currentDiags) = Compiler.Parse(currentSources);
            if (currentModel is null)
            {
                return SerializeCheck(new WCheckResult(
                    "current model failed to parse: " + string.Join("; ", currentDiags.Select(d => d.Message)), false, []));
            }

            var report = new CompatibilityChecker().Check(baselineModel, currentModel);
            var changes = report.Changes
                .Select(c => new WCheckChange(c.Impact.ToString(), c.Code, c.Message))
                .ToArray();
            return SerializeCheck(new WCheckResult(null, report.HasBreakingChanges, changes));
        }
        catch (Exception ex)
        {
            return SerializeCheck(new WCheckResult("compatibility check failed: " + ex.Message, false, []));
        }
    }

    // ---- mapping helpers (mirror LspServer.cs) --------------------------------

    private static IReadOnlyList<WSourceFileDto> DeserializeFiles(string filesJson) =>
        JsonSerializer.Deserialize(filesJson, LangJson.Default.WSourceFileDtoArray) ?? [];

    private static IReadOnlyList<WSourceFileDto> TryDeserializeFiles(string filesJson)
    {
        try
        { return DeserializeFiles(filesJson); }
        catch { return []; }
    }

    private static string SerializeEmit(WEmitPreviewResult r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WEmitPreviewResult);

    private static string SerializeContextMap(WContextMapResult r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WContextMapResult);

    private static string SerializeCheck(WCheckResult r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WCheckResult);

    private static WContextRelation MapRelation(ContextRelation r) => new(
        r.Upstream,
        r.Downstream,
        r.Kind.ToString(),
        r.IsBidirectional,
        r.SharedTypes.ToArray(),
        r.AclMappings.Select(a => new WAclMapping(a.UpstreamContext, a.UpstreamType, a.LocalContext, a.LocalType)).ToArray());

    private static WDocumentSymbol ToLspSymbol(DocumentSymbol s)
    {
        var selection = s.SelectionRange.IsNone ? s.Range : s.SelectionRange;
        return new WDocumentSymbol(
            s.Name,
            LspSymbolKind(s.Kind),
            SpanRange(s.Range),
            SpanRange(selection),
            s.Children.Select(ToLspSymbol).ToArray());
    }

    private static int LspSymbolKind(SymbolKind kind) => kind switch
    {
        SymbolKind.Namespace => 3,
        SymbolKind.Class => 5,
        SymbolKind.Enum => 10,
        SymbolKind.EnumMember => 22,
        SymbolKind.Field => 8,
        SymbolKind.Method => 6,
        SymbolKind.Constructor => 9,
        SymbolKind.Interface => 11,
        SymbolKind.Struct => 23,
        _ => 13, // Variable
    };

    /// <summary>Converts a 1-based, end-EXCLUSIVE <see cref="SourceSpan"/> to a 0-based LSP range.</summary>
    private static WRange SpanRange(SourceSpan span) => new(
        new WPosition(Math.Max(0, span.Line - 1), Math.Max(0, span.Column - 1)),
        new WPosition(Math.Max(0, span.EndLine - 1), Math.Max(0, span.EndColumn - 1)));

    private static WDiagnostic ToLspDiagnostic(Diagnostic d, string[] lines)
    {
        var (startLine, startChar, endLine, endChar) = ToRange(d, lines);
        return new WDiagnostic(
            new WRange(new WPosition(startLine, startChar), new WPosition(endLine, endChar)),
            d.Severity == DiagnosticSeverity.Error ? 1 : 2, // 1=Error, 2=Warning
            d.Code,
            d.Message);
    }

    private static WDiagnostic CrashLspDiagnostic(Exception ex) => new(
        new WRange(new WPosition(0, 0), new WPosition(0, 1)),
        1,
        "KOIWASM",
        "internal compiler error: " + ex.Message);

    /// <summary>
    /// Maps a 1-based Koine <see cref="Diagnostic"/> to a 0-based LSP range. When the diagnostic
    /// carries a known end (built from a node's full span) the exact range is used; otherwise a
    /// forward scan underlines the identifier token at the start position. Ported from LspServer.
    /// </summary>
    private static (int StartLine, int StartChar, int EndLine, int EndChar) ToRange(Diagnostic d, string[] lines)
    {
        var line = Math.Max(0, d.Line - 1);
        var col = Math.Max(0, d.Column - 1);

        if (d.HasEnd)
        {
            return (line, col, Math.Max(0, d.EndLine - 1), Math.Max(0, d.EndColumn - 1));
        }

        var scanEndCol = col + 1;
        if (line < lines.Length)
        {
            var text = lines[line];
            var e = col;
            while (e < text.Length && (char.IsLetterOrDigit(text[e]) || text[e] == '_'))
            {
                e++;
            }

            scanEndCol = e > col ? e : Math.Min(col + 1, Math.Max(text.Length, col + 1));
        }

        return (line, col, line, scanEndCol);
    }

    private static string[] SplitLines(string text) =>
        text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
}

// ---- DTOs (camelCase JSON; shapes mirror tooling/koine-studio/src/lsp.ts) -----

/// <summary>0-based LSP position.</summary>
public sealed record WPosition(int Line, int Character);

/// <summary>0-based LSP range (end-exclusive).</summary>
public sealed record WRange(WPosition Start, WPosition End);

/// <summary>LSP diagnostic (severity 1=error, 2=warning).</summary>
public sealed record WDiagnostic(WRange Range, int Severity, string? Code, string Message);

/// <summary>Per-file diagnostics, ready to publish as <c>textDocument/publishDiagnostics</c>.</summary>
public sealed record WFileDiagnostics(string Uri, WDiagnostic[] Diagnostics);

/// <summary>One emitted source file.</summary>
public sealed record WEmitFile(string Path, string Contents);

/// <summary>Emit-preview result for the merged workspace.</summary>
public sealed record WEmitPreviewResult(string Target, WEmitFile[] Files, WDiagnostic[] Diagnostics, string? Error);

/// <summary>Ubiquitous-language glossary as markdown.</summary>
public sealed record WGlossaryResult(string Markdown);

/// <summary>An anti-corruption-layer mapping in the context map.</summary>
public sealed record WAclMapping(string UpstreamContext, string UpstreamType, string LocalContext, string LocalType);

/// <summary>One context-map relation.</summary>
public sealed record WContextRelation(
    string Upstream, string Downstream, string Kind, bool Bidirectional, string[] SharedTypes, WAclMapping[] Acl);

/// <summary>Strategic context map: contexts + relations.</summary>
public sealed record WContextMapResult(string[] Contexts, WContextRelation[] Relations);

/// <summary>LSP MarkupContent.</summary>
public sealed record WMarkupContent(string Kind, string Value);

/// <summary>LSP Hover.</summary>
public sealed record WHoverResult(WMarkupContent Contents);

/// <summary>LSP Location.</summary>
public sealed record WLocation(string Uri, WRange Range);

/// <summary>LSP DocumentSymbol (recursive).</summary>
public sealed record WDocumentSymbol(string Name, int Kind, WRange Range, WRange SelectionRange, WDocumentSymbol[] Children);

/// <summary>LSP TextEdit.</summary>
public sealed record WTextEdit(WRange Range, string NewText);

/// <summary>One model-versioning compatibility change.</summary>
public sealed record WCheckChange(string Impact, string Code, string Message);

/// <summary>Model-versioning compatibility result.</summary>
public sealed record WCheckResult(string? Error, bool HasBreakingChanges, WCheckChange[] Changes);

/// <summary>Input shape: one open document (uri + full text).</summary>
public sealed record WSourceFileDto(string Uri, string Text);

/// <summary>Source-generated (trim-safe) serialization context for the language-service DTOs.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WSourceFileDto[]))]
[JsonSerializable(typeof(WFileDiagnostics[]))]
[JsonSerializable(typeof(WEmitPreviewResult))]
[JsonSerializable(typeof(WGlossaryResult))]
[JsonSerializable(typeof(WContextMapResult))]
[JsonSerializable(typeof(WHoverResult))]
[JsonSerializable(typeof(WLocation))]
[JsonSerializable(typeof(WDocumentSymbol[]))]
[JsonSerializable(typeof(WTextEdit[]))]
[JsonSerializable(typeof(WCheckResult))]
internal sealed partial class LangJson : JsonSerializerContext;
