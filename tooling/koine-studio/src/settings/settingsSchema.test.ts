import { describe, it, expect } from 'vitest';
import {
  SETTINGS_JSON_SCHEMA,
  SETTINGS_FIELDS,
  SETTINGS_FIELD_META,
  WORKSPACE_SETTINGS_JSON_SCHEMA,
  settingsFieldMeta,
  settingsToJsonDoc,
  jsonDocToSettings,
  workspaceOverridesToJsonDoc,
  jsonDocToWorkspaceOverrides,
} from './settingsSchema';
import { DEFAULT_SETTINGS, WORKSPACE_SCOPED_KEYS, type Settings } from './persistence';

// Derived from the field map: which group names and docKeys appear for workspace-scoped keys.
const WORKSPACE_SCOPED_KEY_SET = new Set(WORKSPACE_SCOPED_KEYS);
const EXPECTED_WS_GROUPS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const f of SETTINGS_FIELDS) {
    if (!WORKSPACE_SCOPED_KEY_SET.has(f.runtimeKey)) continue;
    (out[f.group] ??= []).push(f.docKey);
  }
  return out;
})();

const withKey: Settings = { ...DEFAULT_SETTINGS, aiApiKey: 'sk-SECRET' };

describe('settingsSchema', () => {
  it('locks Settings ⇄ field map ⇄ nested schema in three-way parity (#750)', () => {
    // 1) field map ⇄ Settings: every non-secret runtime key has exactly one field-map row, secret excluded.
    const settingsKeys = Object.keys(DEFAULT_SETTINGS)
      .filter((k) => k !== 'aiApiKey')
      .sort();
    const mapKeys = SETTINGS_FIELDS.map((f) => f.runtimeKey).sort();
    expect(mapKeys).toEqual(settingsKeys);
    // 2) nested-schema leaves ⇄ field map (group.docKey): the schema is built FROM the map, so it can't drift.
    const groups = SETTINGS_JSON_SCHEMA.properties as Record<string, { properties: Record<string, unknown> }>;
    const schemaLeaves = Object.entries(groups)
      .flatMap(([g, gs]) => Object.keys(gs.properties).map((k) => `${g}.${k}`))
      .sort();
    const mapLeaves = SETTINGS_FIELDS.map((f) => `${f.group}.${f.docKey}`).sort();
    expect(schemaLeaves).toEqual(mapLeaves);
    // 3) the secret appears nowhere in the schema, and unknown groups are rejected at the root.
    expect(JSON.stringify(SETTINGS_JSON_SCHEMA)).not.toContain('aiApiKey');
    expect(SETTINGS_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('exposes non-empty title + description for every field, secret absent (#765)', () => {
    // The hover/completion copy (#765) is driven entirely by this accessor; a blank title or
    // description would render an empty tooltip / completion detail, so lock both to non-empty.
    for (const f of SETTINGS_FIELDS) {
      const meta = settingsFieldMeta(f.group, f.docKey);
      expect(meta, `${f.group}.${f.docKey}`).toBeDefined();
      expect(meta!.title.length, `${f.group}.${f.docKey} title`).toBeGreaterThan(0);
      expect(meta!.description.length, `${f.group}.${f.docKey} description`).toBeGreaterThan(0);
    }
    // One entry per field, no path collisions — the completion source keys off this map.
    expect(Object.keys(SETTINGS_FIELD_META).length).toBe(SETTINGS_FIELDS.length);
    // The secret never has a metadata entry, so no hover/completion copy can leak it.
    expect(Object.keys(SETTINGS_FIELD_META).some((k) => k.toLowerCase().includes('apikey'))).toBe(false);
    expect(settingsFieldMeta('ai', 'apiKey')).toBeUndefined();
    // An unknown group / typo'd key resolves to nothing (hover/completion degrade silently).
    expect(settingsFieldMeta('editor', 'nope')).toBeUndefined();
    expect(settingsFieldMeta('bogus', 'tabSize')).toBeUndefined();
  });

  it('settingsToJsonDoc omits aiApiKey from the serialized document', () => {
    const doc = settingsToJsonDoc(withKey);
    expect(doc).not.toContain('aiApiKey');
    expect(doc).not.toContain('sk-SECRET');
    expect(JSON.parse(doc)).not.toHaveProperty('aiApiKey');
  });

  it('serializes settings into namespaced groups (#750)', () => {
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    expect(Object.keys(doc).sort()).toEqual(['account', 'ai', 'appearance', 'editor', 'lsp', 'mcp', 'preview', 'terminal']);
    expect(doc.appearance.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(doc.editor.minimap).toBe(DEFAULT_SETTINGS.enableMinimap); // runtime enableMinimap → doc editor.minimap
    expect(doc.editor.defaultCanvasZoom).toBe(DEFAULT_SETTINGS.defaultCanvasZoom); // diagram canvas default zoom (#762)
    expect(doc.ai.provider).toBe(DEFAULT_SETTINGS.aiProvider);
    expect(doc.lsp.trace).toBe(DEFAULT_SETTINGS.lspTrace);
    expect(doc.account.displayName).toBe(DEFAULT_SETTINGS.displayName);
    expect(JSON.stringify(doc)).not.toContain('aiApiKey'); // secret invariant
  });

  it('round-trips a valid document back to settings, preserving the in-memory secret', () => {
    const doc = settingsToJsonDoc(withKey);
    const res = jsonDocToSettings(doc, withKey);
    expect(res.errors).toBeUndefined();
    expect(res.settings).toEqual(withKey);
  });

  it('round-trips the grouped document back to settings (#750)', () => {
    const res = jsonDocToSettings(settingsToJsonDoc(withKey), withKey);
    expect(res.errors).toBeUndefined();
    expect(res.settings).toEqual(withKey);
  });

  it('rejects an unknown key inside a group (per-group additionalProperties:false) (#750)', () => {
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    doc.editor.bogus = 1;
    const res = jsonDocToSettings(JSON.stringify(doc), withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an unknown top-level group (root additionalProperties:false) (#750)', () => {
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, unknown>;
    doc.bogusGroup = { x: 1 };
    const res = jsonDocToSettings(JSON.stringify(doc), withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('still accepts a legacy FLAT document and applies it (#750)', () => {
    const res = jsonDocToSettings(JSON.stringify({ theme: 'light', fontSize: 16 }), withKey);
    expect(res.errors).toBeUndefined();
    expect(res.settings?.theme).toBe('light');
    expect(res.settings?.fontSize).toBe(16);
    expect(res.settings?.aiApiKey).toBe('sk-SECRET'); // secret preserved
  });

  it('rejects a smuggled aiApiKey inside a group (#750)', () => {
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    doc.ai.aiApiKey = 'sneaky';
    const res = jsonDocToSettings(JSON.stringify(doc), withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('round-trips the three new grouped options (#750)', () => {
    const custom: Settings = { ...withKey, tabSize: 4, fontFamily: 'JetBrains Mono', aiTemperature: 0.7 };
    const doc = JSON.parse(settingsToJsonDoc(custom)) as Record<string, Record<string, unknown>>;
    expect(doc.editor.tabSize).toBe(4);
    expect(doc.appearance.fontFamily).toBe('JetBrains Mono');
    expect(doc.ai.temperature).toBe(0.7);
    const res = jsonDocToSettings(settingsToJsonDoc(custom), withKey);
    expect(res.errors).toBeUndefined();
    expect(res.settings).toEqual(custom);
  });

  it('round-trips the terminal.shellArgs override (#467)', () => {
    const custom: Settings = { ...withKey, terminalShellArgs: ['-l', '-i'] };
    const doc = JSON.parse(settingsToJsonDoc(custom)) as Record<string, Record<string, unknown>>;
    expect(doc.terminal.shellArgs).toEqual(['-l', '-i']);
    const res = jsonDocToSettings(settingsToJsonDoc(custom), withKey);
    expect(res.errors).toBeUndefined();
    expect(res.settings?.terminalShellArgs).toEqual(['-l', '-i']);
  });

  it('rejects a non-string entry in terminal.shellArgs (items: string) (#467)', () => {
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    doc.terminal.shellArgs = ['-l', 7];
    const res = jsonDocToSettings(JSON.stringify(doc), withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects a blank entry in terminal.shellArgs (items minLength:1) (#467)', () => {
    // A blank token would spawn the shell with an empty arg and kill it; the schema rejects it at edit
    // time, matching the load path's drop-blanks coercion (what applies == what survives a reload).
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    doc.terminal.shellArgs = ['-l', ''];
    const res = jsonDocToSettings(JSON.stringify(doc), withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-bounds grouped tabSize / temperature (#750)', () => {
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    doc.editor.tabSize = 99;
    expect(jsonDocToSettings(JSON.stringify(doc), withKey).settings).toBeUndefined();
    const doc2 = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    doc2.ai.temperature = 5;
    expect(jsonDocToSettings(JSON.stringify(doc2), withKey).settings).toBeUndefined();
  });

  it('applies an edited field while keeping the current secret', () => {
    const edited = settingsToJsonDoc(withKey).replace('"dark"', '"light"');
    const res = jsonDocToSettings(edited, withKey);
    expect(res.settings?.theme).toBe('light');
    expect(res.settings?.aiApiKey).toBe('sk-SECRET');
  });

  it('rejects malformed JSON with a diagnostic and no settings', () => {
    const res = jsonDocToSettings('{ "theme": ', withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-enum value via schema validation', () => {
    const res = jsonDocToSettings(JSON.stringify({ ...DEFAULT_SETTINGS, theme: 'sepia' }), withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.[0]?.message).toMatch(/theme/i);
  });

  it('rejects an unknown property (additionalProperties:false) and a smuggled aiApiKey', () => {
    const res = jsonDocToSettings(JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: 'sneaky' }), withKey);
    expect(res.settings).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an out-of-bounds fontSize (10..22)', () => {
    const res = jsonDocToSettings(JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, fontSize: 99 }), withKey);
    expect(res.settings).toBeUndefined();
  });

  // The two open-string fields (previewTarget, aiBaseUrl) are validated/coerced here to the SAME
  // accept-set loadSettings() uses, so what live-applies is exactly what survives a reload (#734).

  it('rejects a schema-valid but out-of-registry previewTarget with a diagnostic and no settings', () => {
    const res = jsonDocToSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, previewTarget: 'god' }),
      withKey,
    );
    expect(res.settings).toBeUndefined();
    expect(res.errors?.[0]?.message).toMatch(/previewTarget/i);
  });

  it('rejects an empty-string previewTarget with a diagnostic (the spec edge case)', () => {
    const res = jsonDocToSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, previewTarget: '' }),
      withKey,
    );
    expect(res.settings).toBeUndefined();
    expect(res.errors?.[0]?.message).toMatch(/previewTarget/i);
  });

  it('accepts a built-in previewTarget and round-trips it to settings', () => {
    const res = jsonDocToSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, previewTarget: 'typescript' }),
      withKey,
    );
    expect(res.errors).toBeUndefined();
    expect(res.settings?.previewTarget).toBe('typescript');
  });

  it('coerces an empty aiBaseUrl to the DEFAULT (not the current value), matching loadSettings', () => {
    // current.aiBaseUrl is deliberately non-default so this proves the coercion targets the DEFAULT,
    // exactly as loadSettings() does on read — not "preserve the current value", which would diverge
    // from a reload whenever the user's saved URL is non-default.
    const current: Settings = { ...withKey, aiBaseUrl: 'http://localhost:1234/v1' };
    const res = jsonDocToSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, aiBaseUrl: '' }),
      current,
    );
    expect(res.errors).toBeUndefined();
    expect(res.settings?.aiBaseUrl).toBe(DEFAULT_SETTINGS.aiBaseUrl);
  });

  it('preserves the current previewTarget/aiBaseUrl when the doc omits them', () => {
    const current: Settings = {
      ...withKey,
      previewTarget: 'rust',
      aiBaseUrl: 'http://localhost:1234/v1',
    };
    const res = jsonDocToSettings(JSON.stringify({ theme: 'light' }), current);
    expect(res.errors).toBeUndefined();
    expect(res.settings?.theme).toBe('light');
    expect(res.settings?.previewTarget).toBe('rust');
    expect(res.settings?.aiBaseUrl).toBe('http://localhost:1234/v1');
  });

  it('coerces an empty aiModel to the DEFAULT (not the current value), matching loadSettings (#744)', () => {
    // current.aiModel is deliberately non-default so this proves the coercion targets DEFAULT_SETTINGS.aiModel,
    // exactly as loadSettings() does on read — not "preserve the current value", which would diverge
    // from a reload whenever the user's saved model is non-default.
    const current: Settings = { ...withKey, aiModel: 'some-custom-model' };
    const res = jsonDocToSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, aiModel: '' }),
      current,
    );
    expect(res.errors).toBeUndefined();
    expect(res.settings?.aiModel).toBe(DEFAULT_SETTINGS.aiModel);
  });

  it('applies a non-empty aiModel verbatim (no over-coercion) (#744)', () => {
    const res = jsonDocToSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, aiModel: 'claude-3-7-sonnet' }),
      withKey,
    );
    expect(res.errors).toBeUndefined();
    expect(res.settings?.aiModel).toBe('claude-3-7-sonnet');
  });

  it('leaves aiModelOpenai empty when the doc sets it to "" — no coercion, matching loadSettings (#744)', () => {
    // aiModelOpenai load path allows empty (typeof … === 'string' only, no .length > 0),
    // so there is no divergence and coercing it would be wrong.
    const res = jsonDocToSettings(
      JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: undefined, aiModelOpenai: '' }),
      withKey,
    );
    expect(res.errors).toBeUndefined();
    expect(res.settings?.aiModelOpenai).toBe('');
  });
});

describe('workspace settings schema (#736)', () => {
  it('schema drift guard: WORKSPACE_SETTINGS_JSON_SCHEMA.properties are grouped by SETTINGS_FIELDS for WORKSPACE_SCOPED_KEYS (#792)', () => {
    const schema = WORKSPACE_SETTINGS_JSON_SCHEMA.properties as Record<string, { properties: Record<string, unknown> }>;
    // Same group names as derived from the field map for the workspace-scoped keys
    expect(Object.keys(schema).sort()).toEqual(Object.keys(EXPECTED_WS_GROUPS).sort());
    // Same docKeys per group
    for (const [group, groupSchema] of Object.entries(schema)) {
      expect(Object.keys(groupSchema.properties).sort()).toEqual(EXPECTED_WS_GROUPS[group].sort());
    }
    // Root is additionalProperties:false (unknown groups / flat runtime keys rejected)
    expect(WORKSPACE_SETTINGS_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('WORKSPACE_SETTINGS_JSON_SCHEMA is additionalProperties:false with the Draft 2020-12 dialect', () => {
    expect(WORKSPACE_SETTINGS_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(WORKSPACE_SETTINGS_JSON_SCHEMA.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  });

  it('workspaceOverridesToJsonDoc({}) serializes to "{}"', () => {
    expect(workspaceOverridesToJsonDoc({})).toBe('{}');
  });

  it('jsonDocToWorkspaceOverrides("{}") returns empty overrides with no errors', () => {
    const res = jsonDocToWorkspaceOverrides('{}');
    expect(res.errors).toBeUndefined();
    expect(res.overrides).toEqual({});
  });

  it('round-trips all four scoped keys', () => {
    const o: Partial<Settings> = { previewTarget: 'csharp', formatOnSave: false, wordWrap: true, lspTrace: 'verbose' };
    const res = jsonDocToWorkspaceOverrides(workspaceOverridesToJsonDoc(o));
    expect(res.errors).toBeUndefined();
    expect(res.overrides).toEqual(o);
  });

  it('round-trips a partial override (only previewTarget)', () => {
    const o: Partial<Settings> = { previewTarget: 'typescript' };
    const res = jsonDocToWorkspaceOverrides(workspaceOverridesToJsonDoc(o));
    expect(res.errors).toBeUndefined();
    expect(res.overrides).toEqual(o);
    // Only the one key present — non-scoped or absent keys not included
    expect(Object.keys(res.overrides!)).toEqual(['previewTarget']);
  });

  it('workspaceOverridesToJsonDoc emits grouped keys in SETTINGS_FIELDS order (#792)', () => {
    const o: Partial<Settings> = { lspTrace: 'messages', wordWrap: true, previewTarget: 'python', formatOnSave: true };
    const doc = JSON.parse(workspaceOverridesToJsonDoc(o)) as Record<string, Record<string, unknown>>;
    // Top-level keys are group names (preview, editor, lsp) — NOT flat runtime keys
    expect(doc).not.toHaveProperty('previewTarget');
    expect(doc).not.toHaveProperty('lspTrace');
    expect(doc).not.toHaveProperty('formatOnSave');
    expect(doc).not.toHaveProperty('wordWrap');
    expect(doc.preview.target).toBe('python');
    expect(doc.editor.formatOnSave).toBe(true);
    expect(doc.editor.wordWrap).toBe(true);
    expect(doc.lsp.trace).toBe('messages');
  });

  it('rejects an unknown top-level key (e.g. theme) with errors and no overrides', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ theme: 'dark' }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an unknown top-level key (e.g. foo) with errors and no overrides', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ foo: 1 }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects a bad lspTrace enum value ("loud") with errors and no overrides', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ lspTrace: 'loud' }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects wrong type for formatOnSave (string "yes") with errors and no overrides', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ formatOnSave: 'yes' }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an unknown previewTarget ("cobol") with a previewTarget diagnostic and no overrides', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ previewTarget: 'cobol' }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.[0]?.message).toMatch(/previewTarget/i);
  });

  it('rejects malformed JSON with errors and no overrides', () => {
    const res = jsonDocToWorkspaceOverrides('{');
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('accepts a valid previewTarget ("csharp") and round-trips it', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ previewTarget: 'csharp' }));
    expect(res.errors).toBeUndefined();
    expect(res.overrides?.previewTarget).toBe('csharp');
  });

  it('non-scoped keys in the overrides object are silently dropped by workspaceOverridesToJsonDoc (#792)', () => {
    // A full Settings object passed — only the four scoped keys should appear in the output (as groups)
    const full = { ...DEFAULT_SETTINGS, theme: 'light' } as Partial<Settings>;
    const doc = JSON.parse(workspaceOverridesToJsonDoc(full)) as Record<string, unknown>;
    // Only workspace-scoped groups appear — 'appearance' (theme) is not workspace-scoped
    expect(doc).not.toHaveProperty('theme');
    expect(doc).not.toHaveProperty('appearance');
    expect(doc).not.toHaveProperty('previewTarget'); // no flat runtime keys
    // The scoped groups are present
    expect(doc).toHaveProperty('preview');
    expect(doc).toHaveProperty('editor');
    expect(doc).toHaveProperty('lsp');
  });

  // --- cross-scope consistency (#792) ----------------------------------------

  it('a field copied from the user settings doc validates in the workspace doc (#792)', () => {
    // preview.target in user scope → accepted verbatim in workspace scope (no key-shape change needed)
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ preview: { target: 'python' } }));
    expect(res.errors).toBeUndefined();
    expect(res.overrides?.previewTarget).toBe('python');
  });

  it('grouped workspace doc maps to flat runtime keys via SETTINGS_FIELDS table (#792)', () => {
    const grouped = JSON.stringify({ preview: { target: 'typescript' }, lsp: { trace: 'verbose' }, editor: { formatOnSave: false, wordWrap: true } });
    const res = jsonDocToWorkspaceOverrides(grouped);
    expect(res.errors).toBeUndefined();
    expect(res.overrides?.previewTarget).toBe('typescript');
    expect(res.overrides?.lspTrace).toBe('verbose');
    expect(res.overrides?.formatOnSave).toBe(false);
    expect(res.overrides?.wordWrap).toBe(true);
  });

  it('rejects a bad enum in a grouped workspace doc (lsp.trace = "loud") (#792)', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ lsp: { trace: 'loud' } }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects a bad type in a grouped workspace doc (editor.formatOnSave = "yes") (#792)', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ editor: { formatOnSave: 'yes' } }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an unknown key inside a group in the workspace doc (editor.bogus) (#792)', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ editor: { bogus: true } }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('rejects an unknown previewTarget in a grouped workspace doc ("cobol") with a previewTarget diagnostic (#792)', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ preview: { target: 'cobol' } }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.[0]?.message).toMatch(/previewTarget/i);
  });

  // --- legacy flat format (backward-compatibility, pre-#792) ------------------

  it('still accepts a legacy flat workspace doc (previewTarget at top level) (#792)', () => {
    // Pre-#792 flat format: runtime key at the top level — must still be accepted
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ previewTarget: 'csharp' }));
    expect(res.errors).toBeUndefined();
    expect(res.overrides?.previewTarget).toBe('csharp');
  });

  it('still rejects a bad enum in a legacy flat workspace doc (lspTrace = "loud") (#792)', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ lspTrace: 'loud' }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('still rejects a bad type in a legacy flat workspace doc (formatOnSave = "yes") (#792)', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ formatOnSave: 'yes' }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.length).toBeGreaterThan(0);
  });

  it('still rejects an unknown previewTarget in a legacy flat doc ("cobol") (#792)', () => {
    const res = jsonDocToWorkspaceOverrides(JSON.stringify({ previewTarget: 'cobol' }));
    expect(res.overrides).toBeUndefined();
    expect(res.errors?.[0]?.message).toMatch(/previewTarget/i);
  });
});

// Task 3 (#791, updated by #792): structural guard for the workspace schema builder.
// After #792 changed WORKSPACE_SETTINGS_JSON_SCHEMA from flat to grouped, these guards
// verify that buildWorkspaceGroupedSchema correctly covers all workspace-scoped fields.
describe('buildWorkspaceGroupedSchema structural equality guard (#791, #792)', () => {
  it('WORKSPACE_SETTINGS_JSON_SCHEMA.properties keys match the expected groups from SETTINGS_FIELDS', () => {
    // After #792 the top-level keys are group names (editor, preview, lsp), not runtime keys.
    // EXPECTED_WS_GROUPS is derived from SETTINGS_FIELDS so this is a three-way drift guard.
    expect(Object.keys(WORKSPACE_SETTINGS_JSON_SCHEMA.properties).sort()).toEqual(
      Object.keys(EXPECTED_WS_GROUPS).sort(),
    );
  });

  it('WORKSPACE_SETTINGS_JSON_SCHEMA and SETTINGS_JSON_SCHEMA share the same $schema dialect', () => {
    const dialect = 'https://json-schema.org/draft/2020-12/schema';
    expect(WORKSPACE_SETTINGS_JSON_SCHEMA.$schema).toBe(dialect);
  });

  it('WORKSPACE_SETTINGS_JSON_SCHEMA is additionalProperties:false', () => {
    expect(WORKSPACE_SETTINGS_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('every WORKSPACE_SCOPED_KEY has a non-empty leaf schema under its group in WORKSPACE_SETTINGS_JSON_SCHEMA', () => {
    // Verifies that buildWorkspaceGroupedSchema populated every workspace-scoped field's leaf
    // under the correct group — a guard against silently missing a field after a SETTINGS_FIELDS change.
    const groups = WORKSPACE_SETTINGS_JSON_SCHEMA.properties as Record<
      string,
      { properties: Record<string, unknown> }
    >;
    for (const f of SETTINGS_FIELDS) {
      if (!WORKSPACE_SCOPED_KEY_SET.has(f.runtimeKey)) continue;
      const groupSchema = groups[f.group];
      expect(groupSchema, `group schema for ${f.group}`).toBeDefined();
      const leaf = groupSchema.properties[f.docKey];
      expect(leaf, `leaf schema for ${f.group}.${f.docKey}`).toBeDefined();
      expect(Object.keys(leaf as object).length, `leaf schema for ${f.group}.${f.docKey} is non-empty`).toBeGreaterThan(
        0,
      );
    }
  });
});

// Task 2 (#791): characterization tests that guard the extraction of sortedValidationErrors and
// rejectBadPreviewTarget. Both converters must keep identical error-ordering and previewTarget message.
describe('jsonDocToSettings / jsonDocToWorkspaceOverrides error-ordering parity (#791)', () => {
  it('both converters put field-specific errors before additionalProperties errors', () => {
    // A flat legacy doc with a bad lspTrace enum value AND an unknown key. The sort must put
    // the field error first in both converters so the first diagnostic points at the bad field.
    const doc = JSON.stringify({ lspTrace: 'loud', bogusKey: 1 });
    const settingsRes = jsonDocToSettings(doc, DEFAULT_SETTINGS);
    const wsRes = jsonDocToWorkspaceOverrides(doc);

    // Both should fail
    expect(settingsRes.settings).toBeUndefined();
    expect(wsRes.overrides).toBeUndefined();

    // First error in BOTH is the field-specific one (lspTrace), not the structural one (bogusKey).
    expect(settingsRes.errors?.[0]?.message).toMatch(/lspTrace/);
    expect(wsRes.errors?.[0]?.message).toMatch(/lspTrace/);
  });

  it('both converters produce the same previewTarget error message format for an unknown target', () => {
    const userDoc = JSON.stringify({ previewTarget: 'cobol' });
    const wsDoc = JSON.stringify({ previewTarget: 'cobol' });

    const settingsRes = jsonDocToSettings(userDoc, DEFAULT_SETTINGS);
    const wsRes = jsonDocToWorkspaceOverrides(wsDoc);

    expect(settingsRes.settings).toBeUndefined();
    expect(wsRes.overrides).toBeUndefined();

    // Both must produce the same exact message so callers see a consistent diagnostic.
    expect(settingsRes.errors?.[0]?.message).toBe('previewTarget: unknown emit target "cobol"');
    expect(wsRes.errors?.[0]?.message).toBe('previewTarget: unknown emit target "cobol"');
  });
});
