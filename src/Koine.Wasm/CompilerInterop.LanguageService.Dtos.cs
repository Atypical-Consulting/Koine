using System.Text.Json.Serialization;

namespace Koine.Wasm;

// ---- DTOs (camelCase JSON; shapes mirror tooling/koine-studio/src/lsp.ts) -----

/// <summary>0-based LSP position.</summary>
public sealed record WPosition(int Line, int Character);

/// <summary>0-based LSP range (end-exclusive).</summary>
public sealed record WRange(WPosition Start, WPosition End);

/// <summary>LSP diagnostic (severity 1=error, 2=warning).</summary>
public sealed record WDiagnostic(WRange Range, int Severity, string? Code, string Message);

/// <summary>Per-file diagnostics, ready to publish as <c>textDocument/publishDiagnostics</c>.</summary>
public sealed record WFileDiagnostics(string Uri, WDiagnostic[] Diagnostics);

/// <summary>One emitted source file. <see cref="Kind"/> is the optional DDD-stereotype slug
/// (e.g. <c>"aggregate"</c>, <c>"value"</c>, <c>"event"</c>) used to tint generated files by
/// building block; <c>null</c> for files with no stereotype. Mirrors <c>EmittedFile.Kind</c>.</summary>
public sealed record WEmitFile(string Path, string Contents, string? Kind = null);

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

/// <summary>One editable leaf of a model node (#91; mirrors lsp.ts <c>ModelMember</c>). <c>Via</c> is
/// additive (#1163): a <c>transition</c> member's correlated triggering command (<c>null</c> for every
/// other member kind, and for an uncorrelated edge). Source-gen serializes it to the wire key <c>via</c>.</summary>
public sealed record WModelMember(string Kind, string Name, string? Type, string? Value, string? Via);

/// <summary>One node of the structured model graph (#91; recursive; mirrors lsp.ts <c>ModelNode</c>).
/// <c>Transitions</c> is additive (#1163): an entity/aggregate owner node's flattened per-edge state
/// transitions (empty for every node with no state machine). Source-gen serializes it to <c>transitions</c>.</summary>
public sealed record WModelNode(
    string Kind, string QualifiedName, string Title, WModelMember[] Members, WModelNode[] Children,
    WModelMember[] Transitions);

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
/// (<c>"Entity"</c>/<c>"Value"</c>/<c>"ReadModel"</c>/…) plus the declaring bounded <c>Context</c> (#389,
/// <c>null</c> when unknown) so a same-named type is reconstructed against the right context. Round-tripped
/// field-for-field with the stdio LSP's hand-written <c>data</c> dict.</summary>
public sealed record WTypeHierarchyData(string ThKind, string? Context);

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

/// <summary>
/// One node of the active buffer's parse/syntax tree (issue #890; recursive). A flat projection of
/// <c>Koine.Compiler.Services.SyntaxTreeNode</c>: <see cref="Kind"/> is the node's runtime type name
/// (e.g. <c>ValueObjectDecl</c>), <see cref="Name"/> the declaration identifier (null when it has none),
/// <see cref="Span"/> its raw source range, <see cref="IsMissing"/>/<see cref="IsError"/> flag ANTLR
/// phantom/recovery nodes, and <see cref="Leaf"/> is a truncated source preview set only for a childless
/// node. Serialized identically by the desktop <c>koine/syntaxTree</c> LSP handler.
/// </summary>
public sealed record WSyntaxNode(
    string Kind, string? Name, WSourceSpan Span, bool IsMissing, bool IsError, string? Leaf, WSyntaxNode[] Children);

/// <summary>Input shape: one open document (uri + full text).</summary>
public sealed record WSourceFileDto(string Uri, string Text);

/// <summary>Source-generated (trim-safe) serialization context for the language-service DTOs.</summary>
// MaxDepth 256 lifts the System.Text.Json default (64) well above any realistic model (#1098): the
// WSyntaxNode projection nests {…, "children": […]} ~2× per tree level, so a deep expression chain
// (~32+ levels) would otherwise throw, the [JSExport] SyntaxTree catch returns the literal "null", and
// Studio's syntax-tree panel silently blanks. Kept identical to the stdio LSP host (SerializerOptions)
// so both serialize the same wire shape at the same ceiling (~127 tree levels).
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, MaxDepth = 256)]
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
[JsonSerializable(typeof(WSyntaxNode))]
internal sealed partial class LangJson : JsonSerializerContext;
