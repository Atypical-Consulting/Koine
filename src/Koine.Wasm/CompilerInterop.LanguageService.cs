using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Serialization;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Docs;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Grammar;
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
/// <para>This mirrors a subset of <c>Koine.Cli</c>'s <c>LspServer</c> handlers — the nine
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

    // Held statically like LanguageService — the classifier reuses its own KoineCompiler across calls.
    private static readonly SemanticTokenProvider SemanticProvider = new();

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
            var sources = files.Select(f => new SourceFile(f.Uri, f.Text)).ToList();

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
                return SerializeContextMap(new WContextMapResult([], [], new()));
            }

            var contexts = model.Contexts.Select(c => c.Name).ToArray();
            var relations = model.ContextMap is null
                ? []
                : model.ContextMap.Relations.Select(MapRelation).ToArray();
            // Additive (#290): each declared context's declaration NameSpan (raw 1-based span over the
            // `context` name token), keyed by name; None → null. Lets the Studio graph jump to source.
            return SerializeContextMap(new WContextMapResult(contexts, relations, ContextSpans(model.Contexts)));
        }
        catch
        {
            return SerializeContextMap(new WContextMapResult([], [], new()));
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
    /// Projects the structured model graph (#91) of the merged workspace to the stable
    /// <c>ModelNode</c> tree — the whole tree, or the subtree at <paramref name="qualifiedName"/> when
    /// supplied. A null/broken model yields the empty <c>model</c> root. Mirrors <c>koine/model</c>.
    /// </summary>
    [JSExport]
    public static string Model(string filesJson, string? qualifiedName)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, diags) = Compiler.Parse(sources);
            if (model is null || diags.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return JsonSerializer.Serialize(EmptyModelNode, LangJson.Default.WModelNode);
            }

            WModelNode node = MapModelNode(ModelRoundTripService.ModelToJson(model, qualifiedName));
            return JsonSerializer.Serialize(node, LangJson.Default.WModelNode);
        }
        catch
        {
            return JsonSerializer.Serialize(EmptyModelNode, LangJson.Default.WModelNode);
        }
    }

    /// <summary>
    /// Enumerates the editable children of the node at <paramref name="qualifiedName"/> (#91): a
    /// value/entity's fields, an enum's members, a state machine's transitions, the context map's
    /// relations. A null/broken model or unresolved name yields <c>{ members: [] }</c>.
    /// </summary>
    [JSExport]
    public static string ModelMembers(string filesJson, string qualifiedName)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, diags) = Compiler.Parse(sources);
            WModelMember[] members = model is null || diags.Any(d => d.Severity == DiagnosticSeverity.Error)
                ? []
                : ModelRoundTripService.MembersOf(model, qualifiedName).Select(MapModelMember).ToArray();
            return JsonSerializer.Serialize(new WModelMembersResult(members), LangJson.Default.WModelMembersResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WModelMembersResult([]), LangJson.Default.WModelMembersResult);
        }
    }

    /// <summary>
    /// Applies the structured edit <paramref name="editJson"/> and returns the validated canonical
    /// <c>.koi</c> for the affected declaration (#91), or the rejecting diagnostics. A malformed
    /// edit yields <c>{ koine: null, diagnostics: [] }</c>. Mirrors <c>koine/emitKoine</c>.
    /// </summary>
    [JSExport]
    public static string EmitKoine(string filesJson, string editJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            if (DeserializeEdit(editJson) is not { } edit)
            {
                return JsonSerializer.Serialize(new WEmitKoineResult(null, []), LangJson.Default.WEmitKoineResult);
            }

            EmitResult result = ModelRoundTripService.EmitKoine(sources, edit);
            var dto = new WEmitKoineResult(result.Koine, result.Diagnostics.Select(MapRoundTripDiagnostic).ToArray());
            return JsonSerializer.Serialize(dto, LangJson.Default.WEmitKoineResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WEmitKoineResult(null, []), LangJson.Default.WEmitKoineResult);
        }
    }

    /// <summary>
    /// Applies the structured edit <paramref name="editJson"/> and returns a span-minimal patch (#91):
    /// <c>{ uri, edits, diagnostics }</c>. A malformed edit yields the empty patch. Mirrors
    /// <c>koine/applyModelEdit</c>.
    /// </summary>
    [JSExport]
    public static string ApplyModelEdit(string filesJson, string editJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            if (DeserializeEdit(editJson) is not { } edit)
            {
                return JsonSerializer.Serialize(new WApplyModelEditResult(null, [], []), LangJson.Default.WApplyModelEditResult);
            }

            ModelEditResult result = ModelRoundTripService.ApplyEdit(sources, edit);
            var edits = result.Edits.Select(e => new WTextEdit(SpanRange(e.Range), e.NewText)).ToArray();
            var dto = new WApplyModelEditResult(result.Uri, edits, result.Diagnostics.Select(MapRoundTripDiagnostic).ToArray());
            return JsonSerializer.Serialize(dto, LangJson.Default.WApplyModelEditResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WApplyModelEditResult(null, [], []), LangJson.Default.WApplyModelEditResult);
        }
    }

    private static readonly WModelNode EmptyModelNode = new("model", "", "", [], []);

    private static WModelNode MapModelNode(ModelNode n) => new(
        n.Kind, n.QualifiedName, n.Title,
        n.Members.Select(MapModelMember).ToArray(),
        n.Children.Select(MapModelNode).ToArray());

    private static WModelMember MapModelMember(ModelMember m) => new(m.Kind, m.Name, m.Type, m.Value);

    private static WRoundTripDiagnostic MapRoundTripDiagnostic(Diagnostic d) =>
        new(d.Code, d.Message, SpanRange(d.Span), d.File);

    private static StructuredEdit? DeserializeEdit(string editJson)
    {
        WStructuredEdit? dto = JsonSerializer.Deserialize(editJson, LangJson.Default.WStructuredEdit);
        if (dto is null || string.IsNullOrEmpty(dto.Kind) || string.IsNullOrEmpty(dto.Target))
        {
            return null;
        }

        return new StructuredEdit(dto.Kind, dto.Target, dto.Name, dto.Type, dto.Value);
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
                .Select(i => new WCompletionItem(
                    i.Label, LspCompletionKind(i.Kind), i.Detail, i.Documentation,
                    i.InsertText, i.InsertTextFormat,
                    i.CommitCharacters?.ToArray(), i.SortText, i.Data))
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
    /// A flat, workspace-wide symbol search (LSP <c>workspace/symbol</c>): every declaration across the
    /// merged workspace whose name case-insensitively subsequence-matches <paramref name="query"/>
    /// (an empty query returns all). Returns a JSON <c>SymbolInformation[]</c>. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string WorkspaceSymbols(string filesJson, string query)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var symbols = LanguageService.WorkspaceSymbols(docs, query)
                .Select(s => new WWorkspaceSymbol(s.Name, LspSymbolKind(s.Kind), s.Uri, SpanRange(s.Range), s.ContainerName))
                .ToArray();
            return JsonSerializer.Serialize(symbols, LangJson.Default.WWorkspaceSymbolArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// The collapsible regions of <paramref name="source"/> (LSP <c>textDocument/foldingRange</c>):
    /// one <c>{ startLine, endLine }</c> (0-based, both inclusive) per multi-line block declaration.
    /// Returns a JSON <c>FoldingRange[]</c>. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string FoldingRanges(string source)
    {
        try
        {
            var folds = LanguageService.FoldingRanges(source)
                .Select(f => new WFoldingRange(
                    Math.Max(0, f.Range.Line - 1),
                    Math.Max(Math.Max(0, f.Range.Line - 1), f.Range.EndLine - 1)))
                .ToArray();
            return JsonSerializer.Serialize(folds, LangJson.Default.WFoldingRangeArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// The selection-range chains for a set of positions (LSP <c>textDocument/selectionRange</c>):
    /// <paramref name="positionsJson"/> is a JSON array of <c>{ line, character }</c> (0-based), and
    /// the result is a parallel JSON array of nested <c>{ range, parent? }</c> chains. Parity with the
    /// stdio LSP.
    /// </summary>
    [JSExport]
    public static string SelectionRanges(string source, string positionsJson)
    {
        try
        {
            var positions = JsonSerializer.Deserialize(positionsJson, LangJson.Default.WInPositionArray) ?? [];
            var chains = positions
                .Select(p => ToLspSelectionRange(LanguageService.SelectionRangeAt(source, p.Line, p.Character)))
                .ToArray();
            return JsonSerializer.Serialize(chains, LangJson.Default.WSelectionRangeArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// The code lenses of the active document (LSP <c>textDocument/codeLens</c>): one per top-level
    /// declaration, annotated with a <c>"N references"</c> reference-count title. <paramref name="filesJson"/>
    /// is the merged workspace (so cross-file references resolve) and <paramref name="activeUri"/> the
    /// document to lens. The title is computed eagerly. Returns a JSON <c>CodeLens[]</c>. Parity with
    /// the stdio LSP.
    /// </summary>
    [JSExport]
    public static string CodeLenses(string filesJson, string activeUri)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var lenses = LanguageService.CodeLenses(docs, activeUri)
                .Select(l => new WCodeLens(SpanRange(l.Range), l.Title))
                .ToArray();
            return JsonSerializer.Serialize(lenses, LangJson.Default.WCodeLensArray);
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
    /// Range-formatting edits (LSP <c>textDocument/rangeFormatting</c>) for the 0-based selection in
    /// <paramref name="source"/>: the whole document is formatted, the minimal changed line-region is
    /// taken and intersected with the selection, yielding a single clipped <c>TextEdit</c> — or an empty
    /// array when the selection contains nothing to reformat. Parity with the stdio LSP's
    /// <c>RangeFormattingResultJson</c> (both delegate to <see cref="KoineFormatter.FormatRange"/>).
    /// </summary>
    [JSExport]
    public static string FormatRange(string source, int startLine, int startChar, int endLine, int endChar)
    {
        try
        {
            var edit = new KoineFormatter().FormatRange(source, startLine, startChar, endLine, endChar);
            if (edit is null)
            {
                return "[]";
            }

            var wedit = new WTextEdit(
                new WRange(
                    new WPosition(edit.StartLine, edit.StartCharacter),
                    new WPosition(edit.EndLine, edit.EndCharacter)),
                edit.NewText);
            return JsonSerializer.Serialize(new[] { wedit }, LangJson.Default.WTextEditArray);
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
    /// Same-file occurrence highlights for the name at a 0-based position in <paramref name="activeUri"/>
    /// (LSP <c>textDocument/documentHighlight</c>): a JSON array of <c>{ range, kind }</c>. Reuses the
    /// <c>ReferencesAt</c> binder filtered to the active document — <see cref="Reference"/> carries no
    /// read/write distinction, so every highlight is <c>DocumentHighlightKind.Text</c> (1). Parity with
    /// the stdio LSP's <c>DocumentHighlightResultJson</c>.
    /// </summary>
    [JSExport]
    public static string DocumentHighlightsAt(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var docs = DeserializeFiles(filesJson).ToDictionary(f => f.Uri, f => f.Text, StringComparer.Ordinal);
            var highlights = LanguageService.ReferencesAt(docs, activeUri, line, character)
                .Where(r => string.Equals(r.Uri, activeUri, StringComparison.Ordinal))
                .Select(r => new WDocumentHighlight(RangeOf(r), 1)) // LSP DocumentHighlightKind.Text
                .ToArray();
            return JsonSerializer.Serialize(highlights, LangJson.Default.WDocumentHighlightArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Inlay hints over the 0-based range in <paramref name="activeUri"/> (LSP <c>textDocument/inlayHint</c>):
    /// a JSON array of <c>{ position, label, kind }</c>, kind 1=Type/2=Parameter, positions 0-based.
    /// Parity with the stdio LSP's <c>InlayHintResultJson</c>.
    /// </summary>
    [JSExport]
    public static string InlayHints(
        string filesJson, string activeUri, int startLine, int startChar, int endLine, int endChar)
    {
        try
        {
            var comp = KoineCompilation.Create(
                DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList());
            var hints = LanguageService.InlayHintsAt(comp, activeUri, startLine, startChar, endLine, endChar)
                .Select(h => new WInlayHint(
                    new WPosition(h.Line, h.Character),
                    h.Label,
                    h.Kind == InlayHintKind.Type ? 1 : 2)) // LSP InlayHintKind: Type=1, Parameter=2
                .ToArray();
            return JsonSerializer.Serialize(hints, LangJson.Default.WInlayHintArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Prepare call hierarchy at a 0-based position in <paramref name="activeUri"/> (LSP
    /// <c>textDocument/prepareCallHierarchy</c>): the command/event under the cursor, as a JSON array of
    /// LSP CallHierarchyItem. Parity with the stdio LSP's <c>CallHierarchyPrepareJson</c>.
    /// </summary>
    [JSExport]
    public static string PrepareCallHierarchy(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var comp = KoineCompilation.Create(
                DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList());
            var items = LanguageService.PrepareCallHierarchy(comp, activeUri, line, character)
                .Select(MapCallHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WCallHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Incoming calls (LSP <c>callHierarchy/incomingCalls</c>): <paramref name="itemJson"/> is the LSP
    /// CallHierarchyItem; its <c>name</c> + <c>data</c> reconstruct the in-process item. Returns a JSON
    /// array of <c>{ from, fromRanges }</c> (fromRanges empty). Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string IncomingCalls(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeCallHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = KoineCompilation.Create(
                DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList());
            var calls = LanguageService.IncomingCalls(comp, item)
                .Select(c => new WCallHierarchyIncomingCall(MapCallHierarchyItem(c.From), []))
                .ToArray();
            return JsonSerializer.Serialize(calls, LangJson.Default.WCallHierarchyIncomingCallArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Outgoing calls (LSP <c>callHierarchy/outgoingCalls</c>): <paramref name="itemJson"/> is the LSP
    /// CallHierarchyItem. Returns a JSON array of <c>{ to, fromRanges }</c> (fromRanges empty). Parity
    /// with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string OutgoingCalls(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeCallHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = KoineCompilation.Create(
                DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList());
            var calls = LanguageService.OutgoingCalls(comp, item)
                .Select(c => new WCallHierarchyOutgoingCall(MapCallHierarchyItem(c.To), []))
                .ToArray();
            return JsonSerializer.Serialize(calls, LangJson.Default.WCallHierarchyOutgoingCallArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Maps a <see cref="CallHierarchyItem"/> to the wire <see cref="WCallHierarchyItem"/>: kind is an
    /// LSP SymbolKind number (Method=6 Command / Event=24); range + selectionRange are both the item's
    /// 0-based name span; the <c>data</c> blob carries chKind + owningType (mirrors LspServer).
    /// </summary>
    private static WCallHierarchyItem MapCallHierarchyItem(CallHierarchyItem item)
    {
        var range = SpanRange(item.Span);
        return new WCallHierarchyItem(
            item.Name,
            item.Kind == CallHierarchyItemKind.Command ? 6 : 24, // LSP SymbolKind: Method=6, Event=24
            item.Uri,
            range,
            range,
            new WCallHierarchyData(
                item.Kind == CallHierarchyItemKind.Command ? "Command" : "Event",
                item.OwningType));
    }

    /// <summary>
    /// Reconstructs a <see cref="CallHierarchyItem"/> from an LSP CallHierarchyItem JSON: only
    /// <c>name</c> + <c>data.chKind</c>/<c>data.owningType</c> are read (the incoming/outgoing calls use
    /// just those three fields; the span/uri are placeholders). Returns <c>null</c> when malformed.
    /// </summary>
    private static CallHierarchyItem? DeserializeCallHierarchyItem(string itemJson)
    {
        WCallHierarchyItem? dto = JsonSerializer.Deserialize(itemJson, LangJson.Default.WCallHierarchyItem);
        // Require a non-empty chKind, exactly like the stdio server's ReadCallHierarchyItem — so a
        // malformed item (missing data/chKind) yields the SAME empty result on both backends rather
        // than the WASM side silently defaulting to Command and diverging from the stdio LSP.
        if (dto is null || string.IsNullOrEmpty(dto.Name) || dto.Data is null || string.IsNullOrEmpty(dto.Data.ChKind))
        {
            return null;
        }

        var kind = string.Equals(dto.Data.ChKind, "Event", StringComparison.Ordinal)
            ? CallHierarchyItemKind.Event
            : CallHierarchyItemKind.Command;
        return new CallHierarchyItem(dto.Name, kind, dto.Data.OwningType, "", SourceSpan.None);
    }

    /// <summary>
    /// Prepare type hierarchy at a 0-based position in <paramref name="activeUri"/> (LSP
    /// <c>textDocument/prepareTypeHierarchy</c>): the declared type under the cursor, as a JSON array of
    /// LSP TypeHierarchyItem. Parity with the stdio LSP's <c>TypeHierarchyPrepareJson</c>.
    /// </summary>
    [JSExport]
    public static string PrepareTypeHierarchy(string filesJson, string activeUri, int line, int character)
    {
        try
        {
            var comp = KoineCompilation.Create(
                DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList());
            var items = LanguageService.PrepareTypeHierarchy(comp, activeUri, line, character)
                .Select(MapTypeHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WTypeHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Supertypes (LSP <c>typeHierarchy/supertypes</c>): <paramref name="itemJson"/> is the LSP
    /// TypeHierarchyItem; its <c>name</c> + <c>data</c> reconstruct the in-process item. Returns a JSON
    /// array of the declared types it points at. Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string Supertypes(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeTypeHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = KoineCompilation.Create(
                DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList());
            var items = LanguageService.Supertypes(comp, item)
                .Select(MapTypeHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WTypeHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Subtypes (LSP <c>typeHierarchy/subtypes</c>): <paramref name="itemJson"/> is the LSP
    /// TypeHierarchyItem. Returns a JSON array of the declared types that point at it (the inverse edges).
    /// Parity with the stdio LSP.
    /// </summary>
    [JSExport]
    public static string Subtypes(string filesJson, string itemJson)
    {
        try
        {
            if (DeserializeTypeHierarchyItem(itemJson) is not { } item)
            {
                return "[]";
            }

            var comp = KoineCompilation.Create(
                DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList());
            var items = LanguageService.Subtypes(comp, item)
                .Select(MapTypeHierarchyItem)
                .ToArray();
            return JsonSerializer.Serialize(items, LangJson.Default.WTypeHierarchyItemArray);
        }
        catch
        {
            return "[]";
        }
    }

    /// <summary>
    /// Maps a <see cref="TypeHierarchyItem"/> to the wire <see cref="WTypeHierarchyItem"/>: kind is an LSP
    /// SymbolKind number; range + selectionRange are both the declaration's 0-based name span; the
    /// <c>data</c> blob carries the in-process kind (<c>thKind</c>) so a supertypes/subtypes request can
    /// reconstruct the item. Mirrors LspServer's <c>TypeHierarchyItemJson</c>.
    /// </summary>
    private static WTypeHierarchyItem MapTypeHierarchyItem(TypeHierarchyItem item)
    {
        var range = SpanRange(item.Span);
        return new WTypeHierarchyItem(
            item.Name,
            LspTypeHierarchyKind(item.Kind),
            item.Uri,
            range,
            range,
            new WTypeHierarchyData(item.Kind.ToString()));
    }

    /// <summary>
    /// Reconstructs a <see cref="TypeHierarchyItem"/> from an LSP TypeHierarchyItem JSON: only <c>name</c> +
    /// <c>data.thKind</c> are read (the supertypes/subtypes resolution keys off the name; the span/uri are
    /// placeholders). Returns <c>null</c> when malformed — the SAME empty result the stdio LSP produces.
    /// </summary>
    private static TypeHierarchyItem? DeserializeTypeHierarchyItem(string itemJson)
    {
        WTypeHierarchyItem? dto = JsonSerializer.Deserialize(itemJson, LangJson.Default.WTypeHierarchyItem);
        if (dto is null || string.IsNullOrEmpty(dto.Name) || dto.Data is null || string.IsNullOrEmpty(dto.Data.ThKind))
        {
            return null;
        }

        var kind = Enum.TryParse<TypeHierarchyItemKind>(dto.Data.ThKind, out var k) ? k : TypeHierarchyItemKind.Other;
        return new TypeHierarchyItem(dto.Name, kind, "", SourceSpan.None);
    }

    /// <summary>Maps a <see cref="TypeHierarchyItemKind"/> to the numeric LSP <c>SymbolKind</c> (mirrors LspServer).</summary>
    private static int LspTypeHierarchyKind(TypeHierarchyItemKind kind) => kind switch
    {
        TypeHierarchyItemKind.Aggregate => 5,  // Class
        TypeHierarchyItemKind.Entity => 5,     // Class
        TypeHierarchyItemKind.Value => 23,     // Struct
        TypeHierarchyItemKind.ReadModel => 11, // Interface
        TypeHierarchyItemKind.Enum => 10,      // Enum
        TypeHierarchyItemKind.Event => 24,     // Event
        _ => 13,                               // Variable
    };

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

            var emitter = new DocsEmitter();
            var diagramsByFile = emitter.EmitDiagrams(model);
            var files = emitter.Emit(model)
                .Select(f => new WDocsFile(
                    f.RelativePath,
                    f.Contents,
                    diagramsByFile.TryGetValue(f.RelativePath, out var diagrams)
                        ? diagrams.Select(MapDiagram).ToArray()
                        : []))
                .ToArray();
            return JsonSerializer.Serialize(new WDocsResult(files), LangJson.Default.WDocsResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WDocsResult([]), LangJson.Default.WDocsResult);
        }
    }

    /// <summary>
    /// Runs a scenario (#149) against the merged workspace: exercises one aggregate command/factory
    /// (<paramref name="target"/>/<paramref name="operation"/>) over the <paramref name="givenJson"/>
    /// state and <paramref name="argsJson"/> arguments, returning the <c>command → events →
    /// invariant-checks</c> timeline. Mirrors <c>koine/runScenario</c>; shares the exact response shape
    /// with the LSP backend via <see cref="ScenarioService"/>. A null/broken model yields a not-ok
    /// result carrying an explanatory note.
    /// </summary>
    [JSExport]
    public static string RunScenario(string filesJson, string target, string operation, string givenJson, string argsJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, diags) = Compiler.Parse(sources);
            if (model is null || diags.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return ScenarioService.WriteJson(
                    ScenarioErrorTree(target, operation, "The model has errors; fix them before running a scenario."));
            }

            using JsonDocument givenDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(givenJson) ? "{}" : givenJson);
            using JsonDocument argsDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(argsJson) ? "{}" : argsJson);
            var semantic = new SemanticModel(model);
            return ScenarioService.WriteJson(
                ScenarioService.Run(semantic, target, operation, givenDoc.RootElement, argsDoc.RootElement));
        }
        catch
        {
            return ScenarioService.WriteJson(
                ScenarioErrorTree(target, operation, "The scenario could not be run against this model."));
        }
    }

    /// <summary>
    /// The runnable surface of the merged workspace (#149): the entities exposing commands/factories,
    /// their operations + parameters, and their fields. Mirrors <c>koine/scenarioCatalog</c>; shares the
    /// shape with the LSP backend via <see cref="ScenarioService"/>. A null/broken model yields
    /// <c>{ targets: [] }</c>.
    /// </summary>
    [JSExport]
    public static string ScenarioCatalog(string filesJson)
    {
        try
        {
            var sources = DeserializeFiles(filesJson).Select(f => new SourceFile(f.Uri, f.Text)).ToList();
            var (model, diags) = Compiler.Parse(sources);
            if (model is null || diags.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return ScenarioService.WriteJson(new Dictionary<string, object?> { ["targets"] = Array.Empty<object>() });
            }

            return ScenarioService.WriteJson(ScenarioService.Catalog(new SemanticModel(model)));
        }
        catch
        {
            return ScenarioService.WriteJson(new Dictionary<string, object?> { ["targets"] = Array.Empty<object>() });
        }
    }

    /// <summary>The not-ok scenario result for the failure paths — delegates to <see cref="ScenarioService"/>
    /// so the wire shape lives in exactly one place (shared with the LSP backend).</summary>
    private static IReadOnlyDictionary<string, object?> ScenarioErrorTree(string target, string operation, string note) =>
        ScenarioService.Error(target, operation, note);

    // ---- diagram-graph mapping (issue #93) -----------------------------------
    // Mirrors LspServer.MapDiagram et al.: the W* DTOs serialize (source-gen CamelCase) to a wire
    // shape field-for-field identical to the LSP backend's hand-written dict keys. The parity test
    // guards that the two stay in lock-step.

    /// <summary>Maps a compiler <see cref="DiagramDescriptor"/> to the wire <see cref="WDiagram"/>.</summary>
    private static WDiagram MapDiagram(DiagramDescriptor d) =>
        new(d.Caption, d.Kind, d.Mermaid, MapGraph(d.Graph));

    private static WDiagramGraph MapGraph(DiagramGraph g) =>
        new(g.Nodes.Select(MapNode).ToArray(), g.Edges.Select(MapEdge).ToArray());

    private static WDiagramNode MapNode(DiagramNode n) =>
        new(n.Id, n.Label, n.Kind, n.QualifiedName, MapSourceSpan(n.Span),
            n.Stereotype, (n.Members ?? []).Select(MapMember).ToArray(), (n.Invariants ?? []).ToArray(), n.Doc);

    private static WDiagramMember MapMember(DiagramMember m) =>
        new(m.Text, m.Kind);

    private static WDiagramEdge MapEdge(DiagramEdge e) =>
        new(e.From, e.To, e.Label, e.Cardinality, e.SourceCardinality, e.ArrowKind, e.BackingMember);

    /// <summary>Maps the raw 1-based <see cref="SourceSpan"/> straight through (null when the node has none).</summary>
    private static WSourceSpan? MapSourceSpan(SourceSpan? span) =>
        span is { } s ? new WSourceSpan(s.File, s.Line, s.Column, s.EndLine, s.EndColumn, s.Offset, s.Length) : null;

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

    /// <summary>
    /// Projects each declared context's declaration <c>NameSpan</c> into a name → raw-1-based-span map
    /// (the additive <c>contextSpans</c> field, #290). A recovered context with no span maps to
    /// <c>null</c>; a duplicate name keeps the first declaration's span.
    /// </summary>
    private static Dictionary<string, WSourceSpan?> ContextSpans(IEnumerable<ContextNode> contexts)
    {
        var spans = new Dictionary<string, WSourceSpan?>(StringComparer.Ordinal);
        foreach (var c in contexts)
        {
            if (!spans.ContainsKey(c.Name))
            {
                spans[c.Name] = MapSourceSpan(c.NameSpan.IsNone ? null : c.NameSpan);
            }
        }

        return spans;
    }

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

    private static WSelectionRange ToLspSelectionRange(SelectionRange? chain)
    {
        // A null chain still yields a degenerate selection range (empty range at doc start) so the
        // result array stays parallel to the requested positions.
        if (chain is null)
        {
            return new WSelectionRange(SpanRange(SourceSpan.None), null);
        }

        return new WSelectionRange(
            SpanRange(chain.Range),
            chain.Parent is null ? null : ToLspSelectionRange(chain.Parent));
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

/// <summary>One emit target's display metadata (issue #282): id, human label, emitted file extension.</summary>
public sealed record WEmitTarget(string Id, string DisplayName, string FileExtension);

/// <summary>The emit-target capability list (issue #282): the registry's code targets, in display order.</summary>
public sealed record WEmitTargetsResult(WEmitTarget[] Targets);

/// <summary>
/// The module self-description (issue #330): the compiler <c>version</c>, the names of every
/// <c>[JSExport]</c> the bundle ships (<c>exports</c>), and the emit <c>targets</c> it supports. Reuses
/// <see cref="WEmitTarget"/> so the target shape is byte-identical to <c>ListEmitTargets</c>.
/// </summary>
public sealed record WCapabilities(string Version, string[] Exports, WEmitTarget[] Targets);

/// <summary>Ubiquitous-language glossary as markdown.</summary>
public sealed record WGlossaryResult(string Markdown);

/// <summary>An anti-corruption-layer mapping in the context map.</summary>
public sealed record WAclMapping(string UpstreamContext, string UpstreamType, string LocalContext, string LocalType);

/// <summary>One context-map relation.</summary>
public sealed record WContextRelation(
    string Upstream, string Downstream, string Kind, bool Bidirectional, string[] SharedTypes, WAclMapping[] Acl);

/// <summary>Strategic context map: contexts + relations. <c>ContextSpans</c> is additive (#290): a
/// name → declaration source span map (the raw 1-based span over the <c>context</c> name token, null on
/// a recovered parse) so the Studio graph can jump to the <c>.koi</c> declaration on a context click.</summary>
public sealed record WContextMapResult(
    string[] Contexts, WContextRelation[] Relations, Dictionary<string, WSourceSpan?> ContextSpans);

/// <summary>One structured glossary entry (shape mirrors lsp.ts <c>GlossaryEntry</c>).</summary>
public sealed record WGlossaryEntry(
    string Id, string Name, string Kind, string Context, string QualifiedName, string? Doc, WRange NameRange);

/// <summary>Structured ubiquitous-language glossary: entries in declaration order.</summary>
public sealed record WGlossaryModel(WGlossaryEntry[] Entries);

/// <summary>One editable leaf of a model node (#91; mirrors lsp.ts <c>ModelMember</c>).</summary>
public sealed record WModelMember(string Kind, string Name, string? Type, string? Value);

/// <summary>One node of the structured model graph (#91; recursive; mirrors lsp.ts <c>ModelNode</c>).</summary>
public sealed record WModelNode(
    string Kind, string QualifiedName, string Title, WModelMember[] Members, WModelNode[] Children);

/// <summary>The editable children of a model node (#91).</summary>
public sealed record WModelMembersResult(WModelMember[] Members);

/// <summary>A structured edit against the model (#91; mirrors lsp.ts <c>StructuredEdit</c>).</summary>
public sealed record WStructuredEdit(string Kind, string Target, string? Name, string? Type, string? Value);

/// <summary>A round-trip diagnostic (#91): the rejecting <c>KOIxxxx</c> with its range and owning file.</summary>
public sealed record WRoundTripDiagnostic(string Code, string Message, WRange Range, string? Uri);

/// <summary>Result of an emit-koine request (#91): the canonical <c>.koi</c> or rejecting diagnostics.</summary>
public sealed record WEmitKoineResult(string? Koine, WRoundTripDiagnostic[] Diagnostics);

/// <summary>Result of an apply-model-edit request (#91): the owning file, the patch, any diagnostics.</summary>
public sealed record WApplyModelEditResult(string? Uri, WTextEdit[] Edits, WRoundTripDiagnostic[] Diagnostics);

/// <summary>Result of a set-doc request: the file the edits apply to, plus the doc-comment edits.</summary>
public sealed record WSetDocResult(string? Uri, WTextEdit[] Edits);

/// <summary>LSP MarkupContent.</summary>
public sealed record WMarkupContent(string Kind, string Value);

/// <summary>LSP Hover.</summary>
public sealed record WHoverResult(WMarkupContent Contents);

/// <summary>
/// LSP CompletionItem (kind is the numeric LSP <c>CompletionItemKind</c>). The trailing fields are
/// optional/additive so the serialized shape stays backward-compatible: <c>InsertText</c> +
/// <c>InsertTextFormat</c> (2 = snippet) carry a snippet body; <c>CommitCharacters</c>,
/// <c>SortText</c> and <c>Data</c> mirror the editor-agnostic <c>CompletionItem</c>.
/// </summary>
public sealed record WCompletionItem(
    string Label,
    int Kind,
    string? Detail,
    string? Documentation,
    string? InsertText = null,
    int? InsertTextFormat = null,
    string[]? CommitCharacters = null,
    string? SortText = null,
    string? Data = null);

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

/// <summary>LSP SymbolInformation (flat, workspace-wide): name, kind, location, and container.</summary>
public sealed record WWorkspaceSymbol(string Name, int Kind, string Uri, WRange Range, string? ContainerName);

/// <summary>LSP FoldingRange: a 0-based, both-inclusive collapsible line span.</summary>
public sealed record WFoldingRange(int StartLine, int EndLine);

/// <summary>LSP SelectionRange (recursive): a range plus the enclosing parent range it grows into.</summary>
public sealed record WSelectionRange(WRange Range, WSelectionRange? Parent);

/// <summary>LSP CodeLens: a range plus its resolved reference-count title (computed eagerly here).</summary>
public sealed record WCodeLens(WRange Range, string? Title);

/// <summary>LSP InlayHint: a 0-based <see cref="Position"/>, a <see cref="Label"/>, and the
/// LSP <c>InlayHintKind</c> number (1=Type, 2=Parameter). Mirrors the LspServer wire shape.</summary>
public sealed record WInlayHint(WPosition Position, string Label, int Kind);

/// <summary>LSP DocumentHighlight: a 0-based <see cref="Range"/> and the LSP <c>DocumentHighlightKind</c>
/// number (1=Text, 2=Read, 3=Write). Koine's <see cref="Reference"/> carries no read/write distinction,
/// so <see cref="Kind"/> is always Text (1). Mirrors the LspServer wire shape.</summary>
public sealed record WDocumentHighlight(WRange Range, int Kind);

/// <summary>
/// LSP CallHierarchyItem: <see cref="Name"/>, the LSP SymbolKind number <see cref="Kind"/> (Method=6
/// Command / Event=24), the declaring <see cref="Uri"/>, the name <see cref="Range"/> and
/// <see cref="SelectionRange"/> (both the same 0-based span), and the opaque <see cref="Data"/> blob
/// the client echoes back so incoming/outgoing requests can reconstruct the item. Mirrors LspServer.
/// </summary>
public sealed record WCallHierarchyItem(
    string Name, int Kind, string Uri, WRange Range, WRange SelectionRange, WCallHierarchyData Data);

/// <summary>The opaque <c>data</c> blob on a CallHierarchyItem: the language-service kind
/// (<c>"Command"</c>/<c>"Event"</c>) and the owning entity (null for an event).</summary>
public sealed record WCallHierarchyData(string ChKind, string? OwningType);

/// <summary>LSP CallHierarchyIncomingCall: the <see cref="From"/> item plus its <see cref="FromRanges"/>
/// (kept empty for parity with the stdio LSP).</summary>
public sealed record WCallHierarchyIncomingCall(WCallHierarchyItem From, WRange[] FromRanges);

/// <summary>LSP CallHierarchyOutgoingCall: the <see cref="To"/> item plus its <see cref="FromRanges"/>
/// (kept empty for parity with the stdio LSP).</summary>
public sealed record WCallHierarchyOutgoingCall(WCallHierarchyItem To, WRange[] FromRanges);

/// <summary>
/// LSP TypeHierarchyItem: <see cref="Name"/>, the LSP SymbolKind number <see cref="Kind"/>, the declaring
/// <see cref="Uri"/>, the name <see cref="Range"/> and <see cref="SelectionRange"/> (both the same 0-based
/// span), and the opaque <see cref="Data"/> blob the client echoes back so supertypes/subtypes requests
/// can reconstruct the item. Mirrors the LspServer wire shape (and the call-hierarchy item).
/// </summary>
public sealed record WTypeHierarchyItem(
    string Name, int Kind, string Uri, WRange Range, WRange SelectionRange, WTypeHierarchyData Data);

/// <summary>The opaque <c>data</c> blob on a TypeHierarchyItem: the language-service kind
/// (<c>"Entity"</c>/<c>"Value"</c>/<c>"ReadModel"</c>/…) so the item can be reconstructed.</summary>
public sealed record WTypeHierarchyData(string ThKind);

/// <summary>Input shape: one requested position for selection ranges (0-based LSP coordinates).</summary>
public sealed record WInPosition(int Line, int Character);

/// <summary>LSP TextEdit.</summary>
public sealed record WTextEdit(WRange Range, string NewText);

/// <summary>LSP prepareRename answer: the editable identifier range + the current name placeholder.</summary>
public sealed record WPrepareRename(WRange Range, string? Placeholder);

/// <summary>LSP WorkspaceEdit: per-file text edits keyed by uri.</summary>
public sealed record WWorkspaceEdit(Dictionary<string, WTextEdit[]> Changes);

/// <summary>LSP CodeAction with an inline workspace edit (quickfix or refactor).</summary>
public sealed record WCodeAction(string Title, string Kind, WWorkspaceEdit Edit);

/// <summary>
/// Living-documentation files (Mermaid-in-Markdown) for the merged workspace, each carrying its
/// structured diagram graphs (issue #93). Distinct from <see cref="WEmitFile"/> — which the
/// emit-preview path shares — so the docs payload can grow a <c>diagrams</c> array without
/// polluting that contract.
/// </summary>
public sealed record WDocsResult(WDocsFile[] Files);

/// <summary>
/// One living-documentation file: its <see cref="Path"/>/<see cref="Contents"/> plus the structured
/// <see cref="Diagrams"/> that ride alongside the Mermaid in its Markdown. <see cref="Diagrams"/> is
/// empty for a file that draws no diagram. Wire shape mirrors the LSP backend + <c>lsp.ts</c>.
/// </summary>
public sealed record WDocsFile(string Path, string Contents, WDiagram[] Diagrams);

/// <summary>One diagram: its rendered Mermaid plus the source-aware <see cref="Graph"/> behind it.</summary>
public sealed record WDiagram(string Caption, string Kind, string Mermaid, WDiagramGraph Graph);

/// <summary>The structured graph of a diagram: its nodes and the directed edges between them.</summary>
public sealed record WDiagramGraph(WDiagramNode[] Nodes, WDiagramEdge[] Edges);

/// <summary>
/// One graph node. The property is named <see cref="SourceSpan"/> (not <c>Span</c>) so the source-gen
/// CamelCase policy yields the wire key <c>"sourceSpan"</c>, matching the LSP/TS contract. The span is
/// the raw 1-based source coordinate (Task 4 converts to 0-based when navigating); null only when the
/// node truly has none. Class nodes carry a <see cref="Stereotype"/> (without guillemets) and UML
/// <see cref="Members"/>; non-class nodes (state/context/integration) carry <c>null</c>/<c>[]</c>.
/// <see cref="Doc"/> is the event's "when this happens" description (issue #170): the wire key
/// <c>"doc"</c>, set for event nodes only, <c>null</c> otherwise.
/// </summary>
public sealed record WDiagramNode(
    string Id, string Label, string Kind, string QualifiedName, WSourceSpan? SourceSpan,
    string? Stereotype, WDiagramMember[] Members, string[] Invariants, string? Doc);

/// <summary>One UML class-body row: a pre-formatted <see cref="Text"/> and its <see cref="Kind"/> (<c>field</c>/<c>method</c>/<c>value</c>).</summary>
public sealed record WDiagramMember(string Text, string Kind);

/// <summary>One directed edge: node ids <see cref="From"/>→<see cref="To"/> with an optional <see cref="Label"/>,
/// the composition target-end <see cref="Cardinality"/> and owner-end <see cref="SourceCardinality"/>
/// (e.g. "1", "0..1", "*"), an <see cref="ArrowKind"/> styling hint (composition/association/transition/flow),
/// and the <see cref="BackingMember"/> qualified field name a field-backed composition edge can be disconnected by.</summary>
public sealed record WDiagramEdge(
    string From, string To, string? Label, string? Cardinality = null,
    string? SourceCardinality = null, string? ArrowKind = null, string? BackingMember = null);

/// <summary>
/// A raw 1-based source span (NOT the 0-based LSP range): the diagram graph keeps source coordinates so
/// the Studio can jump to source. End line/column are end-exclusive; <see cref="File"/> is the source uri.
/// </summary>
public sealed record WSourceSpan(string? File, int Line, int Column, int EndLine, int EndColumn, int Offset, int Length);

/// <summary>Input shape: one of the client's active-file diagnostics (only range + message are read).</summary>
public sealed record WInDiagnostic(WRange Range, string Message);

/// <summary>One model-versioning compatibility change.</summary>
public sealed record WCheckChange(string Impact, string Code, string Message);

/// <summary>Model-versioning compatibility result.</summary>
public sealed record WCheckResult(string? Error, bool HasBreakingChanges, WCheckChange[] Changes);

/// <summary>
/// LSP SemanticTokens: the delta-encoded int stream (five ints per token —
/// deltaLine/deltaStart/length/tokenType/tokenModifiers) decoded against the legend the
/// <c>initialize</c> handshake advertises. <see cref="ResultId"/> is reserved (always null) for a
/// later additive <c>semanticTokens/full/delta</c> pass; full-document tokens only for now.
/// </summary>
public sealed record WSemanticTokens(int[] Data, string? ResultId = null);

/// <summary>Input shape: one open document (uri + full text).</summary>
public sealed record WSourceFileDto(string Uri, string Text);

/// <summary>Source-generated (trim-safe) serialization context for the language-service DTOs.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(WSourceFileDto[]))]
[JsonSerializable(typeof(WFileDiagnostics[]))]
[JsonSerializable(typeof(WEmitPreviewResult))]
[JsonSerializable(typeof(WEmitTargetsResult))]
[JsonSerializable(typeof(WCapabilities))]
[JsonSerializable(typeof(WGlossaryResult))]
[JsonSerializable(typeof(WGlossaryModel))]
[JsonSerializable(typeof(WModelNode))]
[JsonSerializable(typeof(WModelMembersResult))]
[JsonSerializable(typeof(WStructuredEdit))]
[JsonSerializable(typeof(WEmitKoineResult))]
[JsonSerializable(typeof(WApplyModelEditResult))]
[JsonSerializable(typeof(WContextMapResult))]
[JsonSerializable(typeof(WSetDocResult))]
[JsonSerializable(typeof(WHoverResult))]
[JsonSerializable(typeof(WCompletionList))]
[JsonSerializable(typeof(WLocation))]
[JsonSerializable(typeof(WLocation[]))]
[JsonSerializable(typeof(WSignatureHelp))]
[JsonSerializable(typeof(WDocumentSymbol[]))]
[JsonSerializable(typeof(WWorkspaceSymbol[]))]
[JsonSerializable(typeof(WFoldingRange[]))]
[JsonSerializable(typeof(WSelectionRange[]))]
[JsonSerializable(typeof(WCodeLens[]))]
[JsonSerializable(typeof(WInlayHint[]))]
[JsonSerializable(typeof(WDocumentHighlight[]))]
[JsonSerializable(typeof(WCallHierarchyItem))]
[JsonSerializable(typeof(WCallHierarchyItem[]))]
[JsonSerializable(typeof(WCallHierarchyIncomingCall[]))]
[JsonSerializable(typeof(WCallHierarchyOutgoingCall[]))]
[JsonSerializable(typeof(WTypeHierarchyItem))]
[JsonSerializable(typeof(WTypeHierarchyItem[]))]
[JsonSerializable(typeof(WInPosition[]))]
[JsonSerializable(typeof(WTextEdit[]))]
[JsonSerializable(typeof(WPrepareRename))]
[JsonSerializable(typeof(WWorkspaceEdit))]
[JsonSerializable(typeof(WCodeAction[]))]
[JsonSerializable(typeof(WDocsResult))]
[JsonSerializable(typeof(WDocsFile))]
[JsonSerializable(typeof(WDiagram))]
[JsonSerializable(typeof(WDiagramGraph))]
[JsonSerializable(typeof(WDiagramNode))]
[JsonSerializable(typeof(WDiagramMember))]
[JsonSerializable(typeof(WDiagramEdge))]
[JsonSerializable(typeof(WSourceSpan))]
[JsonSerializable(typeof(WInDiagnostic[]))]
[JsonSerializable(typeof(WCheckResult))]
[JsonSerializable(typeof(WSemanticTokens))]
internal sealed partial class LangJson : JsonSerializerContext;
