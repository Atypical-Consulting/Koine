import { describe, it, expect } from 'vitest';
import { SETTINGS_JSON_SCHEMA, settingsToJsonDoc, jsonDocToSettings } from './settingsSchema';
import { DEFAULT_SETTINGS, type Settings } from './persistence';

const withKey: Settings = { ...DEFAULT_SETTINGS, aiApiKey: 'sk-SECRET' };

describe('settingsSchema', () => {
  it('schema declares every Settings field except the secret aiApiKey', () => {
    const props = (SETTINGS_JSON_SCHEMA.properties ?? {}) as Record<string, unknown>;
    const schemaKeys = Object.keys(props).sort();
    const settingsKeys = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'aiApiKey').sort();
    expect(schemaKeys).toEqual(settingsKeys);
    expect(props).not.toHaveProperty('aiApiKey');
    expect(SETTINGS_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('settingsToJsonDoc omits aiApiKey from the serialized document', () => {
    const doc = settingsToJsonDoc(withKey);
    expect(doc).not.toContain('aiApiKey');
    expect(doc).not.toContain('sk-SECRET');
    expect(JSON.parse(doc)).not.toHaveProperty('aiApiKey');
  });

  it('serializes settings into namespaced groups (#750)', () => {
    const doc = JSON.parse(settingsToJsonDoc(withKey)) as Record<string, Record<string, unknown>>;
    expect(Object.keys(doc).sort()).toEqual(['account', 'ai', 'appearance', 'editor', 'lsp', 'mcp', 'preview']);
    expect(doc.appearance.theme).toBe(DEFAULT_SETTINGS.theme);
    expect(doc.editor.minimap).toBe(DEFAULT_SETTINGS.enableMinimap); // runtime enableMinimap → doc editor.minimap
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
});
