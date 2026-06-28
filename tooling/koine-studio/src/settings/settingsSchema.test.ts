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
});
