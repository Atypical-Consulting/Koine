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
  PREVIEW_TARGETS,
} from '@/settings/persistence';
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

  test('PREVIEW_TARGETS lists the five supported languages in order', () => {
    expect(PREVIEW_TARGETS).toEqual(['csharp', 'typescript', 'python', 'php', 'rust']);
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
