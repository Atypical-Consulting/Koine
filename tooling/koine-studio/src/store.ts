// Koine Studio persistence layer: typed settings plus the recent-folders list, all
// backed by localStorage. Pure data — no DOM, no Tauri. Every read is guarded against
// absent storage and malformed JSON so a corrupt key never breaks the app; every write
// is best-effort and swallows quota/security errors.

// --- settings model ----------------------------------------------------------

export type ThemeName = 'dark' | 'light';

export interface Settings {
  theme: ThemeName;
  fontSize: number;
  formatOnSave: boolean;
  lspTrace: 'off' | 'messages' | 'verbose';
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontSize: 13.5,
  formatOnSave: true,
  lspTrace: 'off',
};

// --- storage keys ------------------------------------------------------------

const SETTINGS_KEY = 'koine.studio.settings';
const RECENT_KEY = 'koine.studio.recentFolders';
const RECENT_CAP = 8;

// Editor font-size bounds — must match the Preferences input range (prefs.ts) so a stored
// value can never drive the editor outside what the UI itself permits.
const FONT_MIN = 10;
const FONT_MAX = 22;

// --- raw localStorage helpers (never throw) ----------------------------------

/** Read a key, returning null on any error or when storage is unavailable. */
function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a key, swallowing quota/security errors. */
function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable or full — best effort only
  }
}

// --- settings ----------------------------------------------------------------

/** A valid theme string, else the default. */
function coerceTheme(v: unknown): ThemeName {
  return v === 'light' || v === 'dark' ? v : DEFAULT_SETTINGS.theme;
}

/** A finite number clamped into the editor font range, else the default. */
function coerceFontSize(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.fontSize;
  return Math.min(Math.max(v, FONT_MIN), FONT_MAX);
}

/** A valid LSP trace level, else the default. */
function coerceTrace(v: unknown): Settings['lspTrace'] {
  return v === 'messages' || v === 'verbose' || v === 'off' ? v : DEFAULT_SETTINGS.lspTrace;
}

/**
 * Load settings, merging any stored partial onto DEFAULT_SETTINGS and validating each
 * field. Unknown shapes, bad JSON, and absent storage all fall back to the defaults.
 */
export function loadSettings(): Settings {
  const raw = readRaw(SETTINGS_KEY);
  if (raw === null) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
    return {
      theme: coerceTheme(parsed.theme),
      fontSize: coerceFontSize(parsed.fontSize),
      formatOnSave: typeof parsed.formatOnSave === 'boolean' ? parsed.formatOnSave : DEFAULT_SETTINGS.formatOnSave,
      lspTrace: coerceTrace(parsed.lspTrace),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist a full settings object. */
export function saveSettings(s: Settings): void {
  writeRaw(SETTINGS_KEY, JSON.stringify(s));
}

/** Merge a partial onto current settings, persist, and return the merged result. */
export function patchSettings(p: Partial<Settings>): Settings {
  const merged: Settings = { ...loadSettings(), ...p };
  saveSettings(merged);
  return merged;
}

// --- recent folders ----------------------------------------------------------

/**
 * The recent-folders list, most-recent first. Filters to non-empty strings and caps
 * the length so a hand-edited or stale key can't return junk.
 */
export function getRecentFolders(): string[] {
  const raw = readRaw(RECENT_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((p): p is string => typeof p === 'string' && p.length > 0).slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

/**
 * Record a folder as most-recently used: de-duplicate (move to front), cap at 8, persist.
 * Empty paths are ignored.
 */
export function pushRecentFolder(path: string): void {
  if (typeof path !== 'string' || path.length === 0) return;
  const next = [path, ...getRecentFolders().filter((p) => p !== path)].slice(0, RECENT_CAP);
  writeRaw(RECENT_KEY, JSON.stringify(next));
}

/** Forget all recent folders. */
export function clearRecentFolders(): void {
  writeRaw(RECENT_KEY, JSON.stringify([]));
}
