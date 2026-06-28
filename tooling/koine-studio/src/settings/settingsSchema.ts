// DOM-free. Owns the Draft 2020-12 schema for the editable settings.json document plus the
// serialization helpers. The secret aiApiKey is NEVER declared, serialized, or accepted here:
// the schema is additionalProperties:false and the parser re-injects the live in-memory key.
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
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
  // Re-inject the live secret so a JSON edit can never clear or overwrite the encrypted key.
  return { settings: { ...current, ...(parsed as Partial<Settings>), aiApiKey: current.aiApiKey } };
}
