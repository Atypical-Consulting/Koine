using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit.CSharp;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Php;
using Koine.Compiler.Emit.Python;
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
/// <remarks>Browser-only, like the rest of this assembly — see the partial in
/// <c>CompilerInterop.cs</c> for why <see cref="SupportedOSPlatformAttribute"/> is applied.</remarks>
[SupportedOSPlatform("browser")]
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
    /// <c>csharp</c>/<c>typescript</c>/<c>python</c>/<c>php</c> are valid; any other target yields a
    /// structured error result rather than a throw. Returns <c>{ target, files, diagnostics, error }</c>.
    /// </summary>
    [JSExport]
    public static string EmitPreview(string filesJson, string target)
    {
        target = string.IsNullOrWhiteSpace(target) ? "csharp" : target;
        try
        {
            if (!string.Equals(target, "csharp", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(target, "typescript", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(target, "python", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(target, "php", StringComparison.OrdinalIgnoreCase))
            {
                return SerializeEmit(new WEmitPreviewResult(
                    target, [], [], $"unknown target '{target}'; expected 'csharp', 'typescript', 'python', or 'php'"));
            }

            var files = DeserializeFiles(filesJson);
            var byUri = files.ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var sources = files.Select(f => new SourceFile(f.Uri, f.Text)).ToList();

            Koine.Compiler.Emit.IEmitter emitter =
                string.Equals(target, "typescript", StringComparison.OrdinalIgnoreCase) ? new TypeScriptEmitter()
                : string.Equals(target, "python", StringComparison.OrdinalIgnoreCase) ? new PythonEmitter()
                : string.Equals(target, "php", StringComparison.OrdinalIgnoreCase) ? new PhpEmitter()
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
    /// Projects the structured ubiquitous-language glossary of the merged workspace (#67): one entry
    /// per context/type with kind, owning context, qualified id, doc-comment presence (for coverage)
    /// and the name's range. A null model yields <c>{ entries: [] }</c>.
    /// </summary>
    [JSExport]
    public static string GlossaryModel(string filesJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, _) = Compiler.Parse(sources);
            if (model is null)
            {
                return JsonSerializer.Serialize(new WGlossaryModel([]), LangJson.Default.WGlossaryModel);
            }

            var entries = GlossaryModelBuilder.Build(model).Entries
                .Select(e => new WGlossaryEntry(e.Id, e.Name, e.Kind, e.Context, e.QualifiedName, e.Doc, SpanRange(e.NameSpan)))
                .ToArray();
            return JsonSerializer.Serialize(new WGlossaryModel(entries), LangJson.Default.WGlossaryModel);
        }
        catch
        {
            return JsonSerializer.Serialize(new WGlossaryModel([]), LangJson.Default.WGlossaryModel);
        }
    }

    /// <summary>
    /// Computes the doc-comment edit for the glossary declaration addressed by <paramref name="id"/>,
    /// setting it to <paramref name="text"/> (insert/replace/clear of the <c>///</c> block, #67).
    /// Returns <c>{ uri, edits }</c>; an unknown id or null model yields <c>{ uri: null, edits: [] }</c>.
    /// </summary>
    [JSExport]
    public static string SetDoc(string filesJson, string id, string text)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, _) = Compiler.Parse(sources);
            if (model is null)
            {
                return JsonSerializer.Serialize(new WSetDocResult(null, []), LangJson.Default.WSetDocResult);
            }

            var result = SetDocEditor.Build(model, sources, id, text);
            var edits = result.Edits.Select(e => new WTextEdit(SpanRange(e.Range), e.NewText)).ToArray();
            return JsonSerializer.Serialize(new WSetDocResult(result.Uri, edits), LangJson.Default.WSetDocResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WSetDocResult(null, []), LangJson.Default.WSetDocResult);
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
    /// IntelliSense completions at a 0-based position in <paramref name="activeUri"/>. Single-file
    /// and lexer-only (tolerant of broken documents), mirroring the desktop LSP's
    /// <c>textDocument/completion</c>; returns an LSP-style <c>{ isIncomplete, items[] }</c> list.
    /// </summary>
    [JSExport]
    public static string Completions(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            if (!docs.TryGetValue(activeUri, out var text))
            {
                return SerializeCompletions(new WCompletionList(false, []));
            }

            var items = LanguageService.CompleteAt(text, line, character)
                .Select(i => new WCompletionItem(i.Label, LspCompletionKind(i.Kind), i.Detail, i.Documentation))
                .ToArray();
            return SerializeCompletions(new WCompletionList(false, items));
        }
        catch
        {
            return SerializeCompletions(new WCompletionList(false, []));
        }
    }

    /// <summary>
    /// Signature help at a 0-based position in <paramref name="activeUri"/>. Mirrors the desktop LSP's
    /// <c>textDocument/signatureHelp</c>: returns an LSP <c>SignatureHelp</c>
    /// (<c>{ signatures, activeSignature, activeParameter }</c>) or the JSON literal <c>null</c>.
    /// </summary>
    [JSExport]
    public static string SignatureHelp(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var help = LanguageService.SignatureHelpAt(docs, activeUri, line, character);
            if (help is null)
            {
                return "null";
            }

            var signatures = help.Signatures
                .Select(s => new WSignatureInfo(
                    s.Label,
                    s.Parameters.Select(p => new WParameterInfo(p.Label)).ToArray()))
                .ToArray();
            var dto = new WSignatureHelp(signatures, help.ActiveSignature, help.ActiveParameter);
            return JsonSerializer.Serialize(dto, LangJson.Default.WSignatureHelp);
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

    /// <summary>
    /// Every reference to the name at a 0-based position in <paramref name="activeUri"/>, across the
    /// merged workspace (declaration included). Returns a JSON <c>Location[]</c> — empty when the
    /// cursor is not on a renameable type/enum-member/spec name. Parity with the stdio LSP's
    /// <c>textDocument/references</c>.
    /// </summary>
    [JSExport]
    public static string References(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var refs = LanguageService.ReferencesAt(docs, activeUri, line, character)
                .Select(r => new WLocation(r.Uri, RangeOf(r)))
                .ToArray();
            return JsonSerializer.Serialize(refs, LangJson.Default.WLocationArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// The editable identifier range under the cursor (LSP <c>prepareRename</c>): <c>{ range, placeholder }</c>
    /// or the JSON literal <c>null</c> when a rename is not valid there. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string PrepareRename(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var range = LanguageService.PrepareRenameAt(docs, activeUri, line, character);
            if (range is null)
            {
                return "null";
            }

            var name = LanguageService.NameAt(docs, activeUri, line, character);
            return JsonSerializer.Serialize(new WPrepareRename(RangeOf(range), name), LangJson.Default.WPrepareRename);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>
    /// Workspace edit that renames the name under the cursor to <paramref name="newName"/> across the
    /// merged workspace: <c>{ changes: { uri: TextEdit[] } }</c>, or the JSON literal <c>null</c> when
    /// no rename applies (cursor not on a renameable name, invalid identifier, or unchanged).
    /// </summary>
    [JSExport]
    public static string Rename(string filesJson, string activeUri, int line, int character, string newName)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var refs = LanguageService.RenameAt(docs, activeUri, line, character, newName);
            if (refs is null)
            {
                return "null";
            }

            var changes = refs
                .GroupBy(r => r.Uri, StringComparer.Ordinal)
                .ToDictionary(
                    g => g.Key,
                    g => g.Select(r => new WTextEdit(RangeOf(r), newName)).ToArray(),
                    StringComparer.Ordinal);
            return JsonSerializer.Serialize(new WWorkspaceEdit(changes), LangJson.Default.WWorkspaceEdit);
        }
        catch
        {
            return "null";
        }
    }

    /// <summary>
    /// Code actions for the request: diagnostic-driven "did you mean 'X'?" quickfixes (extracted from
    /// the <paramref name="diagnosticsJson"/> the client holds for the active file) plus selection-driven
    /// refactors over the 0-based range (e.g. Extract value object). Each action carries an inline
    /// workspace edit. Returns a JSON <c>CodeAction[]</c>. Parity with the stdio LSP's <c>textDocument/codeAction</c>.
    /// </summary>
    [JSExport]
    public static string CodeActions(
        string filesJson, string activeUri, int startLine, int startChar, int endLine, int endChar, string diagnosticsJson)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var actions = new List<WCodeAction>();

            // 1. Diagnostic quickfixes: a "… — did you mean 'X'?" message yields a one-edit fix.
            //    Guard each item (a message-less diagnostic deserializes to a null Message); mirror
            //    the stdio LSP's per-item skip so one malformed diagnostic can't abort the whole
            //    handler and suppress the selection-driven refactors below.
            foreach (var d in TryDeserializeInDiagnostics(diagnosticsJson))
            {
                if (string.IsNullOrEmpty(d.Message))
                {
                    continue;
                }

                var suggestion = ExtractSuggestion(d.Message);
                if (suggestion is null)
                {
                    continue;
                }

                var changes = new Dictionary<string, WTextEdit[]>(StringComparer.Ordinal)
                {
                    [activeUri] = [new WTextEdit(d.Range, suggestion)],
                };
                actions.Add(new WCodeAction($"Change to '{suggestion}'", "quickfix", new WWorkspaceEdit(changes)));
            }

            // 2. Selection-driven refactors (Extract value object, …).
            foreach (var refactor in LanguageService.RefactorsAt(docs, activeUri, startLine, startChar, endLine, endChar))
            {
                var edits = refactor.Edits.Select(e => new WTextEdit(SpanRange(e.Range), e.NewText)).ToArray();
                var changes = new Dictionary<string, WTextEdit[]>(StringComparer.Ordinal) { [activeUri] = edits };
                actions.Add(new WCodeAction(refactor.Title, refactor.Kind, new WWorkspaceEdit(changes)));
            }

            return JsonSerializer.Serialize(actions.ToArray(), LangJson.Default.WCodeActionArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Living-documentation files (Mermaid-in-Markdown) for the merged workspace, reusing the same
    /// <see cref="Koine.Compiler.Emit.Docs.DocsEmitter"/> as <c>koine build … --target docs</c>. A model
    /// that fails to parse degrades to <c>{ files: [] }</c> rather than throwing. Returns
    /// <c>{ files: [{ path, contents }] }</c>.
    /// </summary>
    [JSExport]
    public static string Docs(string filesJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, _) = Compiler.Parse(sources);
            if (model is null)
            {
                return JsonSerializer.Serialize(new WDocsResult([]), LangJson.Default.WDocsResult);
            }

            var files = new Koine.Compiler.Emit.Docs.DocsEmitter().Emit(model)
                .Select(f => new WEmitFile(f.RelativePath, f.Contents))
                .ToArray();
            return JsonSerializer.Serialize(new WDocsResult(files), LangJson.Default.WDocsResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WDocsResult([]), LangJson.Default.WDocsResult);
        }
    }

    // ---- mapping helpers (mirror LspServer.cs) --------------------------------

    /// <summary>Deserializes the client's active-file diagnostics (<c>[{range, message}]</c>); empty on any error.</summary>
    private static IReadOnlyList<WInDiagnostic> TryDeserializeInDiagnostics(string diagnosticsJson)
    {
        if (string.IsNullOrWhiteSpace(diagnosticsJson))
        {
            return [];
        }

        try
        {
            return JsonSerializer.Deserialize(diagnosticsJson, LangJson.Default.WInDiagnosticArray) ?? [];
        }
        catch
        {
            return [];
        }
    }

    /// <summary>Extracts <c>X</c> from a Suggestions-style message ending in <c>… — did you mean 'X'?</c>.</summary>
    private static string? ExtractSuggestion(string message)
    {
        const string marker = "did you mean '";
        var i = message.IndexOf(marker, StringComparison.Ordinal);
        if (i < 0)
        {
            return null;
        }

        var start = i + marker.Length;
        var end = message.IndexOf('\'', start);
        return end > start ? message[start..end] : null;
    }

    /// <summary>Converts a <see cref="Reference"/> (1-based line, 0-based columns) to a 0-based LSP range.</summary>
    private static WRange RangeOf(Reference r)
    {
        var line = Math.Max(0, r.Line - 1);
        return new WRange(new WPosition(line, r.StartColumn), new WPosition(line, r.EndColumn));
    }

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

    private static string SerializeCompletions(WCompletionList r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WCompletionList);

    /// <summary>Maps a Koine completion kind to the numeric LSP <c>CompletionItemKind</c> (mirrors LspServer).</summary>
    private static int LspCompletionKind(CompletionItemKind kind) => kind switch
    {
        CompletionItemKind.Keyword => 14,
        CompletionItemKind.Class => 7,
        CompletionItemKind.Enum => 13,
        CompletionItemKind.EnumMember => 20,
        CompletionItemKind.Field => 5,
        CompletionItemKind.Property => 10,
        CompletionItemKind.Method => 2,
        _ => 1,
    };

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

/// <summary>One structured glossary entry (shape mirrors lsp.ts <c>GlossaryEntry</c>).</summary>
public sealed record WGlossaryEntry(
    string Id, string Name, string Kind, string Context, string QualifiedName, string? Doc, WRange NameRange);

/// <summary>Structured ubiquitous-language glossary: entries in declaration order.</summary>
public sealed record WGlossaryModel(WGlossaryEntry[] Entries);

/// <summary>Result of a set-doc request: the file the edits apply to, plus the doc-comment edits.</summary>
public sealed record WSetDocResult(string? Uri, WTextEdit[] Edits);

/// <summary>LSP MarkupContent.</summary>
public sealed record WMarkupContent(string Kind, string Value);

/// <summary>LSP Hover.</summary>
public sealed record WHoverResult(WMarkupContent Contents);

/// <summary>LSP CompletionItem (kind is the numeric LSP <c>CompletionItemKind</c>).</summary>
public sealed record WCompletionItem(string Label, int Kind, string? Detail, string? Documentation);

/// <summary>LSP CompletionList.</summary>
public sealed record WCompletionList(bool IsIncomplete, WCompletionItem[] Items);

/// <summary>LSP Location.</summary>
public sealed record WLocation(string Uri, WRange Range);

/// <summary>LSP ParameterInformation: the parameter's display label.</summary>
public sealed record WParameterInfo(string Label);

/// <summary>LSP SignatureInformation: a callable's full label plus its parameters.</summary>
public sealed record WSignatureInfo(string Label, WParameterInfo[] Parameters);

/// <summary>LSP SignatureHelp: the resolved signatures plus the active signature/parameter indices.</summary>
public sealed record WSignatureHelp(WSignatureInfo[] Signatures, int ActiveSignature, int ActiveParameter);

/// <summary>LSP DocumentSymbol (recursive).</summary>
public sealed record WDocumentSymbol(string Name, int Kind, WRange Range, WRange SelectionRange, WDocumentSymbol[] Children);

/// <summary>LSP TextEdit.</summary>
public sealed record WTextEdit(WRange Range, string NewText);

/// <summary>LSP prepareRename answer: the editable identifier range + the current name placeholder.</summary>
public sealed record WPrepareRename(WRange Range, string? Placeholder);

/// <summary>LSP WorkspaceEdit: per-file text edits keyed by uri.</summary>
public sealed record WWorkspaceEdit(Dictionary<string, WTextEdit[]> Changes);

/// <summary>LSP CodeAction with an inline workspace edit (quickfix or refactor).</summary>
public sealed record WCodeAction(string Title, string Kind, WWorkspaceEdit Edit);

/// <summary>Living-documentation files (Mermaid-in-Markdown) for the merged workspace.</summary>
public sealed record WDocsResult(WEmitFile[] Files);

/// <summary>Input shape: one of the client's active-file diagnostics (only range + message are read).</summary>
public sealed record WInDiagnostic(WRange Range, string Message);

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
[JsonSerializable(typeof(WGlossaryModel))]
[JsonSerializable(typeof(WContextMapResult))]
[JsonSerializable(typeof(WSetDocResult))]
[JsonSerializable(typeof(WHoverResult))]
[JsonSerializable(typeof(WCompletionList))]
[JsonSerializable(typeof(WLocation))]
[JsonSerializable(typeof(WLocation[]))]
[JsonSerializable(typeof(WSignatureHelp))]
[JsonSerializable(typeof(WDocumentSymbol[]))]
[JsonSerializable(typeof(WTextEdit[]))]
[JsonSerializable(typeof(WPrepareRename))]
[JsonSerializable(typeof(WWorkspaceEdit))]
[JsonSerializable(typeof(WCodeAction[]))]
[JsonSerializable(typeof(WDocsResult))]
[JsonSerializable(typeof(WInDiagnostic[]))]
[JsonSerializable(typeof(WCheckResult))]
internal sealed partial class LangJson : JsonSerializerContext;
