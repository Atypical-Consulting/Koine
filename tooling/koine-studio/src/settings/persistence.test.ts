import { describe, expect, it, test, beforeEach } from 'vitest';
import {
  loadSettings,
  saveSettings,
  patchSettings,
  DEFAULT_SETTINGS,
  initSecrets,
  saveApiKey,
  clearApiKey,
  loadChat,
  saveChat,
  clearChat,
  CHAT_HISTORY_CAP,
  peekLegacyScratch,
  clearLegacyScratch,
  loadWorkspaceCenter,
  saveWorkspaceCenter,
  loadWorkspaceDeck,
  saveWorkspaceDeck,
  getLastWorkspace,
  setLastWorkspace,
  clearLastWorkspace,
  loadDiagramZoom,
  saveDiagramZoom,
  loadDiagramPositions,
  saveDiagramPositions,
  clearDiagramPositions,
  loadActiveContext,
  saveActiveContext,
  getRecentFolders,
  pushRecentFolder,
  removeRecentFolder,
  pinRecentFolder,
  clearRecentFolders,
  workspaceKeyOf,
  loadWorkspaceOverrides,
  saveWorkspaceOverride,
  effectiveSettings,
  WORKSPACE_SCOPED_KEYS,
  loadKeybindingOverrides,
  saveKeybindingOverride,
  resolveKeybindings,
  clearKeybindingOverrides,
} from '@/settings/persistence';
import { DEFAULT_DECK_STATE, isValidDeckState } from '@/store/slices/uiChrome';
import type { DeckState } from '@/store/slices/uiChrome';
import { BUILTIN_EMIT_TARGETS, setEmitTargets } from '@/shared/emitTargets';
import { DEFAULT_BINDINGS } from '@/editor/keybindings';
import type { ChatMessage } from '@/ai/ai';

describe('MCP settings', () => {
  beforeEach(() => localStorage.clear());

  test('defaults: MCP disabled, LM Studio recipe', () => {
    expect(DEFAULT_SETTINGS.mcpEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.mcpClient).toBe('lm-studio');
    expect(loadSettings().mcpEnabled).toBe(false);
  });

  test('coerces a bogus stored mcpClient back to the default', () => {
    saveSettings({ ...DEFAULT_SETTINGS, mcpClient: 'nonsense' as never });
    expect(loadSettings().mcpClient).toBe('lm-studio');
  });

  test('round-trips an enabled state', () => {
    saveSettings({ ...DEFAULT_SETTINGS, mcpEnabled: true, mcpClient: 'cursor' });
    expect(loadSettings().mcpEnabled).toBe(true);
    expect(loadSettings().mcpClient).toBe('cursor');
  });
});

describe('Assistant agentic-tools setting', () => {
  beforeEach(() => localStorage.clear());

  test('defaults off so replies stream out of the box', () => {
    expect(DEFAULT_SETTINGS.aiAgenticTools).toBe(false);
    expect(loadSettings().aiAgenticTools).toBe(false);
  });

  test('round-trips an opted-in state', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiAgenticTools: true });
    expect(loadSettings().aiAgenticTools).toBe(true);
  });

  test('falls back to the default when the stored value is not a boolean', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiAgenticTools: 'yes' as never });
    expect(loadSettings().aiAgenticTools).toBe(false);
  });
});

describe('Assistant inline-completions setting', () => {
  beforeEach(() => localStorage.clear());

  test('defaults off so there is no surprise API spend while typing', () => {
    expect(DEFAULT_SETTINGS.aiInlineCompletions).toBe(false);
    expect(loadSettings().aiInlineCompletions).toBe(false);
  });

  test('round-trips an opted-in state', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiInlineCompletions: true });
    expect(loadSettings().aiInlineCompletions).toBe(true);
  });

  test('falls back to the default when the stored value is not a boolean', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiInlineCompletions: 'on' as never });
    expect(loadSettings().aiInlineCompletions).toBe(false);
  });
});

describe('Assistant constrain-grammar setting (#257)', () => {
  beforeEach(() => localStorage.clear());

  test('defaults ON so generated .koi is guaranteed to parse out of the box', () => {
    expect(DEFAULT_SETTINGS.aiConstrainGrammar).toBe(true);
    expect(loadSettings().aiConstrainGrammar).toBe(true);
  });

  test('round-trips an opted-out state', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiConstrainGrammar: false });
    expect(loadSettings().aiConstrainGrammar).toBe(false);
  });

  test('falls back to the default (true) when the stored value is not a boolean', () => {
    saveSettings({ ...DEFAULT_SETTINGS, aiConstrainGrammar: 'yes' as never });
    expect(loadSettings().aiConstrainGrammar).toBe(true);
  });

  test('falls back to the default (true) when the field is absent from the stored blob', () => {
    localStorage.setItem('koine.studio.settings', JSON.stringify({ theme: 'light' }));
    expect(loadSettings().aiConstrainGrammar).toBe(true);
  });
});

describe('Editor autoSave + enableMinimap settings', () => {
  beforeEach(() => localStorage.clear());

  test('both default off (opt-in)', () => {
    expect(DEFAULT_SETTINGS.autoSave).toBe(false);
    expect(DEFAULT_SETTINGS.enableMinimap).toBe(false);
    expect(loadSettings().autoSave).toBe(false);
    expect(loadSettings().enableMinimap).toBe(false);
  });

  test('round-trips opted-in states', () => {
    saveSettings({ ...DEFAULT_SETTINGS, autoSave: true, enableMinimap: true });
    expect(loadSettings().autoSave).toBe(true);
    expect(loadSettings().enableMinimap).toBe(true);
  });

  test('falls back to the default when a stored value is not a boolean', () => {
    saveSettings({ ...DEFAULT_SETTINGS, autoSave: 'yes' as never, enableMinimap: 1 as never });
    expect(loadSettings().autoSave).toBe(false);
    expect(loadSettings().enableMinimap).toBe(false);
  });

  test('falls back to the default when the fields are absent from the stored blob', () => {
    localStorage.setItem('koine.studio.settings', JSON.stringify({ theme: 'light' }));
    expect(loadSettings().autoSave).toBe(false);
    expect(loadSettings().enableMinimap).toBe(false);
  });
});

describe('Review-comment display name (#479)', () => {
  beforeEach(() => localStorage.clear());

  test('defaults to an empty string (the review-author fallback applies)', () => {
    expect(DEFAULT_SETTINGS.displayName).toBe('');
    expect(loadSettings().displayName).toBe('');
  });

  test('round-trips a saved non-empty name', () => {
    saveSettings({ ...DEFAULT_SETTINGS, displayName: 'Ada Lovelace' });
    expect(loadSettings().displayName).toBe('Ada Lovelace');
  });

  test('coerces a stored non-string displayName back to an empty string', () => {
    saveSettings({ ...DEFAULT_SETTINGS, displayName: 42 as never });
    expect(loadSettings().displayName).toBe('');
  });

  test('falls back to an empty string when displayName is absent from the stored blob', () => {
    localStorage.setItem('koine.studio.settings', JSON.stringify({ theme: 'light' }));
    expect(loadSettings().displayName).toBe('');
  });
});

describe('API key secret', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearApiKey();
  });

  test('is never written to the plaintext settings blob, yet surfaces via loadSettings', async () => {
    await saveApiKey('sk-must-not-leak');
    patchSettings({ theme: 'light' }); // force a saveSettings write
    const raw = localStorage.getItem('koine.studio.settings') ?? '';
    expect(raw).not.toContain('sk-must-not-leak');
    expect(raw).not.toContain('aiApiKey');
    expect(loadSettings().aiApiKey).toBe('sk-must-not-leak');
  });

  test('migrates a legacy plaintext key into the encrypted store and scrubs the blob', async () => {
    localStorage.setItem('koine.studio.settings', JSON.stringify({ ...DEFAULT_SETTINGS, aiApiKey: 'sk-legacy' }));
    await initSecrets();
    expect(loadSettings().aiApiKey).toBe('sk-legacy');
    const raw = localStorage.getItem('koine.studio.settings') ?? '';
    expect(raw).not.toContain('sk-legacy');
    expect(JSON.parse(raw).aiApiKey).toBeUndefined();
  });

  test('clearApiKey forgets the secret', async () => {
    await saveApiKey('sk-temp');
    expect(loadSettings().aiApiKey).toBe('sk-temp');
    await clearApiKey();
    expect(loadSettings().aiApiKey).toBe('');
  });
});

describe('Assistant conversation persistence', () => {
  beforeEach(() => localStorage.clear());

  test('round-trips a ChatMessage[] for a workspace key', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'model an Order aggregate' },
      { role: 'assistant', content: '```koine\ncontext Sales { }\n```' },
    ];
    saveChat('scratch', msgs);
    expect(loadChat('scratch')).toEqual(msgs);
  });

  test('an absent key loads as the empty transcript', () => {
    expect(loadChat('never-saved')).toEqual([]);
  });

  test('a malformed stored blob loads as the empty transcript', () => {
    localStorage.setItem('koine.studio.chat.k', '{bad');
    expect(loadChat('k')).toEqual([]);
  });

  test('a stored non-array loads as the empty transcript', () => {
    localStorage.setItem('koine.studio.chat.k', JSON.stringify({ role: 'user', content: 'hi' }));
    expect(loadChat('k')).toEqual([]);
  });

  test('entries with a wrong shape are filtered out', () => {
    const stored = [
      { role: 'user', content: 'ok' }, // well-formed
      { role: 'system', content: 'bad role' }, // wrong role
      { role: 'assistant', content: 42 }, // non-string content
      { role: 'assistant' }, // missing content
      'nope', // not an object
      { role: 'assistant', content: 'kept' }, // well-formed
    ];
    localStorage.setItem('koine.studio.chat.k', JSON.stringify(stored));
    expect(loadChat('k')).toEqual([
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'kept' },
    ]);
  });

  test('caps the stored transcript to the last CHAT_HISTORY_CAP messages', () => {
    const overflow: ChatMessage[] = Array.from({ length: CHAT_HISTORY_CAP + 25 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `m${i}`,
    }));
    saveChat('scratch', overflow);
    const loaded = loadChat('scratch');
    expect(loaded.length).toBe(CHAT_HISTORY_CAP);
    // Only the LAST CHAT_HISTORY_CAP survive — the oldest are dropped.
    expect(loaded[0].content).toBe(`m${25}`);
    expect(loaded[loaded.length - 1].content).toBe(`m${CHAT_HISTORY_CAP + 24}`);
  });

  test('clearChat empties the stored transcript', () => {
    saveChat('scratch', [{ role: 'user', content: 'hi' }]);
    expect(loadChat('scratch').length).toBe(1);
    clearChat('scratch');
    expect(loadChat('scratch')).toEqual([]);
  });

  test('uses a distinct namespace, leaving settings/scratch/secrets untouched', async () => {
    await clearApiKey();
    await saveApiKey('sk-must-not-leak');
    patchSettings({ theme: 'light' }); // write a settings blob
    localStorage.setItem('koine.studio.scratch', 'context Sales { }');

    // Snapshot the sibling blobs, then write a chat under the same logical name.
    const settingsBefore = localStorage.getItem('koine.studio.settings');
    const scratchBefore = localStorage.getItem('koine.studio.scratch');
    saveChat('scratch', [{ role: 'user', content: 'chat content' }]);

    // The settings and scratch blobs are byte-for-byte untouched by the chat write.
    expect(localStorage.getItem('koine.studio.settings')).toBe(settingsBefore);
    expect(localStorage.getItem('koine.studio.scratch')).toBe(scratchBefore);
    // The encrypted secret path is not involved: the plaintext chat blob never carries the key.
    expect(localStorage.getItem('koine.studio.chat.scratch') ?? '').not.toContain('sk-must-not-leak');
    expect(loadSettings().aiApiKey).toBe('sk-must-not-leak');
    // The chat lives under its own namespaced key.
    expect(loadChat('scratch')).toEqual([{ role: 'user', content: 'chat content' }]);
  });
});

const KEY = 'koine.studio.recentFolders';

describe('recent folders migration', () => {
  beforeEach(() => localStorage.clear());

  it('upgrades a legacy string[] to RecentFolder[] preserving order', () => {
    localStorage.setItem(KEY, JSON.stringify(['/a/one', '/b/two']));
    const got = getRecentFolders();
    expect(got.map((r) => r.path)).toEqual(['/a/one', '/b/two']);
    expect(got[0]).toMatchObject({ path: '/a/one', pinned: false });
    expect(typeof got[0].openedAt).toBe('number');
  });

  it('sorts pinned entries above unpinned, then by openedAt desc', () => {
    localStorage.setItem(KEY, JSON.stringify([
      { path: '/old', openedAt: 1 },
      { path: '/new', openedAt: 9 },
      { path: '/pin', openedAt: 2, pinned: true },
    ]));
    expect(getRecentFolders().map((r) => r.path)).toEqual(['/pin', '/new', '/old']);
  });

  it('returns [] for malformed JSON', () => {
    localStorage.setItem(KEY, '{not json');
    expect(getRecentFolders()).toEqual([]);
  });
});

describe('recent folders mutations', () => {
  beforeEach(() => localStorage.clear());

  it('push upserts and moves an existing path to the front', () => {
    pushRecentFolder('/a'); pushRecentFolder('/b'); pushRecentFolder('/a');
    expect(getRecentFolders().map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('push preserves an entry pinned state on re-open', () => {
    pushRecentFolder('/a');
    pinRecentFolder('/a', true);
    pushRecentFolder('/a');
    expect(getRecentFolders()[0]).toMatchObject({ path: '/a', pinned: true });
  });

  it('remove drops a single entry', () => {
    pushRecentFolder('/a'); pushRecentFolder('/b');
    removeRecentFolder('/a');
    expect(getRecentFolders().map((r) => r.path)).toEqual(['/b']);
  });

  it('pin floats an entry above more-recent unpinned ones', () => {
    pushRecentFolder('/a'); pushRecentFolder('/b'); // b newer
    pinRecentFolder('/a', true);
    expect(getRecentFolders().map((r) => r.path)).toEqual(['/a', '/b']);
  });

  it('clear removes everything including pinned', () => {
    pushRecentFolder('/a'); pinRecentFolder('/a', true);
    clearRecentFolders();
    expect(getRecentFolders()).toEqual([]);
  });
});

describe('legacy scratch migration helpers', () => {
  beforeEach(() => localStorage.clear());

  test('peekLegacyScratch returns the stored value without clearing it', () => {
    localStorage.setItem('koine.studio.scratch', 'context Legacy {}');
    expect(peekLegacyScratch()).toBe('context Legacy {}');
    expect(peekLegacyScratch()).toBe('context Legacy {}'); // still present — not cleared
    expect(localStorage.getItem('koine.studio.scratch')).toBe('context Legacy {}');
  });

  test('clearLegacyScratch removes the key; peekLegacyScratch returns null afterward', () => {
    localStorage.setItem('koine.studio.scratch', 'context Legacy {}');
    clearLegacyScratch();
    expect(peekLegacyScratch()).toBeNull();
    expect(localStorage.getItem('koine.studio.scratch')).toBeNull();
  });
});

describe('workspace center-pane persistence', () => {
  beforeEach(() => localStorage.clear());

  test('returns null when no center has been stored', () => {
    expect(loadWorkspaceCenter()).toBeNull();
  });

  test('round-trips a saved center through the store helper', () => {
    saveWorkspaceCenter('docs');
    expect(loadWorkspaceCenter()).toBe('docs');
    saveWorkspaceCenter('technical'); // a later save overwrites the prior one
    expect(loadWorkspaceCenter()).toBe('technical');
  });
});

describe('deck layout persistence', () => {
  beforeEach(() => localStorage.clear());

  test('returns DEFAULT_DECK_STATE when nothing is stored', () => {
    expect(loadWorkspaceDeck()).toEqual(DEFAULT_DECK_STATE);
  });

  test('round-trips a 2-up deck state', () => {
    const deck: DeckState = { mode: 'focus', primary: 'technical', secondary: 'visual', ratio: 0.4, flipped: true };
    saveWorkspaceDeck(deck);
    expect(loadWorkspaceDeck()).toEqual(deck);
  });

  test('returns DEFAULT_DECK_STATE when stored JSON is malformed', () => {
    localStorage.setItem('koine.studio.workspaceDeck', '{not valid json');
    expect(loadWorkspaceDeck()).toEqual(DEFAULT_DECK_STATE);
  });

  test('migrates a pre-Deck split layout: focused pane → primary, the other → secondary, sizes[0] → ratio', () => {
    localStorage.setItem(
      'koine.studio.workspaceCenterLayout',
      JSON.stringify({
        orientation: 'row',
        panes: [
          { id: 'pane-0', view: 'visual' },
          { id: 'pane-1', view: 'docs' },
        ],
        sizes: [0.6, 0.4],
        focusedPaneId: 'pane-1',
      }),
    );
    const result = loadWorkspaceDeck();
    expect(isValidDeckState(result)).toBe(true);
    expect(result.primary).toBe('docs'); // the focused pane
    expect(result.secondary).toBe('visual');
    expect(result.ratio).toBe(0.6);
  });

  test('migrates a legacy workspaceCenter = "docs" to a 1-up deck on Docs', () => {
    localStorage.setItem('koine.studio.workspaceCenter', 'docs');
    const result = loadWorkspaceDeck();
    expect(isValidDeckState(result)).toBe(true);
    expect(result.primary).toBe('docs');
    expect(result.secondary).toBeNull();
  });

  test('ignores a legacy workspaceCenter with an unknown view and returns default', () => {
    localStorage.setItem('koine.studio.workspaceCenter', 'unknown-view');
    expect(loadWorkspaceDeck()).toEqual(DEFAULT_DECK_STATE);
  });
});

describe('last-opened workspace pointer (#535)', () => {
  beforeEach(() => localStorage.clear());

  test('round-trips a token through set/get', () => {
    setLastWorkspace('example-saas-subscription');
    expect(getLastWorkspace()).toBe('example-saas-subscription');
    setLastWorkspace('(default)'); // a later save overwrites the prior one
    expect(getLastWorkspace()).toBe('(default)');
  });

  test('clearLastWorkspace makes a stored token null', () => {
    setLastWorkspace('example-saas-subscription');
    clearLastWorkspace();
    expect(getLastWorkspace()).toBeNull();
  });

  test('returns null when no token has been stored', () => {
    expect(getLastWorkspace()).toBeNull();
  });

  test('ignores an empty token (never persists "")', () => {
    setLastWorkspace('');
    expect(getLastWorkspace()).toBeNull();
  });
});

describe('diagram zoom persistence (#145)', () => {
  beforeEach(() => localStorage.clear());

  test('returns null when no zoom has been stored for the key', () => {
    expect(loadDiagramZoom('Ordering / Order aggregate')).toBeNull();
  });

  test('round-trips a saved zoom percent, namespaced per diagram key', () => {
    saveDiagramZoom('Ordering / Order', 150);
    saveDiagramZoom('Billing / Invoice', 75);
    expect(loadDiagramZoom('Ordering / Order')).toBe(150);
    expect(loadDiagramZoom('Billing / Invoice')).toBe(75);
    saveDiagramZoom('Ordering / Order', 220); // a later save overwrites the prior one
    expect(loadDiagramZoom('Ordering / Order')).toBe(220);
  });

  test('clamps an out-of-band zoom to the sane [10, 800] window on save', () => {
    saveDiagramZoom('huge', 5000);
    saveDiagramZoom('tiny', 1);
    expect(loadDiagramZoom('huge')).toBe(800);
    expect(loadDiagramZoom('tiny')).toBe(10);
  });

  test('rejects a non-finite percent rather than persisting garbage', () => {
    saveDiagramZoom('nan', Number.NaN);
    expect(loadDiagramZoom('nan')).toBeNull();
  });

  test('coerces a hand-edited/malformed stored value back to null', () => {
    localStorage.setItem('koine.studio.diagramZoom.bad', 'not-a-number');
    expect(loadDiagramZoom('bad')).toBeNull();
  });
});

describe('active context persistence (#146)', () => {
  beforeEach(() => localStorage.clear());

  test('returns null for a workspace with no stored scope', () => {
    expect(loadActiveContext('scratch')).toBeNull();
  });

  test('round-trips a saved scope per workspace key', () => {
    saveActiveContext('scratch', 'Sales');
    expect(loadActiveContext('scratch')).toBe('Sales');
    saveActiveContext('scratch', 'all'); // a later save overwrites the prior one
    expect(loadActiveContext('scratch')).toBe('all');
  });

  test('keeps each workspace scope independent', () => {
    saveActiveContext('/work/billing', 'Billing');
    saveActiveContext('/work/pizzeria', 'Kitchen');
    expect(loadActiveContext('/work/billing')).toBe('Billing');
    expect(loadActiveContext('/work/pizzeria')).toBe('Kitchen');
    expect(loadActiveContext('scratch')).toBeNull();
  });
});

describe('Output / previewTarget setting', () => {
  beforeEach(() => localStorage.clear());

  test('defaults to C#', () => {
    expect(DEFAULT_SETTINGS.previewTarget).toBe('csharp');
    expect(loadSettings().previewTarget).toBe('csharp');
  });

  test('round-trips a chosen target', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'php' });
    expect(loadSettings().previewTarget).toBe('php');
  });

  test('coerces a bogus stored target back to the default', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'cobol' as never });
    expect(loadSettings().previewTarget).toBe('csharp');
  });

  test('round-trips the Rust target', () => {
    saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'rust' });
    expect(loadSettings().previewTarget).toBe('rust');
  });

  test('a stored target is validated against the backend-seeded list, not just the built-ins (#282)', () => {
    // A target the backend reports (seeded at boot) must survive a reload even though it is not a
    // build-time built-in; one the backend no longer offers falls back to the default.
    try {
      setEmitTargets([...BUILTIN_EMIT_TARGETS, { id: 'go', displayName: 'Go', fileExtension: '.go' }]);
      saveSettings({ ...DEFAULT_SETTINGS, previewTarget: 'go' });
      expect(loadSettings().previewTarget).toBe('go');

      setEmitTargets(null); // backend no longer offers 'go' (offline / dropped) → fall back.
      expect(loadSettings().previewTarget).toBe('csharp');
    } finally {
      setEmitTargets(null);
    }
  });
});

describe('diagram node positions (authoring canvas)', () => {
  beforeEach(() => localStorage.clear());

  test('round-trips a positions map keyed by qualified name', () => {
    const positions = { 'Ordering.Order': { x: 120, y: 40 }, 'Ordering.OrderLine': { x: 360, y: 220 } };
    saveDiagramPositions('ws-a:koi-domain-diagram', positions);
    expect(loadDiagramPositions('ws-a:koi-domain-diagram')).toEqual(positions);
  });

  test('an absent key loads as an empty map', () => {
    expect(loadDiagramPositions('nope:koi-domain-diagram')).toEqual({});
  });

  test('malformed JSON / non-object / array loads as an empty map', () => {
    localStorage.setItem('koine.studio.diagramPositions.bad', '{not json');
    expect(loadDiagramPositions('bad')).toEqual({});
    localStorage.setItem('koine.studio.diagramPositions.arr', '[1,2,3]');
    expect(loadDiagramPositions('arr')).toEqual({});
  });

  test('drops entries with non-finite or missing coordinates, keeps the good ones', () => {
    localStorage.setItem(
      'koine.studio.diagramPositions.mixed',
      JSON.stringify({ Good: { x: 1, y: 2 }, NaNx: { x: 'oops', y: 2 }, Partial: { x: 5 }, InfY: { x: 0, y: Infinity } }),
    );
    expect(loadDiagramPositions('mixed')).toEqual({ Good: { x: 1, y: 2 } });
  });

  test('positions are isolated per workspace+diagram key', () => {
    saveDiagramPositions('ws-a:koi-domain-diagram', { 'A.B': { x: 1, y: 1 } });
    saveDiagramPositions('ws-b:koi-domain-diagram', { 'A.B': { x: 9, y: 9 } });
    expect(loadDiagramPositions('ws-a:koi-domain-diagram')).toEqual({ 'A.B': { x: 1, y: 1 } });
    expect(loadDiagramPositions('ws-b:koi-domain-diagram')).toEqual({ 'A.B': { x: 9, y: 9 } });
  });

  test('clearDiagramPositions forgets a saved layout', () => {
    saveDiagramPositions('ws:koi-domain-diagram', { 'A.B': { x: 1, y: 1 } });
    clearDiagramPositions('ws:koi-domain-diagram');
    expect(loadDiagramPositions('ws:koi-domain-diagram')).toEqual({});
  });
});

describe('workspace-scoped settings overrides', () => {
  beforeEach(() => localStorage.clear());

  // --- workspaceKeyOf ---

  test('workspaceKeyOf is stable under root reordering (sorts before hashing)', () => {
    const key1 = workspaceKeyOf(['/a/project', '/b/lib']);
    const key2 = workspaceKeyOf(['/b/lib', '/a/project']);
    expect(key1).toBe(key2);
    expect(typeof key1).toBe('string');
    expect(key1.length).toBeGreaterThan(0);
  });

  test('workspaceKeyOf returns distinct keys for distinct root sets', () => {
    const keyA = workspaceKeyOf(['/a/project']);
    const keyB = workspaceKeyOf(['/b/project']);
    expect(keyA).not.toBe(keyB);
  });

  test('workspaceKeyOf returns a stable value for an empty roots array', () => {
    const k1 = workspaceKeyOf([]);
    const k2 = workspaceKeyOf([]);
    expect(k1).toBe(k2);
  });

  // --- WORKSPACE_SCOPED_KEYS ---

  test('WORKSPACE_SCOPED_KEYS contains exactly the four scoped fields', () => {
    expect(WORKSPACE_SCOPED_KEYS).toContain('previewTarget');
    expect(WORKSPACE_SCOPED_KEYS).toContain('formatOnSave');
    expect(WORKSPACE_SCOPED_KEYS).toContain('wordWrap');
    expect(WORKSPACE_SCOPED_KEYS).toContain('lspTrace');
    expect(WORKSPACE_SCOPED_KEYS.length).toBe(4);
  });

  // --- saveWorkspaceOverride + loadWorkspaceOverrides round-trip ---

  test('saveWorkspaceOverride then loadWorkspaceOverrides round-trips only the scoped fields', () => {
    const key = workspaceKeyOf(['/work/billing']);
    saveWorkspaceOverride(key, 'previewTarget', 'typescript');
    saveWorkspaceOverride(key, 'formatOnSave', false);
    saveWorkspaceOverride(key, 'wordWrap', true);
    saveWorkspaceOverride(key, 'lspTrace', 'messages');
    const overrides = loadWorkspaceOverrides(key);
    expect(overrides.previewTarget).toBe('typescript');
    expect(overrides.formatOnSave).toBe(false);
    expect(overrides.wordWrap).toBe(true);
    expect(overrides.lspTrace).toBe('messages');
  });

  test('a second saveWorkspaceOverride for the same field overwrites the prior value', () => {
    const key = workspaceKeyOf(['/work/billing']);
    saveWorkspaceOverride(key, 'lspTrace', 'messages');
    saveWorkspaceOverride(key, 'lspTrace', 'verbose');
    expect(loadWorkspaceOverrides(key).lspTrace).toBe('verbose');
  });

  test('overrides are isolated per workspace key', () => {
    const keyA = workspaceKeyOf(['/work/billing']);
    const keyB = workspaceKeyOf(['/work/ordering']);
    saveWorkspaceOverride(keyA, 'wordWrap', true);
    saveWorkspaceOverride(keyB, 'wordWrap', false);
    expect(loadWorkspaceOverrides(keyA).wordWrap).toBe(true);
    expect(loadWorkspaceOverrides(keyB).wordWrap).toBe(false);
  });

  // --- clearing an override (value null) ---

  test('passing null removes the field from the override blob', () => {
    const key = workspaceKeyOf(['/work/billing']);
    saveWorkspaceOverride(key, 'wordWrap', true);
    expect(loadWorkspaceOverrides(key).wordWrap).toBe(true);
    saveWorkspaceOverride(key, 'wordWrap', null);
    expect(loadWorkspaceOverrides(key).wordWrap).toBeUndefined();
  });

  test('removing the only override leaves an empty (but valid) object', () => {
    const key = workspaceKeyOf(['/work/billing']);
    saveWorkspaceOverride(key, 'formatOnSave', false);
    saveWorkspaceOverride(key, 'formatOnSave', null);
    expect(loadWorkspaceOverrides(key)).toEqual({});
  });

  // --- guard discipline: corrupt / absent blob ---

  test('a corrupt override blob loads as {} without throwing', () => {
    const key = workspaceKeyOf(['/work/billing']);
    localStorage.setItem(`koine.studio.wsOverrides.${key}`, '{not valid json');
    expect(loadWorkspaceOverrides(key)).toEqual({});
  });

  test('a non-object override blob (array) loads as {}', () => {
    const key = workspaceKeyOf(['/work/billing']);
    localStorage.setItem(`koine.studio.wsOverrides.${key}`, '[1,2,3]');
    expect(loadWorkspaceOverrides(key)).toEqual({});
  });

  test('an absent override key loads as {}', () => {
    const key = workspaceKeyOf(['/work/new-project']);
    expect(loadWorkspaceOverrides(key)).toEqual({});
  });

  test('unknown keys in the override blob are not echoed back', () => {
    const key = workspaceKeyOf(['/work/billing']);
    localStorage.setItem(`koine.studio.wsOverrides.${key}`, JSON.stringify({ previewTarget: 'csharp', unknownKey: 'bad', theme: 'light' }));
    const overrides = loadWorkspaceOverrides(key);
    expect(overrides.previewTarget).toBe('csharp');
    expect((overrides as Record<string, unknown>).unknownKey).toBeUndefined();
    expect((overrides as Record<string, unknown>).theme).toBeUndefined();
  });

  test('coerces a bogus stored lspTrace back to the default', () => {
    const key = workspaceKeyOf(['/work/billing']);
    localStorage.setItem(`koine.studio.wsOverrides.${key}`, JSON.stringify({ lspTrace: 'turbo' }));
    expect(loadWorkspaceOverrides(key).lspTrace).toBe(DEFAULT_SETTINGS.lspTrace);
  });

  test('coerces a bogus stored previewTarget back to the default', () => {
    const key = workspaceKeyOf(['/work/billing']);
    localStorage.setItem(`koine.studio.wsOverrides.${key}`, JSON.stringify({ previewTarget: 'cobol' }));
    expect(loadWorkspaceOverrides(key).previewTarget).toBe(DEFAULT_SETTINGS.previewTarget);
  });

  test('coerces a non-boolean stored formatOnSave back to the default', () => {
    const key = workspaceKeyOf(['/work/billing']);
    localStorage.setItem(`koine.studio.wsOverrides.${key}`, JSON.stringify({ formatOnSave: 'yes' }));
    expect(loadWorkspaceOverrides(key).formatOnSave).toBe(DEFAULT_SETTINGS.formatOnSave);
  });

  test('coerces a non-boolean stored wordWrap back to the default', () => {
    const key = workspaceKeyOf(['/work/billing']);
    localStorage.setItem(`koine.studio.wsOverrides.${key}`, JSON.stringify({ wordWrap: 1 }));
    expect(loadWorkspaceOverrides(key).wordWrap).toBe(DEFAULT_SETTINGS.wordWrap);
  });

  // --- effectiveSettings ---

  test('effectiveSettings is identity when workspaceKey is null', () => {
    const user: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS, wordWrap: true };
    const result = effectiveSettings(user, null);
    expect(result).toEqual(user);
  });

  test('effectiveSettings is identity when no override exists for the workspace', () => {
    const key = workspaceKeyOf(['/work/empty']);
    const user: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS, lspTrace: 'verbose' };
    const result = effectiveSettings(user, key);
    expect(result).toEqual(user);
  });

  test('effectiveSettings merges workspace overrides over user settings', () => {
    const key = workspaceKeyOf(['/work/billing']);
    saveWorkspaceOverride(key, 'previewTarget', 'typescript');
    saveWorkspaceOverride(key, 'wordWrap', true);
    const user: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS, wordWrap: false, previewTarget: 'csharp' };
    const result = effectiveSettings(user, key);
    // Workspace overrides win for scoped fields:
    expect(result.wordWrap).toBe(true);
    expect(result.previewTarget).toBe('typescript');
    // Non-scoped fields come from user settings:
    expect(result.theme).toBe(user.theme);
    expect(result.fontSize).toBe(user.fontSize);
  });

  test('effectiveSettings does not mutate the original user settings object', () => {
    const key = workspaceKeyOf(['/work/billing']);
    saveWorkspaceOverride(key, 'wordWrap', true);
    const user: typeof DEFAULT_SETTINGS = { ...DEFAULT_SETTINGS, wordWrap: false };
    effectiveSettings(user, key);
    expect(user.wordWrap).toBe(false);
  });
});

describe('keybinding overrides', () => {
  beforeEach(() => localStorage.clear());

  test('a saved override resolves over the defaults, leaving the others default', () => {
    saveKeybindingOverride('format', 'Ctrl-d');
    const resolved = resolveKeybindings();
    expect(resolved.format).toBe('Ctrl-d');
    expect(resolved.goToDefinition).toBe(DEFAULT_BINDINGS.goToDefinition);
    expect(resolved.rename).toBe(DEFAULT_BINDINGS.rename);
    expect(resolved.findReferences).toBe(DEFAULT_BINDINGS.findReferences);
    expect(resolved.codeActions).toBe(DEFAULT_BINDINGS.codeActions);
  });

  test('passing null clears an override, restoring the default', () => {
    saveKeybindingOverride('format', 'Ctrl-d');
    expect(resolveKeybindings().format).toBe('Ctrl-d');
    saveKeybindingOverride('format', null);
    expect(resolveKeybindings().format).toBe('Mod-s');
    expect(loadKeybindingOverrides().format).toBeUndefined();
  });

  test('a corrupt blob resolves to pure defaults and loads as {}', () => {
    localStorage.setItem('koine.studio.keybindings', 'not json{');
    expect(loadKeybindingOverrides()).toEqual({});
    expect(resolveKeybindings()).toEqual(DEFAULT_BINDINGS);
  });

  test('an unknown stored id is ignored, valid ids survive', () => {
    localStorage.setItem(
      'koine.studio.keybindings',
      JSON.stringify({ bogusCommand: 'Ctrl-x', format: 'Ctrl-d' }),
    );
    const overrides = loadKeybindingOverrides();
    expect(overrides.format).toBe('Ctrl-d');
    expect((overrides as Record<string, unknown>).bogusCommand).toBeUndefined();
    const resolved = resolveKeybindings();
    expect(resolved.format).toBe('Ctrl-d');
    expect(resolved.rename).toBe(DEFAULT_BINDINGS.rename);
  });

  test('an inherited Object key (e.g. "toString") is NOT treated as a valid binding id', () => {
    // `id in DEFAULT_BINDINGS` would be true for prototype keys; the guard must use hasOwnProperty.
    localStorage.setItem('koine.studio.keybindings', JSON.stringify({ toString: 'Mod-q' }));
    const overrides = loadKeybindingOverrides();
    // `.toString` is inherited from Object.prototype, so assert it was not picked up as an OWN key.
    expect(Object.prototype.hasOwnProperty.call(overrides, 'toString')).toBe(false);
    expect(resolveKeybindings()).toEqual(DEFAULT_BINDINGS);
  });

  test('clearKeybindingOverrides returns the resolved map to pure defaults', () => {
    saveKeybindingOverride('rename', 'Ctrl-r');
    expect(resolveKeybindings().rename).toBe('Ctrl-r');
    clearKeybindingOverrides();
    expect(resolveKeybindings()).toEqual(DEFAULT_BINDINGS);
  });

  test('an empty-string override survives load as the deliberate "unbound" value', () => {
    saveKeybindingOverride('rename', '');
    expect(loadKeybindingOverrides().rename).toBe('');
    expect(resolveKeybindings().rename).toBe('');
  });
});
