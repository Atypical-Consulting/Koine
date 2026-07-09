// Koine Studio persistence layer: typed settings plus the recent-folders list, all
// backed by localStorage. Pure data — no DOM, no Tauri. Every read is guarded against
// absent storage and malformed JSON so a corrupt key never breaks the app; every write
// is best-effort and swallows quota/security errors.
//
// One field is special: aiApiKey is a secret and is NEVER written to the plaintext localStorage
// blob. It lives encrypted in IndexedDB (secrets.ts) and is decrypted once at boot (initSecrets)
// into an in-memory cache, so the synchronous Settings API can keep exposing it without leaking it
// to disk in the clear.

import type { ChatMessage } from '@/ai/ai';
import {
  clampZoomPercent,
  sanitizeGroups,
  sanitizeNotes,
  type DiagramGroup,
  type DiagramNote,
} from '@/diagrams/diagramContract';
import { DEFAULT_DECK_STATE, isValidCenter, isValidDeckState, type CenterView, type DeckState } from '@/store/slices/uiChrome';
import { readRaw, writeRaw } from '@/shell/storage';

// Re-exported so the barrel's public surface (initSecrets/whenSecretsReady/saveApiKey/clearApiKey) is
// unchanged; getCachedApiKey is intentionally NOT re-exported (barrel-private, see settings/secrets.ts).
export { initSecrets, whenSecretsReady, saveApiKey, clearApiKey } from './secrets';

// The Settings model (types, defaults, coercion, load/save/patch), the workspace-override store, and
// the keybinding-override store live in settingsStore.ts; re-exported so this barrel's public surface
// (Settings, DEFAULT_SETTINGS, loadSettings, workspaceKeyOf, resolveKeybindings, etc.) is unchanged.
export * from './settingsStore';

// --- storage keys ------------------------------------------------------------

const RECENT_KEY = 'koine.studio.recentFolders';
const SCRATCH_KEY = 'koine.studio.scratch';
const WORKSPACE_CENTER_KEY = 'koine.studio.workspaceCenter';
// The pre-Deck split-pane layout key, still read once for a one-time migration into the deck shape.
const WORKSPACE_CENTER_LAYOUT_KEY = 'koine.studio.workspaceCenterLayout';
// The Deck v2 center-layout key (mode / primary / secondary / ratio / flipped).
const WORKSPACE_DECK_KEY = 'koine.studio.workspaceDeck';
// The most-recently opened workspace token (#535), so a reload can restore it instead of silently
// reverting to the empty default. Only OPFS-internal tokens are auto-restored at boot (see ide.ts).
const LAST_WORKSPACE_KEY = 'koine.studio.lastWorkspace';
// A lightweight snapshot of the last active editing session (project / active file / dirty count /
// timestamp), so the Home screen can offer a "continue where you left off" resume card (#1005).
const LAST_SESSION_KEY = 'koine.studio.lastSession';
// Per-workspace active context scope (#146): the folder's storage key is appended (see loadActiveContext).
const ACTIVE_CONTEXT_KEY_PREFIX = 'koine.studio.activeContext.';
const RECENT_CAP = 25;

// The diagram canvas (#145) remembers each diagram's last zoom level, keyed per-diagram under this
// prefix, so reopening the Diagrams tab restores the zoom the user left it at.
const DIAGRAM_ZOOM_KEY_PREFIX = 'koine.studio.diagramZoom.';
// The zoom band (DIAGRAM_ZOOM_MIN/MAX) and its clamp (clampZoomPercent) are owned by diagramContract and
// imported above, so this layer and the renderer clamp to the SAME band with a one-way dependency.

// The assistant transcript is namespaced per workspace under its own key prefix (distinct from
// settings/scratch/recentFolders), so each opened folder keeps its own conversation.
const CHAT_KEY_PREFIX = 'koine.studio.chat.';
/** Max assistant messages kept per workspace; older turns are dropped so a long chat can't grow unbounded. */
export const CHAT_HISTORY_CAP = 100;

// --- recent folders ----------------------------------------------------------

export interface RecentFolder {
  path: string;
  openedAt: number;
  pinned?: boolean;
  /** Git branch the folder was last opened on (desktop only; absent in the browser or for non-repos). */
  branch?: string;
  /** Effective emit target when the folder was last opened (e.g. `'csharp'`, `'typescript'`). */
  language?: string;
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
          // Pass through the #1005 metadata only when present as non-empty strings; legacy entries
          // that predate these fields simply read back without them.
          if (typeof r.branch === 'string' && r.branch.length > 0) entry.branch = r.branch;
          if (typeof r.language === 'string' && r.language.length > 0) entry.language = r.language;
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
 *
 * `meta` carries the optional #1005 tags (git `branch`, emit `language`). A supplied field
 * overwrites; an omitted one falls back to the prior entry's value, so a bare re-push
 * (`pushRecentFolder(path)`) refreshes recency WITHOUT wiping metadata captured earlier.
 */
export function pushRecentFolder(path: string, meta?: { branch?: string; language?: string }): void {
  if (typeof path !== 'string' || path.length === 0) return;
  const existing = getRecentFolders();
  const prior = existing.find((r) => r.path === path);
  const rest = existing.filter((r) => r.path !== path);
  const entry: RecentFolder = { path, openedAt: Date.now(), pinned: prior?.pinned ?? false };
  const branch = meta?.branch ?? prior?.branch;
  const language = meta?.language ?? prior?.language;
  if (typeof branch === 'string' && branch.length > 0) entry.branch = branch;
  if (typeof language === 'string' && language.length > 0) entry.language = language;
  persistRecents([entry, ...rest]);
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

/** Best-effort migration of a persisted pre-Deck split-pane layout (orientation/panes/sizes) into the
 *  deck shape: the focused pane's view becomes `primary`, the other pane (if any) becomes `secondary`,
 *  and `sizes[0]` becomes `ratio`. Returns null when the value isn't a recognisable layout. */
function deckFromLegacyLayout(raw: string): DeckState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const layout = parsed as { panes?: { id?: string; view?: string }[]; sizes?: number[]; focusedPaneId?: string };
  if (!Array.isArray(layout.panes) || layout.panes.length === 0) return null;
  const views = layout.panes.map((p) => p.view).filter((v): v is CenterView => typeof v === 'string' && isValidCenter(v));
  if (views.length === 0) return null;
  const focused = layout.panes.find((p) => p.id === layout.focusedPaneId);
  const primary = focused && isValidCenter(focused.view as string) ? (focused.view as CenterView) : views[0];
  const secondary = views.find((v) => v !== primary) ?? null;
  const ratio = Array.isArray(layout.sizes) && typeof layout.sizes[0] === 'number' ? layout.sizes[0] : 0.5;
  return { mode: 'focus', primary, secondary, ratio: Math.min(0.8, Math.max(0.2, ratio)), flipped: false };
}

/** Load the persisted DeckState. Falls back to DEFAULT_DECK_STATE on absent/malformed data; migrates a
 *  pre-Deck split-pane layout, then a legacy single-view `workspaceCenter` value, in that order. */
export function loadWorkspaceDeck(): DeckState {
  const raw = readRaw(WORKSPACE_DECK_KEY);
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isValidDeckState(parsed)) return parsed;
    } catch {
      // malformed JSON — fall through to migration / default
    }
  }
  // Migrate a pre-Deck split-pane layout.
  const legacyLayout = readRaw(WORKSPACE_CENTER_LAYOUT_KEY);
  if (legacyLayout !== null) {
    const migrated = deckFromLegacyLayout(legacyLayout);
    if (migrated) return migrated;
  }
  // Migrate a legacy single-view string.
  const legacyCenter = readRaw(WORKSPACE_CENTER_KEY);
  if (legacyCenter !== null && isValidCenter(legacyCenter)) {
    return { ...DEFAULT_DECK_STATE, primary: legacyCenter };
  }
  return DEFAULT_DECK_STATE;
}

/** Persist the DeckState (best-effort). */
export function saveWorkspaceDeck(deck: DeckState): void {
  try {
    writeRaw(WORKSPACE_DECK_KEY, JSON.stringify(deck));
  } catch {
    // serialization error — best effort
  }
}

// --- last opened workspace (#535) --------------------------------------------
// A single pointer to the most-recently opened workspace token, so a cold boot can re-open it instead
// of silently reverting to the empty default workspace (the data-loss bug). Only OPFS-internal tokens
// ('(default)' / 'example-*') are actually auto-restored at boot — a picked-folder handle needs a
// permission gesture boot can't provide, so it stays a manual Recents click (the gate lives in ide.ts).
// This layer just round-trips the raw token, exactly like loadWorkspaceCenter above.

/** The persisted last-opened workspace token, or null when none is stored (or storage is unavailable). */
export function getLastWorkspace(): string | null {
  return readRaw(LAST_WORKSPACE_KEY);
}

/** Persist the last-opened workspace token (best-effort). An empty token is ignored. */
export function setLastWorkspace(token: string): void {
  if (typeof token !== 'string' || token.length === 0) return;
  writeRaw(LAST_WORKSPACE_KEY, token);
}

/** Forget the last-opened workspace pointer (best-effort). */
export function clearLastWorkspace(): void {
  try {
    localStorage.removeItem(LAST_WORKSPACE_KEY);
  } catch {
    // storage unavailable — nothing to clear
  }
}

// --- last-session snapshot (Home resume card, #1005) -------------------------
// A single lightweight snapshot of what the user was last working on (project / active file / dirty
// count / timestamp), so the Home screen can offer a "continue where you left off" card. Distinct from
// LAST_WORKSPACE_KEY (a bare re-open token): this carries display metadata, not the boot pointer. The
// read is guarded like getRecentFolders so a corrupt/legacy/hand-edited key never throws or feeds junk.

/** A lightweight snapshot of the last active editing session, for the Home resume card (#1005). */
export interface LastSession {
  /** The workspace/project name or token the user was last in. */
  project: string;
  /** The active file (relative path) when the snapshot was taken, if any. */
  file?: string;
  /** Epoch-ms of the last edit/save/open captured. */
  editedAt: number;
  /** How many open buffers were unsaved at capture time, if known. */
  unsavedCount?: number;
}

/**
 * The last-session snapshot, or null when none is stored. Tolerant of an absent, unparseable,
 * non-object, array, or legacy value, and of a record missing a valid string `project` (all → null).
 * A missing/non-finite/non-positive `editedAt` also → null: real writes always stamp `Date.now()`, so a
 * record without a usable timestamp is corrupt/legacy and would otherwise render an absurd relative time
 * ("~56 years ago") on the resume card. Optional `file` / `unsavedCount` pass through only when the
 * right type. Never throws.
 */
export function getLastSession(): LastSession | null {
  const raw = readRaw(LAST_SESSION_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.project !== 'string' || o.project.length === 0) return null;
    if (typeof o.editedAt !== 'number' || !Number.isFinite(o.editedAt) || o.editedAt <= 0) return null;
    const session: LastSession = {
      project: o.project,
      editedAt: o.editedAt,
    };
    if (typeof o.file === 'string') session.file = o.file;
    if (typeof o.unsavedCount === 'number' && Number.isFinite(o.unsavedCount)) session.unsavedCount = o.unsavedCount;
    return session;
  } catch {
    return null;
  }
}

/** Persist (or, with null, forget) the last-session snapshot. Best-effort — swallows storage errors. */
export function setLastSession(s: LastSession | null): void {
  if (s === null) {
    try {
      localStorage.removeItem(LAST_SESSION_KEY);
    } catch {
      // storage unavailable — nothing to clear
    }
    return;
  }
  writeRaw(LAST_SESSION_KEY, JSON.stringify(s));
}

// --- diagram canvas zoom (#145) ----------------------------------------------
// Each diagram's last zoom *percent* is round-tripped under its own key so the interactive canvas can
// restore it next time the Diagrams tab opens. Only the zoom is remembered (not the pan), matching the
// plan: a tab re-open re-fits and re-centers but keeps the magnification the user chose. Values are
// clamped on both read and write so a malformed/hand-edited key can never feed the layout a bad number.

/** The persisted zoom percent for a diagram key, or null when none is stored (or it's malformed). */
export function loadDiagramZoom(key: string): number | null {
  const raw = readRaw(DIAGRAM_ZOOM_KEY_PREFIX + key);
  return raw == null ? null : clampZoomPercent(Number(raw));
}

/** Persist a diagram's zoom percent (best-effort), clamped to the sane band. */
export function saveDiagramZoom(key: string, percent: number): void {
  const z = clampZoomPercent(percent);
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

// --- diagram canvas annotations (notes + groups, #255) -----------------------
// Canvas-only annotations (free-text notes and node groupings) are a VIEW concern exactly like positions
// above — they never round-trip into `.koi`. In browser/scratch mode they live in localStorage under a
// sibling key (positions keep their own key, so the position storage stays backward-compatible); in folder
// mode the committable koine.layout.json holds both (see layoutStore.ts). Every read is guarded and
// malformed entries are dropped individually (shared sanitizers), so a hand-edited key can't break the canvas.
const DIAGRAM_ANNOTATIONS_KEY_PREFIX = 'koine.studio.diagramAnnotations.';

/** The canvas-only annotations for a diagram: free-text notes plus node groupings. */
export interface DiagramAnnotations {
  notes: DiagramNote[];
  groups: DiagramGroup[];
}

/** The persisted annotations for a diagram key; empty notes/groups when absent or malformed. */
export function loadDiagramAnnotations(key: string): DiagramAnnotations {
  const raw = readRaw(DIAGRAM_ANNOTATIONS_KEY_PREFIX + key);
  if (raw === null) return { notes: [], groups: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return { notes: [], groups: [] };
    const p = parsed as Record<string, unknown>;
    return { notes: sanitizeNotes(p.notes), groups: sanitizeGroups(p.groups) };
  } catch {
    return { notes: [], groups: [] };
  }
}

/** Persist a diagram's canvas annotations (best-effort). */
export function saveDiagramAnnotations(key: string, annotations: DiagramAnnotations): void {
  writeRaw(
    DIAGRAM_ANNOTATIONS_KEY_PREFIX + key,
    JSON.stringify({ notes: annotations.notes, groups: annotations.groups }),
  );
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
