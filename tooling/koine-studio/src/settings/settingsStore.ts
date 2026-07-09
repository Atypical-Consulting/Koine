// The Settings model itself (issue #988): the typed `Settings` shape, its defaults, the coercion/
// validation of every field, the user-level load/save/patch cycle, the per-workspace override store,
// and the editor keybinding-override store. Split out of persistence.ts, which now re-exports this
// module's public surface via `export * from './settingsStore'` so `@/settings/persistence` stays the
// unchanged import path for every existing caller.
//
// One field is special: aiApiKey is a secret and is NEVER written to the plaintext localStorage blob —
// loadSettings()/saveSettings() strip/inject it via secrets.ts's in-memory cache (getCachedApiKey())
// instead, so this synchronous API can keep exposing it without leaking it to disk in the clear.

import { clampZoomPercent } from '@/diagrams/diagramContract';
import { isEmitTarget } from '@/shared/emitTargets';
import { DEFAULT_BINDINGS, type BindingId } from '@/editor/keybindings';
import { readRaw, writeRaw } from '@/shell/storage';
import { readJsonObject, patchJsonBlob, removeKey, SETTINGS_KEY } from './storage';
import { getCachedApiKey } from './secrets';

// --- settings model ----------------------------------------------------------

export type ThemeName = 'dark' | 'light';

/** Which view to land on when Studio opens cold (no explicit hash / share link). Default 'home'. */
export type StartupView = 'home' | 'lastWorkspace';

/** Type-guard for {@link StartupView}. */
export function isStartupView(v: unknown): v is StartupView {
  return v === 'home' || v === 'lastWorkspace';
}

/** Accent presets selectable in Settings → Appearance. 'blue' is the theme default (no override). */
export type AccentName = 'blue' | 'teal' | 'violet' | 'amber';

/** MCP client a setup recipe targets in Settings → MCP. */
export type McpClientId = 'claude-desktop' | 'lm-studio' | 'cursor' | 'vscode' | 'generic';

/**
 * A code-generation target id the emitted-code ("Generated") preview can render. Kept as a plain
 * `string` (not a closed union) so a backend-only target surfaces without a front-end type edit; the
 * set is validated at runtime against the live {@link EMIT_TARGETS} (see `coercePreviewTarget`),
 * which is seeded from the backend capability query at boot (issue #282).
 */
export type PreviewTarget = string;

export interface Settings {
  theme: ThemeName;
  /** Accent hue applied over the active theme. */
  accent: AccentName;
  /** Collapse UI animations/transitions — an explicit companion to the OS reduced-motion setting. */
  reduceMotion: boolean;
  /** Editor font stack override (CSS font-family list). Empty string → the theme's default mono font. */
  fontFamily: string;
  fontSize: number;
  /** Editor line height as a unitless multiple of the font size. */
  lineHeight: number;
  /** Soft-wrap long editor lines instead of scrolling horizontally. */
  wordWrap: boolean;
  /** Indent width in spaces (also the rendered tab width). Clamped to 1..8. */
  tabSize: number;
  formatOnSave: boolean;
  /** Persist dirty buffers automatically after a short idle, instead of only on explicit save. */
  autoSave: boolean;
  /** Show the CodeMirror minimap (document overview rail) on the editor's right edge. */
  enableMinimap: boolean;
  /** Initial zoom (percent) for a freshly-opened domain diagram canvas, when no per-diagram zoom is
   *  saved (#762). Clamped to the diagram zoom band (10–800); 100 keeps the canvas at its real 1:1 scale. */
  defaultCanvasZoom: number;
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
  /** LLM ghost-text completions in the editor (#263). Off by default — predicting while you type spends
   *  API tokens on every idle pause, so it stays opt-in and no-ops when no provider is configured. */
  aiInlineCompletions: boolean;
  /** Constrain/guarantee the assistant's generated `.koi` parses (#257). On by default: grammar-capable
   *  local models are decode-constrained to the Koine grammar; other providers validate-and-repair the
   *  candidate before "Apply to editor" is enabled, so unparseable text can never be applied. */
  aiConstrainGrammar: boolean;
  /** Assistant sampling temperature (0..2). Lower is more deterministic; default 0.2 keeps codegen steady. */
  aiTemperature: number;
  /** Whether the local MCP server (desktop sidecar) is enabled. Opt-in: no background server unless on. */
  mcpEnabled: boolean;
  /** Fixed loopback port the desktop MCP sidecar binds. `0` lets the OS assign one; the default 56463 keeps
   *  a copied `mcp.json` stable across Studio restarts. Clamped to a valid TCP port (0..65535). Desktop-only:
   *  the browser host serves no sidecar and ignores it. If the configured port is busy the host falls back
   *  to an OS-assigned one (surfaced as a warning in Settings). */
  mcpPort: number;
  /** Which client the Settings → MCP setup recipe is shown for. */
  mcpClient: McpClientId;
  /** The language the emitted-code ("Generated") preview renders. */
  previewTarget: PreviewTarget;
  /** Name attributed to review comments authored from Studio (#479); blank → the 'You' fallback. */
  displayName: string;
  /** Override for the integrated terminal's shell arguments (#467). Empty ⇒ the desktop host's built-in
   *  default `["-l"]` (a login shell, #462's fix), so today's behaviour is unchanged. A bash user who
   *  keeps PATH/aliases only in `~/.bashrc` can set `["-l", "-i"]` so an interactive shell sources it.
   *  Desktop-only — the browser host has no shell; the user owns the value (we don't validate args). */
  terminalShellArgs: string[];
  /** Which view to open on a cold start (no explicit `#/editor` hash or share link). Default `'home'`
   *  preserves the #766 always-Home behaviour for everyone who doesn't change it. `'lastWorkspace'` re-
   *  enables the old auto-resume: opens the editor immediately when a workspace was opened previously.
   *  This is a user-level (not workspace-scoped) setting, applied on the next cold load only. (#770) */
  startupView: StartupView;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: 'blue',
  reduceMotion: false,
  fontFamily: '',
  fontSize: 13.5,
  lineHeight: 1.6,
  wordWrap: false,
  tabSize: 2,
  formatOnSave: true,
  autoSave: false,
  enableMinimap: false,
  defaultCanvasZoom: 100,
  lspTrace: 'off',
  aiProvider: 'anthropic',
  aiBaseUrl: 'https://api.openai.com/v1',
  aiApiKey: '',
  aiModel: 'claude-opus-4-8',
  aiModelOpenai: '',
  aiAgenticTools: false,
  aiInlineCompletions: false,
  aiConstrainGrammar: true,
  aiTemperature: 0.2,
  mcpEnabled: false,
  mcpPort: 56463,
  mcpClient: 'lm-studio',
  previewTarget: 'csharp',
  displayName: '',
  terminalShellArgs: [],
  startupView: 'home',
};

// --- storage keys --------------------------------------------------------------
// SETTINGS_KEY lives in ./storage (shared with the guarded JSON-object helpers there); imported above.

// Editor keybinding overrides (#266): a small Partial<Record<BindingId, string>> of user remaps.
const KEYBINDINGS_KEY = 'koine.studio.keybindings';

// Per-workspace settings overrides: a small Partial<Settings> blob keyed by a stable workspace hash.
// Only the four scoped fields (previewTarget, formatOnSave, wordWrap, lspTrace) can be stored here;
// all other settings are global and ignored in this store.
/** localStorage key prefix for per-workspace settings overrides (workspace key is appended).
 *  Exported so callers (e.g. the Storybook story) can build storage keys without hardcoding the literal. */
export const WORKSPACE_OVERRIDE_KEY_PREFIX = 'koine.studio.wsOverrides.';

/** The settings fields that can be overridden per workspace. */
export const WORKSPACE_SCOPED_KEYS: readonly (keyof Settings)[] = [
  'previewTarget',
  'formatOnSave',
  'wordWrap',
  'lspTrace',
];

// Editor font-size bounds — must match the Settings input range (prefs.ts) so a stored
// value can never drive the editor outside what the UI itself permits.
const FONT_MIN = 10;
const FONT_MAX = 22;

// Editor line-height bounds — likewise mirror the Settings input range in prefs.ts.
const LINE_HEIGHT_MIN = 1.2;
const LINE_HEIGHT_MAX = 2.4;

// Editor tab-size bounds — an integer indent width; mirror the Settings input range in prefs.ts.
const TAB_MIN = 1;
const TAB_MAX = 8;

// Assistant sampling-temperature bounds — both Anthropic and OpenAI accept 0..2.
const TEMP_MIN = 0;
const TEMP_MAX = 2;

// MCP sidecar loopback-port bounds — a TCP port number; 0 means "let the OS assign one". Mirror the
// Settings input range (prefs.ts) so a stored value can never drive the host outside what the UI permits.
const MCP_PORT_MIN = 0;
const MCP_PORT_MAX = 65535;

// The canonical accent roster. This data layer owns the list; the appearance layer derives its
// presets and picker order from it, so a new accent is added in exactly one place.
export const ACCENT_NAMES: readonly AccentName[] = ['blue', 'teal', 'violet', 'amber'];

// The canonical MCP-client roster, used to validate a stored mcpClient. The recipe UI (mcp.ts)
// owns the per-client copy; this layer only owns the set of valid ids.
const MCP_CLIENT_IDS: readonly McpClientId[] = ['claude-desktop', 'lm-studio', 'cursor', 'vscode', 'generic'];

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

/** A finite integer clamped into the tab-size range (rounded), else the default. */
function coerceTabSize(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.tabSize;
  return Math.min(Math.max(Math.round(v), TAB_MIN), TAB_MAX);
}

/** A finite number clamped into the assistant temperature range, else the default. */
function coerceTemperature(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.aiTemperature;
  return Math.min(Math.max(v, TEMP_MIN), TEMP_MAX);
}

/** A finite integer clamped into the TCP port range (rounded), else the default (56463). `0` is valid
 *  (OS-assigned port). Mirrors the MCP port input's bounds in prefs.ts, so what applies == what survives. */
function coerceMcpPort(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_SETTINGS.mcpPort;
  return Math.min(Math.max(Math.round(v), MCP_PORT_MIN), MCP_PORT_MAX);
}

/** A string font-family override (empty allowed), else the default empty string. */
function coerceFontFamily(v: unknown): string {
  return typeof v === 'string' ? v : DEFAULT_SETTINGS.fontFamily;
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
 * A supported preview target, else the default. Validated against the LIVE {@link EMIT_TARGETS}
 * (seeded from the backend at boot, issue #282) — not the build-time snapshot — so a persisted
 * target the backend still reports survives a reload, and one it no longer offers falls back to csharp.
 */
function coercePreviewTarget(v: unknown): PreviewTarget {
  return isEmitTarget(v) ? (v as PreviewTarget) : DEFAULT_SETTINGS.previewTarget;
}

/** A valid {@link StartupView} value, else the default ('home'). */
function coerceStartupView(v: unknown): StartupView {
  return isStartupView(v) ? v : DEFAULT_SETTINGS.startupView;
}

/** A list of shell-arg tokens (#467): an array filtered to its NON-BLANK string entries (always a fresh
 *  array, never the shared default reference). A blank token would spawn e.g. `bash ""`, which bash reads
 *  as a missing script path and exits — killing the terminal on every (re)start — so empty tokens are
 *  dropped, consistent with the "empty ⇒ unset" treatment of the whole list. Any non-array / absent /
 *  hand-edited garbage value yields a fresh copy of the declared default (the single source of truth). */
function coerceShellArgs(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DEFAULT_SETTINGS.terminalShellArgs];
  return v.filter((a): a is string => typeof a === 'string' && a.length > 0);
}

/** Validate a stored {@link Settings.defaultCanvasZoom}: a number clamped to the diagram zoom band
 *  (10–800), or the default (100) for a missing/non-numeric/garbage value (#762). */
function coerceDefaultCanvasZoom(v: unknown): number {
  if (typeof v !== 'number') return DEFAULT_SETTINGS.defaultCanvasZoom;
  return clampZoomPercent(v) ?? DEFAULT_SETTINGS.defaultCanvasZoom;
}

/**
 * Load settings, merging any stored partial onto DEFAULT_SETTINGS and validating each
 * field. Unknown shapes, bad JSON, and absent storage all fall back to the defaults.
 */
export function loadSettings(): Settings {
  const raw = readRaw(SETTINGS_KEY);
  // Even with no stored blob, surface the cached secret so the key survives a fresh settings object.
  if (raw === null) return { ...DEFAULT_SETTINGS, aiApiKey: getCachedApiKey() };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS, aiApiKey: getCachedApiKey() };
    return {
      theme: coerceTheme(parsed.theme),
      accent: coerceAccent(parsed.accent),
      reduceMotion: typeof parsed.reduceMotion === 'boolean' ? parsed.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
      fontFamily: coerceFontFamily(parsed.fontFamily),
      fontSize: coerceFontSize(parsed.fontSize),
      lineHeight: coerceLineHeight(parsed.lineHeight),
      wordWrap: typeof parsed.wordWrap === 'boolean' ? parsed.wordWrap : DEFAULT_SETTINGS.wordWrap,
      tabSize: coerceTabSize(parsed.tabSize),
      formatOnSave: typeof parsed.formatOnSave === 'boolean' ? parsed.formatOnSave : DEFAULT_SETTINGS.formatOnSave,
      autoSave: typeof parsed.autoSave === 'boolean' ? parsed.autoSave : DEFAULT_SETTINGS.autoSave,
      enableMinimap:
        typeof parsed.enableMinimap === 'boolean' ? parsed.enableMinimap : DEFAULT_SETTINGS.enableMinimap,
      defaultCanvasZoom: coerceDefaultCanvasZoom(parsed.defaultCanvasZoom),
      lspTrace: coerceTrace(parsed.lspTrace),
      aiProvider: parsed.aiProvider === 'openai' ? 'openai' : DEFAULT_SETTINGS.aiProvider,
      aiBaseUrl:
        typeof parsed.aiBaseUrl === 'string' && parsed.aiBaseUrl.length > 0 ? parsed.aiBaseUrl : DEFAULT_SETTINGS.aiBaseUrl,
      // The API key is never stored in this blob; it comes from the encrypted in-memory cache.
      aiApiKey: getCachedApiKey(),
      aiModel: typeof parsed.aiModel === 'string' && parsed.aiModel.length > 0 ? parsed.aiModel : DEFAULT_SETTINGS.aiModel,
      aiModelOpenai: typeof parsed.aiModelOpenai === 'string' ? parsed.aiModelOpenai : DEFAULT_SETTINGS.aiModelOpenai,
      aiAgenticTools:
        typeof parsed.aiAgenticTools === 'boolean' ? parsed.aiAgenticTools : DEFAULT_SETTINGS.aiAgenticTools,
      aiInlineCompletions:
        typeof parsed.aiInlineCompletions === 'boolean'
          ? parsed.aiInlineCompletions
          : DEFAULT_SETTINGS.aiInlineCompletions,
      aiConstrainGrammar:
        typeof parsed.aiConstrainGrammar === 'boolean'
          ? parsed.aiConstrainGrammar
          : DEFAULT_SETTINGS.aiConstrainGrammar,
      aiTemperature: coerceTemperature(parsed.aiTemperature),
      mcpEnabled: typeof parsed.mcpEnabled === 'boolean' ? parsed.mcpEnabled : DEFAULT_SETTINGS.mcpEnabled,
      mcpPort: coerceMcpPort(parsed.mcpPort),
      mcpClient: coerceMcpClient(parsed.mcpClient),
      previewTarget: coercePreviewTarget(parsed.previewTarget),
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : DEFAULT_SETTINGS.displayName,
      terminalShellArgs: coerceShellArgs(parsed.terminalShellArgs),
      startupView: coerceStartupView(parsed.startupView),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, aiApiKey: getCachedApiKey() };
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

// --- workspace-scoped settings overrides (#task-1) ---------------------------
// A small Partial<Settings> (only the four scoped fields) is persisted PER workspace under
// WORKSPACE_OVERRIDE_KEY_PREFIX + workspaceKey. The workspace key is a stable hash of the sorted
// root paths so workspace identity survives root reordering. effectiveSettings() merges the
// workspace overrides on top of the user-level settings, so workspace wins for scoped fields.

/**
 * A compact, stable, synchronous string hash of a list of root paths.
 * Roots are sorted first so the order the caller passes them does not matter.
 * Uses djb2 to keep the implementation small and dependency-free.
 */
export function workspaceKeyOf(roots: string[]): string {
  const joined = [...roots].sort().join('\0');
  // djb2 hash — deterministic, non-crypto, collision-resistant enough for namespacing localStorage.
  let h = 5381;
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) + h + joined.charCodeAt(i)) >>> 0; // keep 32-bit unsigned
  }
  return h.toString(36);
}

/**
 * Load the workspace-level override blob for the given key.
 * Returns only the four recognized scoped fields, each run through its coercer.
 * A missing key, non-object blob, or unparseable JSON returns {}.
 */
export function loadWorkspaceOverrides(key: string): Partial<Settings> {
  const blob = readJsonObject(WORKSPACE_OVERRIDE_KEY_PREFIX + key);
  const out: Partial<Settings> = {};
  if ('previewTarget' in blob) out.previewTarget = coercePreviewTarget(blob.previewTarget);
  if ('formatOnSave' in blob)
    out.formatOnSave =
      typeof blob.formatOnSave === 'boolean' ? blob.formatOnSave : DEFAULT_SETTINGS.formatOnSave;
  if ('wordWrap' in blob)
    out.wordWrap = typeof blob.wordWrap === 'boolean' ? blob.wordWrap : DEFAULT_SETTINGS.wordWrap;
  if ('lspTrace' in blob) out.lspTrace = coerceTrace(blob.lspTrace);
  return out;
}

/**
 * Set (or clear) a single scoped field in the workspace override blob.
 * Passing `null` as the value REMOVES the field from the blob.
 * Reads the current blob, applies the change, and writes it back via writeRaw.
 */
export function saveWorkspaceOverride<K extends keyof Settings>(
  key: string,
  field: K,
  value: Settings[K] | null,
): void {
  patchJsonBlob(WORKSPACE_OVERRIDE_KEY_PREFIX + key, field as string, value);
}

/**
 * Replace ALL workspace-level overrides for the given key in a single read-modify-write.
 * For each field in {@link WORKSPACE_SCOPED_KEYS}, sets it when present in `overrides`, else
 * deletes it from the blob — so a key removed from the JSON doc reverts that field to the User
 * value. An empty `overrides` ({}) deletes all four fields (clears every override for the workspace).
 */
export function replaceWorkspaceOverrides(key: string, overrides: Partial<Settings>): void {
  const storageKey = WORKSPACE_OVERRIDE_KEY_PREFIX + key;
  const blob = readJsonObject(storageKey);
  for (const k of WORKSPACE_SCOPED_KEYS) {
    if (Object.prototype.hasOwnProperty.call(overrides, k)) {
      blob[k as string] = overrides[k as keyof Settings];
    } else {
      delete blob[k as string];
    }
  }
  writeRaw(storageKey, JSON.stringify(blob));
}

/**
 * Return the effective settings for a workspace: user settings merged with any workspace-level
 * overrides. When `workspaceKey` is null, or when no override blob exists for it, the result
 * is the user settings object unchanged (identity semantics — no extra allocation).
 */
export function effectiveSettings(user: Settings, workspaceKey: string | null): Settings {
  if (workspaceKey === null) return user;
  const overrides = loadWorkspaceOverrides(workspaceKey);
  if (Object.keys(overrides).length === 0) return user;
  return { ...user, ...overrides };
}

// --- editor keybinding overrides (#266) --------------------------------------
// The Settings → Keyboard panel can remap any of the editor's LSP-action shortcuts. Only the user's
// REMAPS live here (a sparse Partial keyed by BindingId); the defaults stay in keybindings.ts so the
// two can't drift. resolveKeybindings() layers the overrides over DEFAULT_BINDINGS for the editor to
// load. An empty-string value is a deliberate "unbound" override (kept), distinct from "no override".

/**
 * The user's keybinding remaps. Drops unknown ids (not a BindingId) and non-string values so a
 * hand-edited or stale key can never feed the editor a bad map; an absent/corrupt blob returns {}.
 */
export function loadKeybindingOverrides(): Partial<Record<BindingId, string>> {
  const blob = readJsonObject(KEYBINDINGS_KEY);
  const out: Partial<Record<BindingId, string>> = {};
  for (const [id, value] of Object.entries(blob)) {
    // Keep only known BindingIds with a string value ('' is the deliberate "unbound" override).
    // hasOwnProperty, not `in` — `in` is true for inherited Object keys ('toString', 'constructor'),
    // which would let a hand-edited blob smuggle a bogus id past the "drop unknown ids" guard.
    if (Object.prototype.hasOwnProperty.call(DEFAULT_BINDINGS, id) && typeof value === 'string') {
      out[id as BindingId] = value;
    }
  }
  return out;
}

/** The full keybinding map the editor loads: defaults with the user's overrides layered on top. */
export function resolveKeybindings(): Record<BindingId, string> {
  return { ...DEFAULT_BINDINGS, ...loadKeybindingOverrides() };
}

/**
 * Set (or clear) a single keybinding override. Passing `null` REMOVES the remap so the default wins
 * again. Reads the current blob, applies the change, and writes it back via writeRaw.
 */
export function saveKeybindingOverride(id: BindingId, key: string | null): void {
  patchJsonBlob(KEYBINDINGS_KEY, id, key);
}

/** Forget all keybinding overrides — resolveKeybindings() then returns pure defaults. */
export function clearKeybindingOverrides(): void {
  removeKey(KEYBINDINGS_KEY);
}
