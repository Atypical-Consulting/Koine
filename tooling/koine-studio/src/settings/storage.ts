// Internal to the settings package — NOT part of the public `@/settings/persistence` API. These are
// the shared read/parse/guard prologue, the guarded read-modify-write, and the guarded-remove behind
// every JSON-object blob in settings/*.ts (the settings blob, workspace overrides, keybinding remaps,
// diagram positions/annotations, the last-session snapshot) plus every plain single-key `clearX`, so
// callers across settingsStore.ts, workspaceState.ts, and diagramState.ts can't drift from each other.
// readJsonObject treats anything but a plain non-null, non-array object as "no blob" ({}), exactly like
// every other guarded read in this package; array-shaped blobs (recentFolders) and multi-key migration
// reads (the workspace Deck layout) have different-enough guard shapes that they stay hand-rolled.

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

/**
 * Forget a single key, guarded: swallows quota/security errors exactly like {@link writeRaw}, so a
 * caller's `clearX`/`forget` action never throws even when storage is unavailable. The shared home for
 * what used to be six independent `try { localStorage.removeItem(key) } catch {}` copies across
 * settings/*.ts.
 */
export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // storage unavailable — nothing to clear
  }
}
