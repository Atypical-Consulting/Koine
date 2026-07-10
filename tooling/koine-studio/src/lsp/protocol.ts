// LSP protocol DTOs — the wire contract mirrored from the server (the desktop `koine lsp` child and the
// in-browser WASM server). Split out of lsp.ts so the ~23 type-only importers depend on these record
// shapes alone, not on the 845-line KoineLsp client: a DTO tweak now rechecks just this leaf module, and
// importing a 5-field interface no longer pulls the whole client transitively. The client (lsp.ts)
// re-exports everything here, so `import type { … } from '@/lsp/lsp'` keeps resolving unchanged.

export interface Position {
  line: number; // 0-based
  character: number; // 0-based
}
export interface Range {
  start: Position;
  end: Position;
}
export interface LspDiagnostic {
  range: Range;
  severity?: 1 | 2 | 3 | 4; // 1=error, 2=warning, 3=info, 4=hint
  code?: string | number;
  message: string;
}
export interface EmitFile {
  path: string;
  contents: string;
  /** The file's DDD stereotype slug (matches a `--koi-ddd-*` token), or null for infra/runtime files.
   *  Populated by the C# emitter (the primary target); other targets currently omit it. Drives the
   *  Output file-rail's per-file tint (concept-7 "Flush"). */
  kind?: string | null;
}
export interface EmitPreviewResult {
  target: string;
  files: EmitFile[];
  diagnostics: LspDiagnostic[];
  error: string | null;
}

export interface GlossaryResult {
  markdown: string;
}

export interface AclMapping {
  upstreamContext: string;
  upstreamType: string;
  localContext: string;
  localType: string;
}
export interface ContextRelation {
  upstream: string;
  downstream: string;
  kind: string;
  bidirectional: boolean;
  sharedTypes: string[];
  acl: AclMapping[];
}
export interface ContextMapResult {
  contexts: string[];
  relations: ContextRelation[];
  // Additive (#290): each declared context's declaration source span (the raw 1-based span over the
  // `context` name token), keyed by context name; null on a recovered parse. Lets the context-map graph
  // jump to the `.koi` declaration on a context-node click. Optional so older payloads still parse.
  contextSpans?: Record<string, SourceSpan | null>;
}

// `koine/glossaryModel`: one entry per context/type, with doc presence (for coverage) and the
// name's range. `doc` is null when the declaration is undocumented.
export interface GlossaryEntry {
  id: string;
  name: string;
  kind: string;
  context: string;
  qualifiedName: string;
  doc: string | null;
  nameRange: Range;
}
export interface GlossaryModel {
  entries: GlossaryEntry[];
}

// `koine/model*` (round-trip seam, #91): the structured model graph an editor drives forms/canvases
// from. The contract is additive-only — new fields are appended, existing ones never repurposed.
// A `ModelNode` is one declaration (the `model` root, a `context`, an aggregate/entity/value/enum/
// event, a state machine, or the context map); a `ModelMember` is one editable leaf (a field, enum
// member, transition, or relation). A `transition` member reuses the generic leaf fields:
// name=from-state, value=to-state, type=guard, and `via`=the correlated triggering command (#1163).
export interface ModelMember {
  kind: string;
  name: string;
  type: string | null;
  value: string | null;
  // Additive (#1163): a `transition` member's correlated triggering command (the command whose body
  // drives the edge's `to` state); null for an uncorrelated edge and for every non-transition kind.
  // Optional so older `koine/model*` payloads (without it) still conform.
  via?: string | null;
}
export interface ModelNode {
  kind: string;
  qualifiedName: string;
  title: string;
  members: ModelMember[];
  children: ModelNode[];
  // Additive (#1163): for an entity/aggregate owner node, the flattened per-edge state transitions —
  // the same edges the nested `states` child lists, surfaced here so a consumer needn't reconstruct
  // ownership from the `.states.<field>` qualifiedName. [] for every node with no state machine.
  // Optional (like `via` above) so a pre-#1163 payload still conforms — read it as `transitions ?? []`.
  transitions?: ModelMember[];
}
export interface ModelMembersResult {
  members: ModelMember[];
}

// A scoped structural edit against the model. `kind` is one of: 'renameMember' | 'addField' |
// 'removeMember' | 'changeFieldType' | 'addTransition' | 'addType' | 'addAggregateMember' |
// 'removeType'. `target` is the qualified name the edit applies to (a context for addType, an aggregate
// for addAggregateMember); `name`/`type` carry the new name / field type / construct kind per kind.
export interface StructuredEdit {
  kind: string;
  target: string;
  name?: string | null;
  type?: string | null;
  value?: string | null;
}

// A round-trip diagnostic: the rejecting KOIxxxx with its range and owning file.
export interface ModelDiagnostic {
  code: string;
  message: string;
  range: Range;
  uri: string | null;
}

// `koine/emitKoine` result: the canonical `.koi` for the affected declaration (null when the edit
// is illegal), plus any rejecting diagnostics.
export interface EmitKoineResult {
  koine: string | null;
  diagnostics: ModelDiagnostic[];
}

// `koine/applyModelEdit` result: a span-minimal patch over just the touched declaration.
export interface ModelEditResult {
  uri: string | null;
  edits: TextEdit[];
  diagnostics: ModelDiagnostic[];
}

// `koine/setDoc` result: the file the edits apply to (null when the id is unknown) and the
// localized TextEdits that insert/replace/clear the declaration's `///` block.
export interface SetDocResult {
  uri: string | null;
  edits: TextEdit[];
}

// `koine/runScenario` result (#149): the command → events → invariant-checks timeline produced by
// the model-level interpreter (Approach B). `ok` is false when the command was rejected (a failed
// precondition), the target/operation was unknown, or the model has errors (see `notes`). Each
// `outcome` is 'passed' | 'failed' | 'indeterminate' (the last when an expression couldn't be
// evaluated — surfaced, never hidden).
export type ScenarioOutcome = 'passed' | 'failed' | 'indeterminate';
export interface ScenarioPreconditionStep {
  kind: 'requires';
  message: string | null;
  condition: string;
  outcome: ScenarioOutcome;
}
export interface ScenarioTransitionStep {
  kind: 'transition';
  field: string;
  from: string | null;
  to: string;
  isInitialization: boolean;
}
export interface ScenarioEmitStep {
  kind: 'emit';
  event: string;
  args: Record<string, string>;
}
export interface ScenarioResultStep {
  kind: 'result';
  value: string;
}
export type ScenarioStep =
  | ScenarioPreconditionStep
  | ScenarioTransitionStep
  | ScenarioEmitStep
  | ScenarioResultStep;
export interface ScenarioInvariantCheck {
  message: string | null;
  condition: string;
  outcome: ScenarioOutcome;
}
export interface ScenarioResult {
  ok: boolean;
  target: string;
  operation: string;
  steps: ScenarioStep[];
  resultingState: Record<string, string>;
  invariants: ScenarioInvariantCheck[];
  result: string | null;
  notes: string[];
}

// `koine/scenarioCatalog` result (#149): the runnable surface of the workspace — the entities that
// expose at least one command/factory, with their operations (and parameters) and their stored fields.
// The panel turns this into target/operation dropdowns and a given-state / args scaffold.
export interface ScenarioParam {
  name: string;
  type: string;
}
export interface ScenarioOperation {
  name: string;
  kind: 'command' | 'factory';
  params: ScenarioParam[];
  returns: string | null;
}
export interface ScenarioField {
  name: string;
  type: string;
  optional: boolean;
}
export interface ScenarioTarget {
  name: string;
  operations: ScenarioOperation[];
  fields: ScenarioField[];
}
export interface ScenarioCatalog {
  targets: ScenarioTarget[];
}

// Standard LSP Hover. `contents` is a MarkupContent ({kind,value}), a MarkedString
// (string | {language,value}), or an array of those. `range` is optional.
export interface MarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}
export type MarkedString = string | { language: string; value: string };
export interface HoverResult {
  contents: MarkupContent | MarkedString | MarkedString[];
  range?: Range;
}

// Standard LSP completion. `kind` is the numeric CompletionItemKind (14=Keyword, 7=Class,
// 13=Enum, 20=EnumMember, 5=Field, 10=Property, 2=Method, …).
export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string | null;
  documentation?: string | null;
  // Snippet support: insertText is the body, insertTextFormat 2 = snippet (1/undefined = plaintext).
  insertText?: string | null;
  insertTextFormat?: number | null;
  // Characters that commit this item when typed; sortText orders the list (prefix < subsequence);
  // data is an opaque round-trip token for completionItem/resolve.
  commitCharacters?: string[] | null;
  sortText?: string | null;
  data?: string | null;
}
export interface CompletionList {
  isIncomplete: boolean;
  items: CompletionItem[];
}

// Standard LSP Location: a uri + a range within it. `definition` may resolve to one,
// an array, or null.
export interface Location {
  uri: string;
  range: Range;
}

// Standard LSP signature help (mirrors WASM WSignatureHelp / the desktop LSP). Koine has
// no overloads, so `signatures` always holds exactly one entry.
export interface ParameterInformation {
  label: string;
}
export interface SignatureInformation {
  label: string;
  parameters: ParameterInformation[];
}
export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature: number;
  activeParameter: number;
}

// Standard LSP DocumentSymbol tree. `kind` is the SymbolKind number (e.g. 5=Class,
// 10=Enum, 22=EnumMember, 8=Field, 6=Method, 23=Struct, 13=Variable, 3=Namespace).
export interface DocumentSymbol {
  name: string;
  kind: number;
  range: Range;
  selectionRange: Range;
  children?: DocumentSymbol[];
}

// Standard LSP SymbolInformation (flat, workspace-wide): the `workspace/symbol` result.
// `kind` is the SymbolKind number (same scheme as DocumentSymbol). `containerName` is the
// name of the enclosing declaration (a type's context, or a member's type).
export interface WorkspaceSymbol {
  name: string;
  kind: number;
  uri: string;
  range: Range;
  containerName?: string;
}

// Standard LSP FoldingRange: a collapsible region. `startLine`/`endLine` are 0-based and both
// inclusive (the `textDocument/foldingRange` result), one per multi-line block declaration.
export interface FoldingRange {
  startLine: number;
  endLine: number;
}

// Standard LSP SelectionRange (recursive): the range the editor expands to, plus the enclosing
// `parent` range it grows into next (the `textDocument/selectionRange` result, one chain per
// requested position, innermost first).
export interface SelectionRange {
  range: Range;
  parent?: SelectionRange;
}

// Standard LSP CodeLens: an annotation pinned to `range` (a declaration's identifier span) whose
// `command.title` is the reference-count label (`"N references"`, references-from-elsewhere). The
// server fills the title eagerly, so `command` is present on the `textDocument/codeLens` result and
// `codeLens/resolve` is a pass-through.
export interface CodeLens {
  range: Range;
  command?: { title: string; command: string };
}

// Standard LSP InlayHint: an inline annotation pinned at `position`. `kind` is the numeric
// InlayHintKind (1=Type, 2=Parameter); the editor styles/places the widget per kind.
export interface InlayHint {
  position: Position;
  label: string;
  kind: number;
}

// Standard LSP CallHierarchyItem: one node in the call graph (a Command/Method or an Event). `kind`
// is the SymbolKind number (6=Method/Command, 24=Event). `data` is an opaque round-trip blob the
// server fills on prepare and reads back on incoming/outgoing — it MUST be echoed back unchanged.
export interface CallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: Range;
  selectionRange: Range;
  data?: unknown;
}

// Standard LSP CallHierarchyIncomingCall: a caller (`from`) and the ranges within it that call.
export interface CallHierarchyIncomingCall {
  from: CallHierarchyItem;
  fromRanges: Range[];
}

// Standard LSP CallHierarchyOutgoingCall: a callee (`to`) and the call-site ranges within the item.
export interface CallHierarchyOutgoingCall {
  to: CallHierarchyItem;
  fromRanges: Range[];
}

// Standard LSP TextEdit: replace `range` with `newText`.
export interface TextEdit {
  range: Range;
  newText: string;
}

// Standard LSP semantic tokens (full document). `data` is the delta-encoded int stream: groups of 5
// ints `[deltaLine, deltaStartChar, length, tokenType, tokenModifiers]`, deltas relative to the
// previous token (deltaStartChar is relative to the previous token's start on the same line, else
// absolute; the first token's deltas are absolute from (0,0)). `tokenType` indexes the legend (see
// SEMANTIC_TOKEN_TYPES in @/editor/editor — SemanticTokenProvider.TokenTypeNames in C#);
// `tokenModifiers` is a bitset (bit 0 = declaration). `resultId` supports delta requests we don't use.
export interface SemanticTokens {
  data: number[];
  resultId?: string | null;
}

// `koine/check` change record (mirrors the server contract).
export interface CheckChange {
  impact: 'Breaking' | 'NonBreaking';
  code: string;
  message: string;
}

// `koine/check` result. `error` is set when the baseline could not be read/compiled;
// otherwise `hasBreakingChanges` + `changes` describe the diff.
export interface CheckResult {
  error?: string;
  hasBreakingChanges: boolean;
  changes: CheckChange[];
}

// Standard LSP WorkspaceEdit: text edits grouped by the file:// uri they apply to. `idCoRename` and
// `leftBehindIdName` ride along only on a `textDocument/rename` response — the authoritative outcome of
// any convention-linked `<Root>Id` identity co-rename (#550), mirroring the server's
// Koine.Compiler.Services.IdCoRenameOutcome — so `renameStatusMessage` (model/inspector.ts) doesn't have
// to re-derive that decision from rendered text (#565 follow-up). Both are absent/undefined on every
// other WorkspaceEdit-shaped payload (code actions, model edits).
export interface WorkspaceEdit {
  changes: Record<string, TextEdit[]>;
  idCoRename?: 'Applied' | 'LeftBehind' | null;
  leftBehindIdName?: string | null;
}

// Standard LSP CodeAction: a titled quickfix/refactor carrying an inline WorkspaceEdit.
export interface CodeAction {
  title: string;
  kind: string;
  edit?: WorkspaceEdit;
  diagnostics?: LspDiagnostic[];
}

// Standard LSP prepareRename answer: the editable identifier range + the current name to pre-fill.
export interface PrepareRenameResult {
  range: Range;
  placeholder?: string;
}

// `koine/docs` result: one living-documentation file (Mermaid-in-Markdown) per emitted page.
export interface DocsFile {
  path: string;
  contents: string;
  diagrams: Diagram[]; // the structured graphs riding alongside this file's Mermaid (issue #93); [] if none
}
export interface DocsResult {
  files: DocsFile[];
}

// --- structured diagram graphs (issue #93) -----------------------------------
// Each Mermaid diagram in a DocsFile is accompanied by a source-aware Diagram: a graph of nodes
// (which carry a qualifiedName + raw 1-based sourceSpan for jump-to-source) and the edges between
// them. Field names mirror the C# DTOs (LSP dict keys + WASM W* records) verbatim.

/** A raw, 1-based source span (NOT a 0-based LSP range). End line/column are end-exclusive. */
export interface SourceSpan {
  file: string | null; // the source .koi uri the node was declared in
  line: number; // 1-based start line
  column: number; // 1-based start column
  endLine: number; // 1-based, end-exclusive
  endColumn: number; // 1-based, end-exclusive
  offset: number; // 0-based absolute character offset of the first character
  length: number; // character length
}

/** One UML class-body row: a pre-formatted text and which compartment it belongs to. */
export interface DiagramMember {
  text: string; // pre-formatted row, e.g. 'id: OrderId', 'submit()', or an enum value 'Draft'
  kind: string; // compartment: 'field' (attributes incl. id/version) | 'method' | 'value' (enum members)
}

/** One graph node: an aggregate, value object, state, context, integration event, … */
export interface DiagramNode {
  id: string; // stable identifier, unique within the owning graph
  label: string; // display text shown on the diagram
  kind: string; // styling category, e.g. 'aggregate-root' | 'value-object' | 'state' | 'context' | …
  qualifiedName: string; // dotted stable name, e.g. 'Ordering.Order'
  sourceSpan: SourceSpan | null; // null only when the node truly has no position
  stereotype: string | null; // UML stereotype w/o guillemets (class nodes only), e.g. 'aggregate root'
  members: DiagramMember[]; // UML class-body rows (class nodes only); [] for simple boxes
  invariants?: string[]; // business rules (value objects / entities): each invariant's message or described condition; [] / absent when none
  doc?: string | null; // the event's '///' "when this happens" description (event nodes only, issue #170); null/absent otherwise
}

/** A directed edge between two node ids in the same graph. */
export interface DiagramEdge {
  from: string; // source node id
  to: string; // target node id
  label: string | null; // optional edge label (transition guard, relation kind, publish/subscribe verb)
  cardinality?: string | null; // composition TARGET-end multiplicity, derived from the Koine field type ("1" | "0..1" | "*")
  sourceCardinality?: string | null; // composition SOURCE-end (owner) multiplicity, conventionally "1"; null for non-composition edges
  arrowKind?: string | null; // relationship style the renderer maps to a marker pair: 'composition' | 'association' | 'transition' | 'flow'
  backingMember?: string | null; // for a field-backed composition: the qualified name of the field that backs it (so the canvas can disconnect it)
}

/** The structured graph behind one diagram. */
export interface DiagramGraph {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** One diagram: the rendered Mermaid plus the structured graph that drives an interactive renderer. */
export interface Diagram {
  caption: string; // the heading the diagram appears under
  kind: string; // diagram family: 'statemachine' | 'aggregate' | 'contextmap' | 'integration-events'
  mermaid: string; // the exact Mermaid snippet embedded in the file's Markdown
  graph: DiagramGraph;
}

// --- syntax tree (`koine/syntaxTree`, issue #890) ----------------------------
// The raw parse/syntax tree of the active document — one node per grammar construct — that the
// syntax-tree panel renders and maps back to the source. Same wire shape from both hosts (the desktop
// `koine/syntaxTree` LSP request and the WASM `SyntaxTree` export). The whole response is `null` when
// the active uri is unknown/absent.

/**
 * One node of the syntax tree (recursive). `kind` is the grammar construct (e.g. `ValueObjectDecl`);
 * `name` is the declaration identifier, or null when the node has no identifier; `isMissing`/`isError`
 * flag ANTLR phantom/recovery nodes; `leaf` is a truncated source preview set only on a childless node
 * (else null). `span` is the node's RAW {@link SourceSpan} — 1-based, end-EXCLUSIVE source coordinates
 * (NOT a 0-based LSP {@link Range}) — the same span shape the diagram graph carries (consolidated in
 * #1099); the root is span-less and reads the all-zero sentinel `{ line: 0, …, file: null }`, so
 * `span.line === 0` marks a no-jump node. Example root:
 * `{ kind: 'KoineModel', name: null, span: <all-zero>, children: [...] }`.
 */
export interface SyntaxTreeNode {
  kind: string;
  name: string | null;
  span: SourceSpan; // the node's raw source range (shared with the diagram graph; all-zero on the root)
  isMissing: boolean;
  isError: boolean;
  leaf: string | null;
  children: SyntaxTreeNode[];
}
