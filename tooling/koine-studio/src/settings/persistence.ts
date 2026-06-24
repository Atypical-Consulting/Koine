// Koine Studio persistence layer: typed settings plus the recent-folders list, all
// backed by localStorage. Pure data — no DOM, no Tauri. Every read is guarded against
// absent storage and malformed JSON so a corrupt key never breaks the app; every write
// is best-effort and swallows quota/security errors.
//
// One field is special: aiApiKey is a secret and is NEVER written to the plaintext localStorage
// blob. It lives encrypted in IndexedDB (secrets.ts) and is decrypted once at boot (initSecrets)
// into an in-memory cache, so the synchronous Settings API can keep exposing it without leaking it
// to disk in the clear.

import { loadSecret, saveSecret } from '@/ai/secrets';
import type { ChatMessage } from '@/ai/ai';

// --- settings model ----------------------------------------------------------

export type ThemeName = 'dark' | 'light';

/** Accent presets selectable in Settings → Appearance. 'blue' is the theme default (no override). */
export type AccentName = 'blue' | 'teal' | 'violet' | 'amber';

/** MCP client a setup recipe targets in Settings → MCP. */
export type McpClientId = 'claude-desktop' | 'lm-studio' | 'cursor' | 'vscode' | 'generic';

/** A code-generation target the emitted-code ("Generated") preview can render. */
export type PreviewTarget = 'csharp' | 'typescript' | 'python' | 'php' | 'rust';

/** The supported preview targets, in display order. The single source of truth for the set. */
export const PREVIEW_TARGETS: readonly PreviewTarget[] = ['csharp', 'typescript', 'python', 'php', 'rust'];

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
  /** Persist dirty buffers automatically after a short idle, instead of only on explicit save. */
  autoSave: boolean;
  /** Show the CodeMirror minimap (document overview rail) on the editor's right edge. */
  enableMinimap: boolean;
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
  /** The language the emitted-code ("Generated") preview renders. */
  previewTarget: PreviewTarget;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'blue',
  reduceMotion: false,
  fontSize: 13.5,
  lineHeight: 1.6,
  wordWrap: false,
  formatOnSave: true,
  autoSave: false,
  enableMinimap: false,
  lspTrace: 'off',
  aiProvider: 'anthropic',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'claude-opus-4-8',
  aiModelOpenai: '',
  aiAgenticTools: false,
  mcpEnabled: false,
  mcpClient: 'lm-studio',
  previewTarget: 'csharp',
};

// --- storage keys ------------------------------------------------------------

const SETTINGS_KEY = 'koine.studio.settings';
const RECENT_KEY = 'koine.studio.recentFolders';
const SCRATCH_KEY = 'koine.studio.scratch';
const WORKSPACE_CENTER_KEY = 'koine.studio.workspaceCenter';
// Per-workspace active context scope (#146): the folder's storage key is appended (see loadActiveContext).
const ACTIVE_CONTEXT_KEY_PREFIX = 'koine.studio.activeContext.';
const RECENT_CAP = 25;

// The diagram canvas (#145) remembers each diagram's last zoom level, keyed per-diagram under this
// prefix, so reopening the Diagrams tab restores the zoom the user left it at.
const DIAGRAM_ZOOM_KEY_PREFIX = 'koine.studio.diagramZoom.';
/** Zoom percent is clamped to this sane band on save AND load, so a hand-edited key can't break layout. */
const DIAGRAM_ZOOM_MIN = 10;
const DIAGRAM_ZOOM_MAX = 800;

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

/** A supported preview target, else the default. */
function coercePreviewTarget(v: unknown): PreviewTarget {
  return PREVIEW_TARGETS.includes(v as PreviewTarget) ? (v as PreviewTarget) : DEFAULT_SETTINGS.previewTarget;
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
      autoSave: typeof parsed.autoSave === 'boolean' ? parsed.autoSave : DEFAULT_SETTINGS.autoSave,
      enableMinimap:
        typeof parsed.enableMinimap === 'boolean' ? parsed.enableMinimap : DEFAULT_SETTINGS.enableMinimap,
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
      previewTarget: coercePreviewTarget(parsed.previewTarget),
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

export interface RecentFolder {
  path: string;
  openedAt: number;
  pinned?: boolean;
}

/** Pinned first (by openedAt desc), then unpinned by openedAt desc. */
function sortRecents(items: RecentFolder[]): RecentFolder[] {
  return [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return b.openedAt - a.openedAt;
  });
}

/** Cap unpinned entries but never evict a pinned one. */
function capRecents(items: RecentFolder[]): RecentFolder[] {
  const pinned = items.filter((r) => r.pinned);
  const unpinned = items.filter((r) => !r.pinned).slice(0, Math.max(0, RECENT_CAP - pinned.length));
  return sortRecents([...pinned, ...unpinned]);
}

/**
 * The recent-folders list, sorted pinned-first then most-recent. Reads both the structured
 * {@link RecentFolder}[] shape and the legacy `string[]` shape (each legacy entry gets a
 * synthetic, order-preserving openedAt), de-duplicates by path, and caps the length so a
 * hand-edited or stale key can't return junk.
 */
export function getRecentFolders(): RecentFolder[] {
  const raw = readRaw(RECENT_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const entries: RecentFolder[] = [];
    // Legacy string[] entries get a synthetic, order-preserving openedAt.
    let legacyClock = parsed.length;
    for (const item of parsed) {
      let entry: RecentFolder | null = null;
      if (typeof item === 'string' && item.length > 0) {
        entry = { path: item, openedAt: legacyClock--, pinned: false };
      } else if (item && typeof item === 'object' && typeof (item as RecentFolder).path === 'string') {
        const r = item as RecentFolder;
        if (r.path.length > 0) {
          entry = {
            path: r.path,
            openedAt: typeof r.openedAt === 'number' ? r.openedAt : 0,
            pinned: !!r.pinned,
          };
        }
      }
      if (entry && !seen.has(entry.path)) {
        seen.add(entry.path);
        entries.push(entry);
      }
    }
    return capRecents(entries);
  } catch {
    return [];
  }
}

/** Cap, sort, and persist a recent-folders list (the single write path for all mutations). */
function persistRecents(items: RecentFolder[]): void {
  writeRaw(RECENT_KEY, JSON.stringify(capRecents(items)));
}

/**
 * Record a folder as most-recently used: upsert (move to front, preserving any prior pinned
 * state), cap, persist. Empty paths are ignored.
 */
export function pushRecentFolder(path: string): void {
  if (typeof path !== 'string' || path.length === 0) return;
  const existing = getRecentFolders();
  const prior = existing.find((r) => r.path === path);
  const rest = existing.filter((r) => r.path !== path);
  persistRecents([{ path, openedAt: Date.now(), pinned: prior?.pinned ?? false }, ...rest]);
}

/** Drop a single recent folder by path. */
export function removeRecentFolder(path: string): void {
  persistRecents(getRecentFolders().filter((r) => r.path !== path));
}

/** Pin or unpin a recent folder by path so it floats above (or rejoins) the unpinned entries. */
export function pinRecentFolder(path: string, pinned: boolean): void {
  persistRecents(getRecentFolders().map((r) => (r.path === path ? { ...r, pinned } : r)));
}

/** Forget all recent folders. */
export function clearRecentFolders(): void {
  writeRaw(RECENT_KEY, JSON.stringify([]));
}

// --- legacy scratch migration helpers ----------------------------------------

/**
 * Read the legacy single-file scratch buffer (pre-workspace Studio) without clearing it.
 * Call this at boot to check whether a migration is needed; call {@link clearLegacyScratch}
 * only AFTER the default workspace has actually opened, so the content is never lost if OPFS
 * is unavailable or the open fails.
 */
export function peekLegacyScratch(): string | null {
  return readRaw(SCRATCH_KEY);
}

/**
 * Remove the legacy scratch key from localStorage. Best-effort — swallows storage errors.
 * Only call this after a successful workspace open so the migration is non-destructive.
 */
export function clearLegacyScratch(): void {
  try {
    localStorage.removeItem(SCRATCH_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

// --- workspace center pane ---------------------------------------------------
// The active center pane (Visual / Code / Documentation) persists across reloads. It is stored as the
// bare center id under its own key; validation and the default live with the uiChrome slice, so this
// layer just round-trips the raw string and stays free of any view knowledge.

/** The persisted center-pane id, or null when none is stored (or storage is unavailable). */
export function loadWorkspaceCenter(): string | null {
  return readRaw(WORKSPACE_CENTER_KEY);
}

/** Persist the active center-pane id (best-effort). */
export function saveWorkspaceCenter(id: string): void {
  writeRaw(WORKSPACE_CENTER_KEY, id);
}

// --- diagram canvas zoom (#145) ----------------------------------------------
// Each diagram's last zoom *percent* is round-tripped under its own key so the interactive canvas can
// restore it next time the Diagrams tab opens. Only the zoom is remembered (not the pan), matching the
// plan: a tab re-open re-fits and re-centers but keeps the magnification the user chose. Values are
// clamped on both read and write so a malformed/hand-edited key can never feed the layout a bad number.

/** Clamp to the sane zoom band, or null when not a finite number. */
function coerceZoom(v: number): number | null {
  if (!Number.isFinite(v)) return null;
  return Math.min(DIAGRAM_ZOOM_MAX, Math.max(DIAGRAM_ZOOM_MIN, v));
}

/** The persisted zoom percent for a diagram key, or null when none is stored (or it's malformed). */
export function loadDiagramZoom(key: string): number | null {
  const raw = readRaw(DIAGRAM_ZOOM_KEY_PREFIX + key);
  return raw == null ? null : coerceZoom(Number(raw));
}

/** Persist a diagram's zoom percent (best-effort), clamped to the sane band. */
export function saveDiagramZoom(key: string, percent: number): void {
  const z = coerceZoom(percent);
  if (z == null) return;
  writeRaw(DIAGRAM_ZOOM_KEY_PREFIX + key, String(Math.round(z)));
}

// --- diagram node positions (authoring canvas) -------------------------------
// The authoring canvas lets the user drag nodes anywhere (n8n-style) and remembers where they left each
// one, keyed PER WORKSPACE + diagram so positions never bleed across projects. Positions are a VIEW
// concern only — they never round-trip into `.koi` (the compiler is the source of truth for the model;
// localStorage is the right home, exactly like zoom). Keyed by a node's stable qualified name so a layout
// survives a re-render (and most model edits). Every read is guarded so a hand-edited key can't break the
// canvas, and malformed entries are dropped individually.
const DIAGRAM_POSITIONS_KEY_PREFIX = 'koine.studio.diagramPositions.';

/** A persisted node position in diagram content coordinates. */
export interface DiagramPosition {
  x: number;
  y: number;
}

/** The persisted node positions for a diagram key, keyed by qualified name; {} when absent/malformed. */
export function loadDiagramPositions(key: string): Record<string, DiagramPosition> {
  const raw = readRaw(DIAGRAM_POSITIONS_KEY_PREFIX + key);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, DiagramPosition> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        const p = value as Record<string, unknown>;
        if (typeof p.x === 'number' && Number.isFinite(p.x) && typeof p.y === 'number' && Number.isFinite(p.y)) {
          out[name] = { x: p.x, y: p.y };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Persist a diagram's node positions (best-effort). */
export function saveDiagramPositions(key: string, positions: Record<string, DiagramPosition>): void {
  writeRaw(DIAGRAM_POSITIONS_KEY_PREFIX + key, JSON.stringify(positions));
}

/** Forget a diagram's saved positions (the "Auto-arrange / reset layout" action). */
export function clearDiagramPositions(key: string): void {
  try {
    localStorage.removeItem(DIAGRAM_POSITIONS_KEY_PREFIX + key);
  } catch {
    // storage unavailable — nothing to clear
  }
}

// --- active bounded context (#146) -------------------------------------------
// The active context scope (a context name, or the literal 'all') is persisted PER workspace — a
// context like "Sales" only means anything within its own model — so each folder restores its own
// scope, keyed by the workspace's storage key (the folder identity, or 'scratch'). Like the workspace
// mode above, this layer just round-trips the raw string; the sentinel/default live with the model
// (activeContext.ts), so the store stays free of any context knowledge.

/** The persisted active-context scope for a workspace, or null when none is stored. */
export function loadActiveContext(workspaceKey: string): string | null {
  return readRaw(ACTIVE_CONTEXT_KEY_PREFIX + workspaceKey);
}

/** Persist the active-context scope for a workspace (best-effort). */
export function saveActiveContext(workspaceKey: string, scope: string): void {
  writeRaw(ACTIVE_CONTEXT_KEY_PREFIX + workspaceKey, scope);
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
