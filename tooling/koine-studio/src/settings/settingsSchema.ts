// DOM-free. Owns the Draft 2020-12 schema for the editable settings.json document plus the
// serialization helpers. The secret aiApiKey is NEVER declared, serialized, or accepted here:
// the schema is additionalProperties:false and the parser re-injects the live in-memory key.
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import { isEmitTarget } from '@/shared/emitTargets';
import { DEFAULT_SETTINGS, type Settings } from './persistence';

// --- the field map: the single source of truth (#750) ------------------------
// One declarative table maps each runtime `Settings` key to its VS Code-style namespaced
// position in the editable JSON document (`group.docKey`). The serializer, the parser, the
// nested JSON Schema, and the parity test all DERIVE from this table, so the three-way drift
// the old code risked (Settings type vs schema vs serializer) is structurally impossible and a
// new setting is one row. The runtime type stays FLAT — only the *document* the user edits is
// grouped — so no localStorage migration and no churn to the ~63 `settings.<field>` read sites.
//
// The secret `aiApiKey` is deliberately absent here (as in the schema and document); the parser
// re-injects the live in-memory key. A later switch to dotted-flat keys ("editor.fontSize") is a
// one-function change to the serializer, since the map already carries the group + key.

/** The VS Code-style namespaces the settings document groups its fields under. */
export type SettingsGroup = 'appearance' | 'editor' | 'ai' | 'mcp' | 'preview' | 'lsp' | 'account' | 'terminal';

/** One row of the field map: a runtime key placed at `group.docKey` in the JSON document. */
export interface FieldDef {
  runtimeKey: Exclude<keyof Settings, 'aiApiKey'>;
  group: SettingsGroup;
  docKey: string;
}

/**
 * Every non-secret `Settings` key, in document order. Most doc keys match the runtime key; the
 * few that differ (e.g. runtime `enableMinimap` → doc `editor.minimap`, `aiProvider` → `ai.provider`)
 * are the renames that live ONLY in the document — the runtime field names never change.
 */
export const SETTINGS_FIELDS: readonly FieldDef[] = [
  { runtimeKey: 'theme', group: 'appearance', docKey: 'theme' },
  { runtimeKey: 'accent', group: 'appearance', docKey: 'accent' },
  { runtimeKey: 'reduceMotion', group: 'appearance', docKey: 'reduceMotion' },
  { runtimeKey: 'fontFamily', group: 'appearance', docKey: 'fontFamily' },
  { runtimeKey: 'fontSize', group: 'editor', docKey: 'fontSize' },
  { runtimeKey: 'lineHeight', group: 'editor', docKey: 'lineHeight' },
  { runtimeKey: 'wordWrap', group: 'editor', docKey: 'wordWrap' },
  { runtimeKey: 'tabSize', group: 'editor', docKey: 'tabSize' },
  { runtimeKey: 'formatOnSave', group: 'editor', docKey: 'formatOnSave' },
  { runtimeKey: 'autoSave', group: 'editor', docKey: 'autoSave' },
  { runtimeKey: 'enableMinimap', group: 'editor', docKey: 'minimap' },
  { runtimeKey: 'defaultCanvasZoom', group: 'editor', docKey: 'defaultCanvasZoom' },
  { runtimeKey: 'aiProvider', group: 'ai', docKey: 'provider' },
  { runtimeKey: 'aiBaseUrl', group: 'ai', docKey: 'baseUrl' },
  { runtimeKey: 'aiModel', group: 'ai', docKey: 'model' },
  { runtimeKey: 'aiModelOpenai', group: 'ai', docKey: 'modelOpenai' },
  { runtimeKey: 'aiAgenticTools', group: 'ai', docKey: 'agenticTools' },
  { runtimeKey: 'aiInlineCompletions', group: 'ai', docKey: 'inlineCompletions' },
  { runtimeKey: 'aiConstrainGrammar', group: 'ai', docKey: 'constrainGrammar' },
  { runtimeKey: 'aiTemperature', group: 'ai', docKey: 'temperature' },
  { runtimeKey: 'mcpEnabled', group: 'mcp', docKey: 'enabled' },
  { runtimeKey: 'mcpClient', group: 'mcp', docKey: 'client' },
  { runtimeKey: 'previewTarget', group: 'preview', docKey: 'target' },
  { runtimeKey: 'lspTrace', group: 'lsp', docKey: 'trace' },
  { runtimeKey: 'displayName', group: 'account', docKey: 'displayName' },
  { runtimeKey: 'terminalShellArgs', group: 'terminal', docKey: 'shellArgs' },
];

// --- per-field leaf schemas -------------------------------------------------
// One leaf schema per runtime key, carrying its type/enum/bounds (mirroring the editor input bounds
// in persistence.ts and the enum rosters AccentName/McpClientId/lspTrace/aiProvider) plus a
// VS Code-style `title`/`description` — the seed for JSON-editor hovers/IntelliSense (surfacing them
// in the editor UI is a follow-up). Both the nested document schema and the legacy flat schema are
// built from these, keyed by runtime key, so they can never drift from the field map.
type LeafSchema = Record<string, unknown>;

const LEAF_SCHEMAS: Record<FieldDef['runtimeKey'], LeafSchema> = {
  theme: { type: 'string', enum: ['dark', 'light'], title: 'Theme', description: 'Studio color theme.' },
  accent: {
    type: 'string',
    enum: ['blue', 'teal', 'violet', 'amber'],
    title: 'Accent',
    description: 'Accent hue applied over the active theme.',
  },
  reduceMotion: { type: 'boolean', title: 'Reduce motion', description: 'Collapse UI animations and transitions.' },
  fontFamily: {
    type: 'string',
    title: 'Editor font',
    description: 'Editor font stack (CSS font-family). Empty uses the theme default.',
  },
  fontSize: { type: 'number', minimum: 10, maximum: 22, title: 'Font size', description: 'Editor text size in pixels.' },
  lineHeight: {
    type: 'number',
    minimum: 1.2,
    maximum: 2.4,
    title: 'Line height',
    description: 'Editor line height as a multiple of the font size.',
  },
  wordWrap: { type: 'boolean', title: 'Word wrap', description: 'Soft-wrap long editor lines.' },
  tabSize: { type: 'integer', minimum: 1, maximum: 8, title: 'Tab size', description: 'Indent width in spaces.' },
  formatOnSave: { type: 'boolean', title: 'Format on save', description: 'Run the formatter when a file is saved.' },
  autoSave: { type: 'boolean', title: 'Auto save', description: 'Persist dirty buffers automatically after a short idle.' },
  enableMinimap: { type: 'boolean', title: 'Minimap', description: 'Show the editor minimap (document overview).' },
  defaultCanvasZoom: {
    // `number`, not `integer`: the Visual control and the load-time clamp keep a finite value as-is (like
    // fontSize/lineHeight/temperature), so the JSON editor must accept the same — an `integer` schema would
    // reject a fractional zoom the number control could persist (#762). The readout rounds for display.
    type: 'number',
    minimum: 10,
    maximum: 800,
    title: 'Default canvas zoom',
    description: 'Initial zoom (%) for a freshly-opened domain diagram canvas.',
  },
  aiProvider: {
    type: 'string',
    enum: ['anthropic', 'openai'],
    title: 'Provider',
    description: 'Which AI backend the assistant uses.',
  },
  aiBaseUrl: { type: 'string', title: 'Base URL', description: 'Base URL for the OpenAI-compatible provider.' },
  aiModel: { type: 'string', title: 'Model (Anthropic)', description: 'Anthropic model id.' },
  aiModelOpenai: { type: 'string', title: 'Model (OpenAI)', description: 'OpenAI-compatible model id.' },
  aiAgenticTools: {
    type: 'boolean',
    title: 'Agentic tools',
    description: 'Advertise the Koine compiler tools to the OpenAI-compatible model.',
  },
  aiInlineCompletions: {
    type: 'boolean',
    title: 'Inline completions',
    description: 'LLM ghost-text completions in the editor.',
  },
  aiConstrainGrammar: {
    type: 'boolean',
    title: 'Constrain grammar',
    description: 'Guarantee the assistant generated .koi parses.',
  },
  aiTemperature: {
    type: 'number',
    minimum: 0,
    maximum: 2,
    title: 'Temperature',
    description: 'Assistant sampling temperature (0..2). Lower is more deterministic.',
  },
  mcpEnabled: { type: 'boolean', title: 'Enable MCP', description: 'Enable the local MCP server (desktop sidecar).' },
  mcpClient: {
    type: 'string',
    enum: ['claude-desktop', 'lm-studio', 'cursor', 'vscode', 'generic'],
    title: 'MCP client',
    description: 'Which client the MCP setup recipe targets.',
  },
  previewTarget: { type: 'string', title: 'Preview target', description: 'The language the emitted-code preview renders.' },
  lspTrace: {
    type: 'string',
    enum: ['off', 'messages', 'verbose'],
    title: 'LSP trace',
    description: 'Language-server trace verbosity.',
  },
  displayName: {
    type: 'string',
    title: 'Display name',
    description: 'Name attributed to review comments authored from Studio.',
  },
  terminalShellArgs: {
    type: 'array',
    items: { type: 'string' },
    title: 'Terminal shell args',
    description: 'Arguments for the integrated terminal shell (desktop). Empty uses the default login shell (["-l"]).',
  },
};

// --- per-field UI copy accessor (#765) --------------------------------------
// The settings.json editor surfaces each field's `title`/`description` as a hover tooltip and as
// completion detail. Both read this DOM-free accessor, derived from the field map + leaf schemas
// (keyed by the document path `group.docKey`, matching the JSON pointer the editor resolves at the
// cursor) so the editor never has to know the schema's nested shape and the copy can't drift from the
// field map. The secret `aiApiKey` has no field-map row, so it is structurally absent here — no
// hover/completion copy can ever leak it.

/** A field's human-readable title + description, surfaced in the settings.json editor's hover/completion. */
export interface SettingsFieldMeta {
  readonly title: string;
  readonly description: string;
}

/** `${group}.${docKey}` → {@link SettingsFieldMeta}, derived from {@link SETTINGS_FIELDS} + the leaf schemas. */
export const SETTINGS_FIELD_META: Readonly<Record<string, SettingsFieldMeta>> = (() => {
  const out: Record<string, SettingsFieldMeta> = {};
  for (const f of SETTINGS_FIELDS) {
    const leaf = LEAF_SCHEMAS[f.runtimeKey];
    out[`${f.group}.${f.docKey}`] = {
      title: typeof leaf.title === 'string' ? leaf.title : '',
      description: typeof leaf.description === 'string' ? leaf.description : '',
    };
  }
  return out;
})();

/** Look up a field's title/description by its document group + key (e.g. `'editor'`, `'tabSize'`).
 *  Returns `undefined` for an unknown group/key so the editor's hover/completion degrade silently. */
export function settingsFieldMeta(group: string, docKey: string): SettingsFieldMeta | undefined {
  return SETTINGS_FIELD_META[`${group}.${docKey}`];
}

const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** Build the nested, namespaced document schema from the field map: one object per group, each
 *  `additionalProperties:false`, leaves carrying their leaf schema. Root is `additionalProperties:false`. */
function buildNestedSchema() {
  const groups: Record<string, { type: 'object'; additionalProperties: false; properties: Record<string, LeafSchema> }> = {};
  for (const f of SETTINGS_FIELDS) {
    (groups[f.group] ??= { type: 'object', additionalProperties: false, properties: {} }).properties[f.docKey] =
      LEAF_SCHEMAS[f.runtimeKey];
  }
  return { $schema: SCHEMA_DIALECT, type: 'object', additionalProperties: false, properties: groups };
}

/** Build the retained FLAT schema (top-level runtime keys) so an old/hand-saved flat document still
 *  validates and applies. Also derived from the field map, keyed by runtime key, so it stays in lockstep. */
function buildFlatSchema() {
  const properties: Record<string, LeafSchema> = {};
  for (const f of SETTINGS_FIELDS) properties[f.runtimeKey] = LEAF_SCHEMAS[f.runtimeKey];
  return { $schema: SCHEMA_DIALECT, type: 'object', additionalProperties: false, properties };
}

/** The nested, namespaced settings document schema (#750) — the source the JSON editor validates against. */
export const SETTINGS_JSON_SCHEMA = buildNestedSchema();

/** The pre-#750 flat schema, retained only to validate a legacy/hand-saved flat document. */
const LEGACY_FLAT_SCHEMA = buildFlatSchema();

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateNested = ajv.compile(SETTINGS_JSON_SCHEMA);
const validateFlat = ajv.compile(LEGACY_FLAT_SCHEMA);

/** Runtime keys, used to detect a legacy flat document by its top-level keys (which are runtime keys,
 *  whereas a grouped document's top-level keys are group names — the two sets never overlap). */
const RUNTIME_KEYS = new Set<string>(SETTINGS_FIELDS.map((f) => f.runtimeKey));

/** group → (docKey → runtimeKey), for flattening a validated grouped document back to the flat runtime shape. */
const DOC_TO_RUNTIME: Record<string, Record<string, FieldDef['runtimeKey']>> = (() => {
  const out: Record<string, Record<string, FieldDef['runtimeKey']>> = {};
  for (const f of SETTINGS_FIELDS) (out[f.group] ??= {})[f.docKey] = f.runtimeKey;
  return out;
})();

/**
 * Pretty, grouped settings.json with the secret stripped — what the JSON editor renders. Builds
 * `{ [group]: { [docKey]: value } }` from {@link SETTINGS_FIELDS}, so the document is namespaced
 * (appearance / editor / ai / mcp / preview / lsp / account) while the runtime object stays flat.
 */
export function settingsToJsonDoc(s: Settings): string {
  const out: Record<string, Record<string, unknown>> = {};
  for (const f of SETTINGS_FIELDS) {
    (out[f.group] ??= {})[f.docKey] = s[f.runtimeKey];
  }
  return JSON.stringify(out, null, 2);
}

function formatError(e: ErrorObject): string {
  const where = e.instancePath
    ? e.instancePath.replace(/^\//, '')
    : (e.params as { additionalProperty?: string }).additionalProperty ?? '';
  return where ? `${where}: ${e.message}` : (e.message ?? 'invalid value');
}

/** Detect a legacy FLAT document: a plain object with at least one top-level key that is a runtime
 *  key. A grouped document's top-level keys are group names (which are never runtime keys), so the
 *  two shapes are unambiguous; `{}` is treated as grouped (a valid, empty partial). */
function isLegacyFlat(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.keys(parsed as Record<string, unknown>).some((k) => RUNTIME_KEYS.has(k));
}

/** Flatten a validated document to a Partial<Settings> of ONLY the keys it actually carries, so
 *  omitted fields fall back to `current` on merge (the "merge onto current" semantics). */
function flattenDoc(parsed: unknown, flat: boolean): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (flat) {
    const o = parsed as Record<string, unknown>;
    for (const f of SETTINGS_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(o, f.runtimeKey)) out[f.runtimeKey] = o[f.runtimeKey];
    }
  } else {
    const o = parsed as Record<string, Record<string, unknown>>;
    for (const [group, leaves] of Object.entries(o)) {
      const map = DOC_TO_RUNTIME[group];
      if (!map || leaves === null || typeof leaves !== 'object') continue;
      for (const [docKey, value] of Object.entries(leaves)) {
        const runtimeKey = map[docKey];
        if (runtimeKey) out[runtimeKey] = value;
      }
    }
  }
  return out as Partial<Settings>;
}

/**
 * Parse + schema-validate an edited document — accepting the grouped (#750) shape OR a legacy flat
 * document — and flatten it back to the runtime `Settings` shape. On success returns settings with the
 * secret re-injected from `current` (the JSON never carries it). On failure returns diagnostics only.
 */
export function jsonDocToSettings(
  text: string,
  current: Settings,
): { settings?: Settings; errors?: Array<{ message: string; line?: number }> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { errors: [{ message: (err as Error).message }] };
  }
  const flat = isLegacyFlat(parsed);
  const validate = flat ? validateFlat : validateNested;
  if (!validate(parsed)) {
    // Surface field-specific errors (a bad enum/range on `theme`, `fontSize`, …) before structural
    // root errors (additionalProperties), so the first diagnostic points at the offending field.
    const ordered = [...(validate.errors ?? [])].sort(
      (a, b) => (a.instancePath ? 0 : 1) - (b.instancePath ? 0 : 1),
    );
    return { errors: ordered.map((e) => ({ message: formatError(e) })) };
  }
  const doc = flattenDoc(parsed, flat);
  // previewTarget and aiBaseUrl are deliberately open `string`s in the schema (a dynamic, backend-seeded
  // target must validate), so the schema gate alone lets through values loadSettings() would later drop —
  // the live↔reload divergence (#734). Re-apply the load path's accept-set here so what applies == what survives.
  //
  // previewTarget: VALIDATE against the LIVE EMIT_TARGETS (the same predicate coercePreviewTarget uses).
  // An out-of-registry target is a typo or a removed target; reject it with a diagnostic rather than
  // applying a value that the next reload silently snaps back to csharp.
  if ('previewTarget' in doc && !isEmitTarget(doc.previewTarget)) {
    return { errors: [{ message: `previewTarget: unknown emit target "${String(doc.previewTarget)}"` }] };
  }
  // Re-inject the live secret so a JSON edit can never clear or overwrite the encrypted key.
  const next: Settings = { ...current, ...doc, aiApiKey: current.aiApiKey };
  // aiBaseUrl: COERCE empty → default, exactly as loadSettings() does on read (`.length > 0`, no trim),
  // so a blank URL applies live as the same default a reload would restore.
  if (typeof next.aiBaseUrl !== 'string' || next.aiBaseUrl.length === 0) {
    next.aiBaseUrl = DEFAULT_SETTINGS.aiBaseUrl;
  }
  return { settings: next };
}
