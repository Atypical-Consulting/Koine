// Koine Studio persistence layer: typed settings plus the recent-folders list, all
// backed by localStorage. Pure data — no DOM, no Tauri. Every read is guarded against
// absent storage and malformed JSON so a corrupt key never breaks the app; every write
// is best-effort and swallows quota/security errors.
//
// One field is special: aiApiKey is a secret and is NEVER written to the plaintext localStorage
// blob. It lives encrypted in IndexedDB (secrets.ts) and is decrypted once at boot (initSecrets)
// into an in-memory cache, so the synchronous Settings API can keep exposing it without leaking it
// to disk in the clear.

import { loadSecret, saveSecret } from './secrets';
import type { ChatMessage } from './ai';

// --- settings model ----------------------------------------------------------

export type ThemeName = 'dark' | 'light';

/** Accent presets selectable in Settings → Appearance. 'blue' is the theme default (no override). */
export type AccentName = 'blue' | 'teal' | 'violet' | 'amber';

/** MCP client a setup recipe targets in Settings → MCP. */
export type McpClientId = 'claude-desktop' | 'lm-studio' | 'cursor' | 'vscode' | 'generic';

export interface Settings {
  theme: ThemeName;
  /** Accent hue applied over the active theme. */
  accent: AccentName;
  /** Collapse UI animations/transitions — an explicit companion to the OS reduced-motion setting. */
  reduceMotion: boolean;
  fontSize: number;
  /** Editor line height as a unitless multiple of the font size. */
  lineHeight: number;
  /** Soft-wrap long editor lines instead of scrolling horizontally. */
  wordWrap: boolean;
  formatOnSave: boolean;
  lspTrace: 'off' | 'messages' | 'verbose';
  /** Which AI backend the assistant uses. */
  aiProvider: 'anthropic' | 'openai';
  /** Base URL for the OpenAI-compatible provider (OpenAI / Ollama / LM Studio / …). */
  aiBaseUrl: string;
  /** API key for the AI assistant (stored locally; empty for keyless local servers). */
  aiApiKey: string;
  /** Anthropic model id. */
  aiModel: string;
  /** OpenAI-compatible model id (kept separate so switching providers doesn't send a Claude id to OpenAI). */
  aiModelOpenai: string;
  /** Advertise the Koine compiler tools (validate/compile/format) to the OpenAI-compatible model.
   *  Off by default: many local servers (LM Studio / Ollama) buffer the whole reply instead of
   *  streaming when tools are present, so opting in trades live streaming for the agentic loop. */
  aiAgenticTools: boolean;
  /** Whether the local MCP server (desktop sidecar) is enabled. Opt-in: no background server unless on. */
  mcpEnabled: boolean;
  /** Which client the Settings → MCP setup recipe is shown for. */
  mcpClient: McpClientId;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'blue',
  reduceMotion: false,
  fontSize: 13.5,
  lineHeight: 1.6,
  wordWrap: false,
  formatOnSave: true,
  lspTrace: 'off',
  aiProvider: 'anthropic',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'claude-opus-4-8',
  aiModelOpenai: '',
  aiAgenticTools: false,
  mcpEnabled: false,
  mcpClient: 'lm-studio',
};

// --- storage keys ------------------------------------------------------------

const SETTINGS_KEY = 'koine.studio.settings';
const RECENT_KEY = 'koine.studio.recentFolders';
const SCRATCH_KEY = 'koine.studio.scratch';
const RECENT_CAP = 8;

// The assistant transcript is namespaced per workspace under its own key prefix (distinct from
// settings/scratch/recentFolders), so each opened folder keeps its own conversation.
const CHAT_KEY_PREFIX = 'koine.studio.chat.';
/** Max assistant messages kept per workspace; older turns are dropped so a long chat can't grow unbounded. */
export const CHAT_HISTORY_CAP = 100;

/** The secret kept out of the plaintext blob and in the encrypted store; also its key name there. */
const API_KEY_SECRET = 'aiApiKey';

// The decrypted API key, populated once by initSecrets() and updated by saveApiKey()/clearApiKey().
// loadSettings() reads from here so the secret never round-trips through localStorage.
let secretCache = '';

// Editor font-size bounds — must match the Settings input range (prefs.ts) so a stored
// value can never drive the editor outside what the UI itself permits.
const FONT_MIN = 10;
const FONT_MAX = 22;

// Editor line-height bounds — likewise mirror the Settings input range in prefs.ts.
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.4;

// The canonical accent roster. This data layer owns the list; the appearance layer derives its
// presets and picker order from it, so a new accent is added in exactly one place.
export const ACCENT_NAMES: readonly AccentName[] = ['blue', 'teal', 'violet', 'amber'];

// The canonical MCP-client roster, used to validate a stored mcpClient. The recipe UI (mcp.ts)
// owns the per-client copy; this layer only owns the set of valid ids.
const MCP_CLIENT_IDS: readonly McpClientId[] = ['claude-desktop', 'lm-studio', 'cursor', 'vscode', 'generic'];

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

/** A finite number clamped into the editor line-height range, else the default. */
function coerceLineHeight(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.lineHeight;
  return Math.min(Math.max(v, LINE_HEIGHT_MIN), LINE_HEIGHT_MAX);
}

/** A known accent name, else the default. */
function coerceAccent(v: unknown): AccentName {
  return ACCENT_NAMES.includes(v as AccentName) ? (v as AccentName) : DEFAULT_SETTINGS.accent;
}

/** A valid LSP trace level, else the default. */
function coerceTrace(v: unknown): Settings['lspTrace'] {
  return v === 'messages' || v === 'verbose' || v === 'off' ? v : DEFAULT_SETTINGS.lspTrace;
}

/** A known MCP client id, else the default. */
function coerceMcpClient(v: unknown): McpClientId {
  return MCP_CLIENT_IDS.includes(v as McpClientId) ? (v as McpClientId) : DEFAULT_SETTINGS.mcpClient;
}

/**
 * Load settings, merging any stored partial onto DEFAULT_SETTINGS and validating each
 * field. Unknown shapes, bad JSON, and absent storage all fall back to the defaults.
 */
export function loadSettings(): Settings {
  const raw = readRaw(SETTINGS_KEY);
  // Even with no stored blob, surface the cached secret so the key survives a fresh settings object.
  if (raw === null) return { ...DEFAULT_SETTINGS, aiApiKey: secretCache };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS, aiApiKey: secretCache };
    return {
      theme: coerceTheme(parsed.theme),
      accent: coerceAccent(parsed.accent),
      reduceMotion: typeof parsed.reduceMotion === 'boolean' ? parsed.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
      fontSize: coerceFontSize(parsed.fontSize),
      lineHeight: coerceLineHeight(parsed.lineHeight),
      wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : DEFAULT_SETTINGS.wordWrap,
      formatOnSave: typeof parsed.formatOnSave === 'boolean' ? parsed.formatOnSave : DEFAULT_SETTINGS.formatOnSave,
      lspTrace: coerceTrace(parsed.lspTrace),
      aiProvider: parsed.aiProvider === 'openai' ? 'openai' : DEFAULT_SETTINGS.aiProvider,
      aiBaseUrl:
        typeof parsed.aiBaseUrl === 'string' && parsed.aiBaseUrl.length > 0 ? parsed.aiBaseUrl : DEFAULT_SETTINGS.aiBaseUrl,
      // The API key is never stored in this blob; it comes from the encrypted in-memory cache.
      aiApiKey: secretCache,
      aiModel: typeof parsed.aiModel === 'string' && parsed.aiModel.length > 0 ? parsed.aiModel : DEFAULT_SETTINGS.aiModel,
      aiModelOpenai: typeof parsed.aiModelOpenai === 'string' ? parsed.aiModelOpenai : DEFAULT_SETTINGS.aiModelOpenai,
      aiAgenticTools:
        typeof parsed.aiAgenticTools === 'boolean' ? parsed.aiAgenticTools : DEFAULT_SETTINGS.aiAgenticTools,
      mcpEnabled: typeof parsed.mcpEnabled === 'boolean' ? parsed.mcpEnabled : DEFAULT_SETTINGS.mcpEnabled,
      mcpClient: coerceMcpClient(parsed.mcpClient),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, aiApiKey: secretCache };
  }
}

/**
 * Persist a full settings object — minus the secret. aiApiKey is deliberately stripped so the
 * plaintext blob never carries it; the key is owned by saveApiKey()/the encrypted store instead.
 */
export function saveSettings(s: Settings): void {
  const { aiApiKey: _omit, ...persisted } = s;
  writeRaw(SETTINGS_KEY, JSON.stringify(persisted));
}

/** Merge a partial onto current settings, persist, and return the merged result. */
export function patchSettings(p: Partial<Settings>): Settings {
  const merged: Settings = { ...loadSettings(), ...p };
  saveSettings(merged);
  return merged;
}

// --- secret API key (encrypted in IndexedDB, cached in memory) ----------------

// Memoized so repeated calls (and whenSecretsReady) share one decrypt, and so callers can await the
// exact moment secretCache is populated rather than racing the fire-and-forget boot call.
let secretsReady: Promise<void> | null = null;

/**
 * Decrypt the stored API key into the in-memory cache, run once at boot before any AI request.
 * Also performs a one-time migration: a key left in the legacy plaintext settings blob is moved
 * into the encrypted store and scrubbed from the blob. Idempotent — the first call does the work.
 */
export function initSecrets(): Promise<void> {
  if (!secretsReady) secretsReady = doInitSecrets();
  return secretsReady;
}

/** Resolves once the secret cache has been populated (or immediately if never initialized). */
export function whenSecretsReady(): Promise<void> {
  return secretsReady ?? Promise.resolve();
}

async function doInitSecrets(): Promise<void> {
  const raw = readRaw(SETTINGS_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const legacy = typeof parsed?.aiApiKey === 'string' ? parsed.aiApiKey : '';
      if (legacy.length > 0) {
        await saveSecret(API_KEY_SECRET, legacy);
        // Rewrite the blob without the secret (loadSettings injects secretCache below).
        delete parsed.aiApiKey;
        writeRaw(SETTINGS_KEY, JSON.stringify(parsed));
      }
    } catch {
      // malformed blob — nothing to migrate
    }
  }
  secretCache = await loadSecret(API_KEY_SECRET);
}

/** Update and persist the secret API key (encrypted). An empty value clears it. */
export async function saveApiKey(value: string): Promise<void> {
  secretCache = value;
  await saveSecret(API_KEY_SECRET, value);
}

/** Forget the secret API key (memory + encrypted store). */
export async function clearApiKey(): Promise<void> {
  secretCache = '';
  await saveSecret(API_KEY_SECRET, '');
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

// --- legacy scratch migration (one-time read+clear) --------------------------

/**
 * One-time read+clear of the legacy single-file scratch buffer (pre-workspace Studio), used by the
 * boot migration into the default workspace. Returns the text once, then forgets it.
 */
export function takeLegacyScratch(): string | null {
  const text = readRaw(SCRATCH_KEY);
  if (text !== null) {
    try {
      localStorage.removeItem(SCRATCH_KEY);
    } catch {
      // storage unavailable — nothing to clear
    }
  }
  return text;
}

// --- assistant conversation (per workspace) ----------------------------------
// Each workspace (folder, or the literal 'scratch') keeps its own transcript under CHAT_KEY_PREFIX,
// so a reload restores the conversation and switching folders swaps to that folder's history.

/** A well-formed transcript entry: a valid role and a string content. */
function isChatMessage(v: unknown): v is ChatMessage {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string';
}

/**
 * The stored transcript for a workspace key, most-recent last. Filters to well-formed entries and
 * caps the length, so an absent/malformed/non-array key (or a hand-edited one) can only return [].
 */
export function loadChat(key: string): ChatMessage[] {
  const raw = readRaw(CHAT_KEY_PREFIX + key);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isChatMessage).slice(-CHAT_HISTORY_CAP);
  } catch {
    return [];
  }
}

/** Persist a workspace transcript (best-effort), keeping only the last CHAT_HISTORY_CAP messages. */
export function saveChat(key: string, msgs: ChatMessage[]): void {
  writeRaw(CHAT_KEY_PREFIX + key, JSON.stringify(msgs.slice(-CHAT_HISTORY_CAP)));
}

/** Forget a workspace's stored transcript (e.g. the user clears the conversation). */
export function clearChat(key: string): void {
  try {
    localStorage.removeItem(CHAT_KEY_PREFIX + key);
  } catch {
    // storage unavailable — nothing to clear
  }
}
