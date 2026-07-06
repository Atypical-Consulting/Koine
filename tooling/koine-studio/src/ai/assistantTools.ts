// The Koine compiler tools the Assistant advertises to an OpenAI-compatible model (LM Studio, …) so
// it can validate/compile/format `.koi` source mid-conversation. The DEFINITIONS live here (the loop
// in ai.ts advertises them; the host in src/host executes them in-process); the result FORMATTERS are
// pure functions over the Koine.Wasm JSON shapes so they can be unit-tested and reused across hosts.
//
// Mirrors src/Koine.Mcp/Tools/{Validate,Compile,Format}Tool.cs — the same capabilities the external
// MCP server exposes, but executed by the IDE itself. `reference`/`examples` are intentionally NOT
// here: their content is already injected into the system prompt (KOINE_PRIMER + live source).
import type { ChatCompletionFunctionTool } from 'openai/resources/chat/completions';
import { newFileKey, type EditSession } from '@/ai/editSession';
import { EMIT_TARGETS, isEmitTarget } from '@/shared/emitTargets';

export type CompileTarget = string;

/**
 * The compile targets the assistant's `koine_compile` tool accepts (glossary/docs go through other
 * exports), read LIVE from the shared EMIT_TARGETS so the tool enum tracks the backend registry —
 * seeded at boot (issue #282). A FUNCTION, not a module-load snapshot: `emitTargets.ts` is replaced
 * in place at boot, so a captured-at-import constant would freeze the built-ins and never offer a
 * backend-seeded target.
 */
export function compileTargets(): string[] {
  return EMIT_TARGETS.map((t) => t.id);
}

/** Coerce an arbitrary `target` arg to a supported compile target, defaulting to csharp. */
export function normalizeCompileTarget(target: unknown): CompileTarget {
  return isEmitTarget(target) ? (target as CompileTarget) : 'csharp';
}

/** The compiler tools — executed against the WASM api / MCP sidecar. Identical to the MCP server's. */
export const KOINE_COMPILER_TOOL_NAMES = ['koine_validate', 'koine_compile', 'koine_format'] as const;
/** The host-local edit tools — dispatched against the Studio host's in-memory edit-session staging
 *  area (editSession.ts), NOT the MCP server, so they are tracked separately. */
export const KOINE_EDIT_TOOL_NAMES = ['koine_list_files', 'koine_read_file', 'koine_write_file'] as const;
/** Every tool name the assistant advertises. */
export const KOINE_TOOL_NAMES = [...KOINE_COMPILER_TOOL_NAMES, ...KOINE_EDIT_TOOL_NAMES] as const;
export type KoineToolName = (typeof KOINE_TOOL_NAMES)[number];
export type KoineEditToolName = (typeof KOINE_EDIT_TOOL_NAMES)[number];

const SOURCE_PROP = {
  type: 'string',
  description: 'The complete Koine (.koi) model source.',
} as const;

const REL_PATH_PROP = {
  type: 'string',
  description:
    'Workspace-relative path of a .koi file, exactly as shown by koine_list_files (e.g. "ordering/orders.koi"). ' +
    'Must stay inside the workspace — no absolute or ".." paths.',
} as const;

/** A provider-neutral tool definition. `inputSchema` is a JSON Schema object; the adapters below
 *  re-shape it into the OpenAI (`parameters`) / Anthropic (`input_schema`) envelopes verbatim. */
export interface NeutralTool {
  name: string;
  description: string;
  inputSchema: object;
}

/** The koine tools, target- and provider-agnostic. Single-file `source` arg (the host wraps it into
 *  the compiler's multi-file envelope). Descriptions mirror the MCP tool `[Description]` strings.
 *  A FUNCTION (not a const) so the `koine_compile` enum is built from the LIVE {@link compileTargets}
 *  each time the tool list is assembled — a const would freeze the enum at import, before the backend
 *  seed (issue #282), and never offer a backend-seeded target to the model. */
export function koineToolDefs(): NeutralTool[] {
  return [
  {
    name: 'koine_validate',
    description:
      'Validate Koine (.koi) source and return diagnostics (errors and warnings with line:column). ' +
      'Use this to check a model you are drafting; keep fixing the source and re-validating until it reports ok.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { source: SOURCE_PROP },
      required: ['source'],
    },
  },
  {
    name: 'koine_compile',
    description:
      'Compile Koine (.koi) source to a target language and return the generated files (or compile errors). ' +
      'Use this to inspect the emitted code for a model.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        source: SOURCE_PROP,
        target: {
          type: 'string',
          enum: compileTargets(),
          description: 'The target language to emit. Defaults to csharp.',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'koine_format',
    description: 'Return the canonically-formatted version of Koine (.koi) source.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { source: SOURCE_PROP },
      required: ['source'],
    },
  },
  {
    name: 'koine_list_files',
    description:
      'List the workspace .koi files the assistant may read or edit, by their workspace-relative paths.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'koine_read_file',
    description: 'Read the current contents of one workspace .koi file by its workspace-relative path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { relPath: REL_PATH_PROP },
      required: ['relPath'],
    },
  },
  {
    name: 'koine_write_file',
    description:
      'Stage new full-file contents for one workspace .koi file (creating it if new). The write is ' +
      'STAGED for the user to review and apply — it does NOT touch disk. Call once per file you want to change.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        relPath: REL_PATH_PROP,
        contents: { type: 'string', description: 'The complete new file contents.' },
      },
      required: ['relPath', 'contents'],
    },
  },
  ];
}

/** Adapt a neutral def to an OpenAI function tool (`parameters` carries the JSON Schema). The cast
 *  bridges the neutral `object` schema to OpenAI's `FunctionParameters` (an indexed record). */
export function toOpenAiTool(t: NeutralTool): ChatCompletionFunctionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  };
}

/** Adapt a neutral def to an Anthropic tool (`input_schema` carries the JSON Schema). The schema is
 *  passed through by reference — Anthropic's `input_schema` is the same JSON Schema, no rewrite. */
export function toAnthropicTool(t: NeutralTool): { name: string; description: string; input_schema: object } {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

/** The OpenAI `tools` array, derived from the neutral defs. A function (not a const) so the
 *  `koine_compile` enum reflects the live target list each call (issue #282). */
export function koineTools(): ChatCompletionFunctionTool[] {
  return koineToolDefs().map(toOpenAiTool);
}

// --- Koine.Wasm JSON shapes (camelCase, see src/Koine.Wasm/CompilerInterop.LanguageService.cs) -----

interface WPosition {
  line: number;
  character: number;
}
interface WRange {
  start: WPosition;
  end: WPosition;
}
/** LSP diagnostic: severity 1=Error 2=Warning 3=Info 4=Hint; lines are 0-based. */
export interface WDiagnostic {
  range: WRange;
  severity: number;
  code?: string | null;
  message: string;
}
/** One `{uri, diagnostics}` bucket as returned by DiagnoseWorkspace. */
export interface WFileDiagnostics {
  uri: string;
  diagnostics: WDiagnostic[];
}
/** One emitted file as returned by EmitPreview. */
export interface WEmitFile {
  path: string;
  contents: string;
}
/** The EmitPreview result. */
export interface WEmitPreviewResult {
  target: string;
  files: WEmitFile[];
  diagnostics: WDiagnostic[];
  error?: string | null;
}

const SEVERITY = ['', 'error', 'warning', 'info', 'hint'] as const;

/** One diagnostic as a `- [error] line:col message` line (1-based, like the editor gutter). */
function diagLine(d: WDiagnostic): string {
  const sev = SEVERITY[d.severity] ?? 'info';
  const line = d.range.start.line + 1;
  const col = d.range.start.character + 1;
  return `- [${sev}] ${line}:${col} ${d.message}`;
}

/** Summarize a DiagnoseWorkspace result for the model: an ok flag plus the diagnostic list. */
export function formatValidate(buckets: WFileDiagnostics[]): string {
  const all = buckets.flatMap((b) => b.diagnostics ?? []);
  if (!all.length) return 'ok: true — no diagnostics. The model compiles.';
  const errors = all.filter((d) => d.severity === 1).length;
  const warnings = all.filter((d) => d.severity === 2).length;
  return `ok: false — ${errors} error(s), ${warnings} warning(s):\n${all.map(diagLine).join('\n')}`;
}

// --- desktop (MCP) koine_validate normalization (issue #445) -----------------
// The browser host runs koine_validate in-WASM and formats it with formatValidate (above). The Tauri
// DESKTOP host instead proxies koine_validate to the `koine mcp --http` sidecar, which returns the MCP
// ValidateTool JSON payload ({ ok, errorCount, warningCount, diagnostics[] }, see src/Koine.Mcp/Models.cs)
// — a DIFFERENT shape. The apply-gate's parseValidationOutcome only understands the browser `ok:` string,
// so the desktop host normalizes the payload back to that exact string here, keeping ONE validation
// contract rather than teaching the parser two formats.

/** One MCP `DiagnosticInfo` (Koine.Mcp/Models.cs): a STRING severity and an ALREADY-1-based line/column.
 *  Only severity/message/line/column are read here; the rest of the payload's fields are modelled as
 *  optional so a full DiagnosticInfo passes the type checker without being needed. */
export interface McpDiagnostic {
  severity: string;
  message: string;
  line: number;
  column: number;
  code?: string;
  file?: string | null;
  endLine?: number;
  endColumn?: number;
}

/** The MCP `koine_validate` result payload (Koine.Mcp `ValidationResult`). */
export interface McpValidationResult {
  ok: boolean;
  errorCount: number;
  warningCount: number;
  diagnostics: McpDiagnostic[];
}

/** One MCP diagnostic as a `- [severity] line:col message` line. Unlike {@link diagLine}, the severity
 *  is already a string and the line/column are already 1-based, so neither is remapped. */
function mcpDiagLine(d: McpDiagnostic): string {
  return `- [${d.severity}] ${d.line}:${d.column} ${d.message}`;
}

/**
 * Map an MCP {@link McpValidationResult} to the EXACT browser {@link formatValidate} string, so a single
 * {@link parseValidationOutcome} reads either host's koine_validate result. Byte-for-byte with the
 * browser: no diagnostics ⇒ `ok: true — no diagnostics. The model compiles.`; otherwise the
 * `ok: false — E error(s), W warning(s):` header followed by one diagnostic line each (a warnings-only
 * payload reports 0 errors, so the apply-gate still treats it as applicable).
 */
export function formatMcpValidate(payload: McpValidationResult): string {
  const all = payload.diagnostics ?? [];
  if (!all.length) return 'ok: true — no diagnostics. The model compiles.';
  const errors = payload.errorCount ?? 0;
  const warnings = payload.warningCount ?? 0;
  return `ok: false — ${errors} error(s), ${warnings} warning(s):\n${all.map(mcpDiagLine).join('\n')}`;
}

/**
 * Normalize a RAW desktop koine_validate result string (the MCP ValidateTool JSON the sidecar returns)
 * into the browser `ok:` contract. Fails CLOSED: non-JSON text (e.g. an `Error: …` string) or a JSON
 * value of an unexpected shape is returned unchanged — which parseValidationOutcome reads as
 * not-parsing, surfacing a single failed validate (never an infinite repair loop; repairToValid is
 * bounded). Only the desktop host needs this; the browser host already emits the `ok:` string.
 */
export function normalizeMcpValidate(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // not JSON → fail closed
  }
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof (parsed as McpValidationResult).errorCount === 'number' &&
    Array.isArray((parsed as McpValidationResult).diagnostics)
  ) {
    return formatMcpValidate(parsed as McpValidationResult);
  }
  return raw; // unexpected shape → fail closed
}

/** Summarize an EmitPreview result for the model: the emitted files, or the error/diagnostics. */
export function formatCompile(res: WEmitPreviewResult): string {
  if (res.error) return `compile failed: ${res.error}`;
  const errors = (res.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length) {
    return `compile failed — ${errors.length} error(s):\n${errors.map(diagLine).join('\n')}`;
  }
  const files = res.files ?? [];
  if (!files.length) return `compiled to ${res.target}: no files emitted.`;
  return (
    `compiled to ${res.target} — ${files.length} file(s):\n\n` +
    files.map((f) => `// ${f.path}\n${f.contents}`).join('\n\n')
  );
}

// --- edit-tool result formatters (host-staged, see editSession.ts) -----------

/** Render a koine_list_files result: the workspace-relative .koi paths the model may touch. */
export function formatListFiles(relPaths: string[]): string {
  if (!relPaths.length) return 'no .koi files in the workspace.';
  return `${relPaths.length} file(s):\n${relPaths.map((p) => `- ${p}`).join('\n')}`;
}

/** Render a koine_read_file result: the file body, or a not-found line when contents is null. */
export function formatReadFile(relPath: string, contents: string | null): string {
  if (contents === null) return `not found: ${relPath}`;
  return `${relPath}:\n${contents}`;
}

/** Render a koine_write_file confirmation: the file was STAGED (not written to disk yet). */
export function formatWriteFile(relPath: string, isNew: boolean): string {
  return `staged ${isNew ? 'new file' : 'changes to'} ${relPath} (not yet written to disk).`;
}

/**
 * The bidirectional display-path ⇄ session-key index for one edit-tool dispatch (#472). Session keys
 * are OPAQUE (buffer uris in a multi-root workspace; relPaths in single-root/legacy sessions), so the
 * model addresses files by workspace-relative DISPLAY paths: a relPath held by exactly one key
 * displays as itself, and a relPath shared by several keys (the same path under two roots) is
 * disambiguated as `relPath@1`, `relPath@2`, … in `session.list()` order — deterministic (list order
 * is snapshot order then stage order) and reversible through `keyFor`. A suffix candidate that
 * collides with a REAL relPath (a file literally named `model.koi@1`) is skipped, so every display
 * names exactly one key. Rebuilt per dispatch so newly-staged files are immediately addressable.
 */
export interface DisplayIndex {
  /** display path → session key. */
  keyFor: Map<string, string>;
  /** session key → display path, in `session.list()` order. */
  displayFor: Map<string, string>;
  /** relPaths held by MORE than one key (a bare mention is ambiguous) → their disambiguated displays. */
  ambiguous: Map<string, string[]>;
}

/** Build the {@link DisplayIndex} over the session's current keys. */
export function buildDisplayIndex(session: EditSession): DisplayIndex {
  const keys = session.list();
  const rels = keys.map((k) => session.relPathOf(k));
  const counts = new Map<string, number>();
  for (const rel of rels) counts.set(rel, (counts.get(rel) ?? 0) + 1);
  const keyFor = new Map<string, string>();
  const displayFor = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  keys.forEach((key, i) => {
    const rel = rels[i];
    let display = rel;
    if ((counts.get(rel) ?? 0) > 1) {
      // Colliding relPath: index-stable `@n` markers, skipping a name already assigned or one that is
      // itself a real relPath in this workspace.
      for (let n = 1; ; n++) {
        display = `${rel}@${n}`;
        if (!keyFor.has(display) && !counts.has(display)) break;
      }
      ambiguous.set(rel, [...(ambiguous.get(rel) ?? []), display]);
    } else {
      // A unique relPath displays as itself; the (pathological) case where an earlier suffix already
      // took the name falls back to the same marker scheme.
      for (let n = 1; keyFor.has(display); n++) display = `${rel}@${n}`;
    }
    keyFor.set(display, key);
    displayFor.set(key, display);
  });
  return { keyFor, displayFor, ambiguous };
}

/** One staged-workspace validation entry: the disambiguated display path plus the current
 *  (staged-or-initial) body. See {@link stagedWorkspaceFiles}. */
export interface StagedWorkspaceFile {
  display: string;
  text: string;
}

/**
 * Enumerate the session's files for the once-per-turn staged-workspace validation (issue #474),
 * labelled by the SAME disambiguated display paths the edit tools use ({@link buildDisplayIndex}) —
 * the ONE derivation both hosts' envelopes consume (#472). Unique by construction: labelling two
 * roots' same-named files by their bare relPath would send duplicate uris/paths, which the compiler's
 * DiagnoseWorkspace rejects (its Uri-keyed ToDictionary throws), turning EVERY multi-root staged
 * validation into a "(validation failed)" diagnostic. Diagnostics also come back named with the same
 * labels the model and the change-set review use.
 */
export function stagedWorkspaceFiles(session: EditSession): StagedWorkspaceFile[] {
  const { displayFor } = buildDisplayIndex(session);
  return session.list().map((key) => ({
    display: displayFor.get(key) ?? session.relPathOf(key),
    text: session.read(key) ?? '',
  }));
}

/** The ambiguity refusal for a BARE colliding relPath, or null when `path` is not ambiguous. */
function ambiguityError(index: DisplayIndex, path: string): string | null {
  const candidates = index.ambiguous.get(path);
  if (!candidates) return null;
  return `Error: ambiguous path ${path} — several workspace roots hold it. Use one of: ${candidates.join(', ')}.`;
}

/**
 * Host-independent dispatch for the staged edit tools (`koine_list_files` / `koine_read_file` /
 * `koine_write_file`) against a per-turn {@link EditSession}: parse the args, run a pure list/read, or
 * stage a write and report it. The model addresses files by the DISPLAY paths of a per-dispatch
 * {@link buildDisplayIndex} (#472): reads/writes reverse-map the display path to the session key, a
 * BARE colliding path is refused with the disambiguated candidates, and a path unknown to the index is
 * a brand-new file — its write mints a {@link newFileKey}. A `koine_write_file` is **stage-only** — it
 * returns just the {@link formatWriteFile} confirmation and does NOT validate, so staging M files over
 * an N-file workspace no longer pays M whole-workspace re-compiles (≈O(M×N)). The
 * whole-staged-workspace validation now runs ONCE per agentic turn, after the loop terminates (see
 * `runToolLoop` in `ai.ts`, issue #474), where the host's turn-scoped validator compiles the final
 * staged set a single time (O(N)). Never throws — bad JSON, an unsafe/non-`.koi` relPath (the
 * session's `stage` guard throws), or an unknown tool all resolve to an error string the model can
 * read and recover from.
 */
export async function runEditToolStaging(
  name: string,
  argsJson: string,
  session: EditSession,
): Promise<string> {
  let args: { relPath?: unknown; contents?: unknown };
  try {
    args = JSON.parse(argsJson || '{}');
  } catch {
    return 'Error: the tool arguments were not valid JSON.';
  }
  try {
    switch (name) {
      case 'koine_list_files':
        return formatListFiles([...buildDisplayIndex(session).displayFor.values()]);
      case 'koine_read_file': {
        const path = typeof args.relPath === 'string' ? args.relPath : '';
        const index = buildDisplayIndex(session);
        const ambiguous = ambiguityError(index, path);
        if (ambiguous) return ambiguous;
        // An unknown display path reads through as-is: `read` resolves a raw key leniently and
        // returns null for a genuinely unknown path (→ "not found").
        return formatReadFile(path, session.read(index.keyFor.get(path) ?? path));
      }
      case 'koine_write_file': {
        const path = typeof args.relPath === 'string' ? args.relPath : '';
        const contents = typeof args.contents === 'string' ? args.contents : '';
        const index = buildDisplayIndex(session);
        const ambiguous = ambiguityError(index, path);
        if (ambiguous) return ambiguous;
        // A path the index doesn't know is a brand-new file: mint its own session key (#472). The
        // session's stage guard validates the RESOLVED relPath (safety + `.koi`-only).
        const key = index.keyFor.get(path) ?? newFileKey(path);
        session.stage(key, contents);
        // Stage-only: the staged set is validated once at end of turn, not after every write.
        return formatWriteFile(path, session.isNew(key));
      }
      default:
        return `Error: unknown tool ${name}.`;
    }
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** A short, single-line status for the inline tool-call line in the transcript. */
export function summarizeForChip(_name: string, result: string): string {
  const firstLine = result.split('\n').find((l) => l.trim().length) ?? '';
  return firstLine.length > 88 ? firstLine.slice(0, 87) + '…' : firstLine;
}

// --- shared assistant primer -------------------------------------------------
// A concise Koine primer so the model emits valid `.koi`. Mirrors README's construct table. It lives
// here (a pure, DOM-free module) rather than next to the chat panel so BOTH the chat assistant and the
// inline (ghost-text) completion client can prime the model with the same language description without
// the testable client pulling in the panel's Preact/DOM dependencies.
export const KOINE_PRIMER = `You are an expert assistant embedded in Koine Studio, the IDE for **Koine** — a
domain-specific language for Domain-Driven Design. A Koine model compiles to idiomatic C#/TypeScript.

Koine essentials:
- A model is one or more \`context Name { ... }\` bounded contexts.
- \`value Name { field: Type  invariant <expr> "message" }\` — immutable value objects with invariants.
- \`enum Name { A, B, C }\` — closed sets.
- \`entity Name identified by NameId { field: Type ... }\` — entities with identity.
- \`aggregate Name root RootEntity { ...nested value/enum/entity... }\` — consistency boundaries.
- Inside an entity: \`command Verb(...) requires <guard>\`, \`create ...\`, \`emit Event(...)\`,
  and \`states EnumType { A -> B  B -> C }\` state machines.
- \`event Name { field: Type }\` and \`integration event Name { ... }\` (cross-context).
- \`spec Name on Type = <bool expr>\`, \`service Name { operation ...  usecase ... }\`, \`policy ...\`.
- \`repository\`, \`readmodel\`, \`query\` for the application/CQRS layer.
- \`contextmap { Upstream -> Downstream : conformist | shared-kernel { T } | anti-corruption-layer ... }\`.
- Primitive types: String, Int, Decimal, Bool, Instant. Collections: List<T>, Set<T>, Map<K,V>, Range.
- Defaults: \`status: OrderStatus = Draft\`. Computed: \`subtotal: Money = unitPrice * quantity\`.

When you write or revise a model, output the COMPLETE model in a single \`\`\`koine fenced code block so the
user can apply it in one click. Keep prose tight and DDD-focused.`;
