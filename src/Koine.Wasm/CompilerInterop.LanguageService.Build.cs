using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Grammar;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Wasm;

// Build & whole-workspace analysis surface of the in-browser language service: workspace
// diagnostics, emit preview, the emit-target capability list, the GBNF grammar, semantic-token
// classification, and model-versioning compatibility. See CompilerInterop.LanguageService.cs.
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
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
            var diags = Compiler.DiagnoseWorkspace(GetWarmCompilation(files));

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
    /// <c>csharp</c>/<c>typescript</c>/<c>python</c>/<c>php</c> are valid; any other target yields a
    /// structured error result rather than a throw. Returns <c>{ target, files, diagnostics, error }</c>.
    /// </summary>
    [JSExport]
    public static string EmitPreview(string filesJson, string target)
    {
        target = string.IsNullOrWhiteSpace(target) ? "csharp" : target;
        try
        {
            // Gate AND create through the registry's code-emit targets (issue #282) — the SAME list
            // ListEmitTargets / koine/emitTargets serves, so a target the picker offers previews here
            // too, and a new registry target emits its own code instead of silently falling back to C#.
            // SupportedTargetInfos excludes glossary/docs (they have dedicated exports). No koine.config
            // options in the browser, so EmitterOptions.Empty → byte-identical to a parameterless emitter.
            // Reuse the shared Registry (see CompilerInterop.cs) — Compile resolves through the same one.
            if (!Registry.SupportedTargetInfos.Any(i => string.Equals(i.Id, target, StringComparison.OrdinalIgnoreCase))
                || !Registry.TryCreate(target, EmitterOptions.Empty, out var emitter))
            {
                var expected = string.Join(", ", Registry.SupportedTargetInfos.Select(i => $"'{i.Id}'"));
                return SerializeEmit(new WEmitPreviewResult(
                    target, [], [], $"unknown target '{target}'; expected one of {expected}"));
            }

            var files = DeserializeFiles(filesJson);
            var byUri = files.ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);

            // Warm path (issue #464): reuse the reconciled snapshot so unchanged files keep their
            // already-parsed units by reference — only the edited file re-parses. Byte-identical
            // output to the cold Compile(sources, emitter) path (same content-addressed key).
            var result = Compiler.Compile(GetWarmCompilation(files), emitter);
            var emittedFiles = result.Files
                .Select(f => new WEmitFile(f.RelativePath, f.Contents, f.Kind))
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
    /// The emit-target capability query (issue #282): the compiler registry's code-emit targets, each
    /// carrying <c>{ id, displayName, fileExtension }</c>, in display order — the browser counterpart of
    /// the stdio LSP's <c>koine/emitTargets</c>. Backed by <see cref="EmitterRegistry.SupportedTargetInfos"/>,
    /// so a registry target surfaces in Koine Studio with no front-end edit; the non-emit
    /// <c>glossary</c>/<c>docs</c> generators are excluded. Takes no input. Returns <c>{ targets: [...] }</c>.
    /// </summary>
    [JSExport]
    public static string ListEmitTargets() =>
        JsonSerializer.Serialize(new WEmitTargetsResult(SupportedEmitTargets()), LangJson.Default.WEmitTargetsResult);

    /// <summary>
    /// The registry's code-emit targets mapped to the wire <see cref="WEmitTarget"/> shape, in display
    /// order. The single mapping shared by <see cref="ListEmitTargets"/> (#282) and
    /// <see cref="Capabilities"/> (#330) so the two can never report a different target list.
    /// </summary>
    private static WEmitTarget[] SupportedEmitTargets() =>
        Registry.SupportedTargetInfos
            .Select(i => new WEmitTarget(i.Id, i.DisplayName, i.FileExtension))
            .ToArray();

    /// <summary>
    /// The llama.cpp GBNF grammar derived from Koine's ANTLR grammar (issue #257) — the grammar string a
    /// constrained decoder is fed so it can only emit syntactically valid <c>.koi</c>. The browser counterpart
    /// of the CLI surface; a one-line delegation to <see cref="GbnfExporter.Export"/> (the deterministic,
    /// target-agnostic source of truth). Takes no input. Returns the grammar text verbatim.
    /// </summary>
    [JSExport]
    public static string GbnfGrammar() => GbnfExporter.Export();

    /// <summary>
    /// Full-document LSP semantic tokens for a single <c>.koi</c> <paramref name="source"/> — the
    /// in-browser counterpart of the stdio LSP's <c>textDocument/semanticTokens/full</c>
    /// (<c>LspServer.SemanticTokensResultJson</c>). Returns <c>{ data, resultId }</c> where <c>data</c>
    /// is the LSP delta-encoded int stream from <see cref="SemanticTokenProvider.Encode"/> over
    /// <see cref="SemanticTokenProvider.Tokenize"/>; the two backends emit the <b>same</b> stream
    /// (asserted in <c>SemanticTokensWireParityTests</c>). <c>resultId</c> is reserved (always null) for
    /// a later additive delta pass. A non-parsing source degrades to empty <c>data</c> — the editor
    /// keeps its regex highlighting rather than showing wrong colors.
    /// </summary>
    [JSExport]
    public static string SemanticTokens(string source)
    {
        try
        {
            var data = SemanticTokenProvider.Encode(SemanticProvider.Tokenize(source)).ToArray();
            return JsonSerializer.Serialize(new WSemanticTokens(data), LangJson.Default.WSemanticTokens);
        }
        catch
        {
            return JsonSerializer.Serialize(new WSemanticTokens([]), LangJson.Default.WSemanticTokens);
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

    private static string SerializeEmit(WEmitPreviewResult r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WEmitPreviewResult);

    private static string SerializeCheck(WCheckResult r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WCheckResult);

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
            while (e < text.Length && SourceTextGeometry.IsIdentifierChar(text[e]))
            {
                e++;
            }

            scanEndCol = e > col ? e : Math.Min(col + 1, Math.Max(text.Length, col + 1));
        }

        return (line, col, line, scanEndCol);
    }

}
