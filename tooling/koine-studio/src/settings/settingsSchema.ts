// DOM-free. Owns the Draft 2020-12 schema for the editable settings.json document plus the
// serialization helpers. The secret aiApiKey is NEVER declared, serialized, or accepted here:
// the schema is additionalProperties:false and the parser re-injects the live in-memory key.
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import { isEmitTarget } from '@/shared/emitTargets';
import { DEFAULT_SETTINGS, type Settings } from './persistence';

// Mirror the editor input bounds in persistence.ts (FONT_MIN/MAX, LINE_HEIGHT_MIN/MAX) and the
// enum rosters (AccentName, McpClientId, lspTrace, aiProvider). The `properties` set is asserted by
// settingsSchema.test.ts to equal Object.keys(DEFAULT_SETTINGS) minus the secret aiApiKey, so adding
// a non-secret field to Settings must add it here too.
export const SETTINGS_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: {
    theme: { type: 'string', enum: ['dark', 'light'] },
    accent: { type: 'string', enum: ['blue', 'teal', 'violet', 'amber'] },
    reduceMotion: { type: 'boolean' },
    fontSize: { type: 'number', minimum: 10, maximum: 22 },
    lineHeight: { type: 'number', minimum: 1.2, maximum: 2.4 },
    wordWrap: { type: 'boolean' },
    formatOnSave: { type: 'boolean' },
    autoSave: { type: 'boolean' },
    enableMinimap: { type: 'boolean' },
    lspTrace: { type: 'string', enum: ['off', 'messages', 'verbose'] },
    aiProvider: { type: 'string', enum: ['anthropic', 'openai'] },
    aiBaseUrl: { type: 'string' },
    aiModel: { type: 'string' },
    aiModelOpenai: { type: 'string' },
    aiAgenticTools: { type: 'boolean' },
    aiInlineCompletions: { type: 'boolean' },
    aiConstrainGrammar: { type: 'boolean' },
    mcpEnabled: { type: 'boolean' },
    mcpClient: { type: 'string', enum: ['claude-desktop', 'lm-studio', 'cursor', 'vscode', 'generic'] },
    previewTarget: { type: 'string' },
    displayName: { type: 'string' },
  },
} as const;

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(SETTINGS_JSON_SCHEMA);

/** The Settings keys that appear in the JSON document (everything except the secret). */
const DOC_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'aiApiKey') as (keyof Settings)[];

/** Pretty settings.json with the secret stripped — what the JSON editor renders. */
export function settingsToJsonDoc(s: Settings): string {
  const out: Record<string, unknown> = {};
  for (const k of DOC_KEYS) out[k] = s[k];
  return JSON.stringify(out, null, 2);
}

function formatError(e: ErrorObject): string {
  const where = e.instancePath
    ? e.instancePath.replace(/^\//, '')
    : (e.params as { additionalProperty?: string }).additionalProperty ?? '';
  return where ? `${where}: ${e.message}` : (e.message ?? 'invalid value');
}

/**
 * Parse + schema-validate an edited document. On success returns settings with the secret
 * re-injected from `current` (the JSON never carries it). On failure returns diagnostics only.
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
  if (!validate(parsed)) {
    // Surface field-specific errors (a bad enum/range on `theme`, `fontSize`, …) before structural
    // root errors (additionalProperties), so the first diagnostic points at the offending field.
    const ordered = [...(validate.errors ?? [])].sort(
      (a, b) => (a.instancePath ? 0 : 1) - (b.instancePath ? 0 : 1),
    );
    return { errors: ordered.map((e) => ({ message: formatError(e) })) };
  }
  const doc = parsed as Partial<Settings>;
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
