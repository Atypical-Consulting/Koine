// Internal to the settings package — NOT part of the public `@/settings/persistence` API. These are
// the shared read/parse/guard prologue and the guarded read-modify-write behind the settings blob and
// its sibling JSON-object blobs (workspace overrides, keybinding remaps), so callers within
// settings/*.ts can't drift from each other. Both treat anything but a plain non-null, non-array
// object as "no blob" ({}), exactly like every other guarded read in this package.

import { readRaw, writeRaw } from '@/shell/storage';

export const SETTINGS_KEY = 'koine.studio.settings';

/**
 * Read a key as a JSON object, guarded: returns the parsed value only when it is a non-null,
 * non-array object, else {} — an absent key, malformed JSON, or a primitive/array all fall back.
 */
export function readJsonObject(storageKey: string): Record<string, unknown> {
  const raw = readRaw(storageKey);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Set (or clear) a single field in the JSON-object blob at `storageKey`, then write it back.
 * A `null` value DELETES the field; any other value sets it. Reads the current blob via
 * {@link readJsonObject} (so a corrupt/array blob starts fresh) and persists best-effort.
 */
export function patchJsonBlob(storageKey: string, field: string, value: unknown | null): void {
  const blob = readJsonObject(storageKey);
  if (value === null) {
    delete blob[field];
  } else {
    blob[field] = value;
  }
  writeRaw(storageKey, JSON.stringify(blob));
}
