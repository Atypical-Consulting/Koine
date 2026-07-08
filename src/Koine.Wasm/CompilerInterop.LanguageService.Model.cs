using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;
using System.Text.Json;
using Koine.Compiler;
using Koine.Compiler.Ast;
using Koine.Compiler.Diagnostics;
using Koine.Compiler.Emit;
using Koine.Compiler.Emit.Glossary;
using Koine.Compiler.Emit.Grammar;
using Koine.Compiler.Formatting;
using Koine.Compiler.Services;

namespace Koine.Wasm;

// Structured-model surface of the in-browser language service (issue #91 and friends): the
// ubiquitous-language glossary, the strategic context map, the editable model graph round-trip,
// the living-documentation diagrams, and the scenario runner. See CompilerInterop.LanguageService.cs.
[SupportedOSPlatform("browser")]
public static partial class CompilerInterop
{
    /// <summary>
    /// Emits the ubiquitous-language glossary (markdown) for the whole merged workspace. A model that
    /// fails to parse degrades to an empty string rather than throwing.
    /// </summary>
    [JSExport]
    public static string Glossary(string filesJson)
    {
        try
        {
            var model = GetWarmCompilation(DeserializeFiles(filesJson)).Model;
            var markdown = new GlossaryEmitter().Emit(model)[0].Contents;
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
            var model = GetWarmCompilation(DeserializeFiles(filesJson)).Model;
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
            var model = GetWarmCompilation(DeserializeFiles(filesJson)).Model;
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
            var files = DeserializeFiles(filesJson);
            var model = GetWarmCompilation(files).Model;
            var sources = files.Select(f => new SourceFile(f.Uri, f.Text)).ToList();
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
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            if (comp.SyntaxDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return JsonSerializer.Serialize(EmptyModelNode, LangJson.Default.WModelNode);
            }

            WModelNode node = MapModelNode(ModelRoundTripService.ModelToJson(comp.Model, qualifiedName));
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
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            WModelMember[] members = comp.SyntaxDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error)
                ? []
                : ModelRoundTripService.MembersOf(comp.Model, qualifiedName).Select(MapModelMember).ToArray();
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
            if (DeserializeEdit(editJson) is not { } edit)
            {
                return JsonSerializer.Serialize(new WEmitKoineResult(null, []), LangJson.Default.WEmitKoineResult);
            }

            // Warm path (issue #464): reuse the reconciled snapshot so unchanged files skip re-parse.
            EmitResult result = ModelRoundTripService.EmitKoine(GetWarmCompilation(DeserializeFiles(filesJson)), edit);
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
            if (DeserializeEdit(editJson) is not { } edit)
            {
                return JsonSerializer.Serialize(new WApplyModelEditResult(null, [], []), LangJson.Default.WApplyModelEditResult);
            }

            // Warm path (issue #464): reuse the reconciled snapshot so unchanged files skip re-parse.
            ModelEditResult result = ModelRoundTripService.ApplyEdit(GetWarmCompilation(DeserializeFiles(filesJson)), edit);
            var edits = result.Edits.Select(e => new WTextEdit(SpanRange(e.Range), e.NewText)).ToArray();
            var dto = new WApplyModelEditResult(result.Uri, edits, result.Diagnostics.Select(MapRoundTripDiagnostic).ToArray());
            return JsonSerializer.Serialize(dto, LangJson.Default.WApplyModelEditResult);
        }
        catch
        {
            return JsonSerializer.Serialize(new WApplyModelEditResult(null, [], []), LangJson.Default.WApplyModelEditResult);
        }
    }

    private static readonly WModelNode EmptyModelNode = new("model", "", "", [], [], []);

    private static WModelNode MapModelNode(ModelNode n) => new(
        n.Kind, n.QualifiedName, n.Title,
        n.Members.Select(MapModelMember).ToArray(),
        n.Children.Select(MapModelNode).ToArray(),
        n.Transitions.Select(MapModelMember).ToArray());

    private static WModelMember MapModelMember(ModelMember m) => new(m.Kind, m.Name, m.Type, m.Value, m.Via);

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
    /// Living-documentation files (Mermaid-in-Markdown) for the merged workspace, reusing the same
    /// <see cref="DocsEmitter"/> as <c>koine build … --target docs</c>. A model
    /// that fails to parse degrades to <c>{ files: [] }</c> rather than throwing. Returns
    /// <c>{ files: [{ path, contents }] }</c>.
    /// </summary>
    [JSExport]
    public static string Docs(string filesJson)
    {
        try
        {
            var model = GetWarmCompilation(DeserializeFiles(filesJson)).Model;
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
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            if (comp.SyntaxDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return ScenarioService.WriteJson(
                    ScenarioErrorTree(target, operation, "The model has errors; fix them before running a scenario."));
            }

            using JsonDocument givenDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(givenJson) ? "{}" : givenJson);
            using JsonDocument argsDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(argsJson) ? "{}" : argsJson);
            var semantic = comp.SemanticModel;
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
            var comp = GetWarmCompilation(DeserializeFiles(filesJson));
            if (comp.SyntaxDiagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                return ScenarioService.WriteJson(new Dictionary<string, object?> { ["targets"] = Array.Empty<object>() });
            }

            return ScenarioService.WriteJson(ScenarioService.Catalog(comp.SemanticModel));
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

    private static string SerializeContextMap(WContextMapResult r) =>
        JsonSerializer.Serialize(r, LangJson.Default.WContextMapResult);

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

}
