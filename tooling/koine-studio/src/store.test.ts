import { describe, expect, test, beforeEach } from 'vitest';
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
} from './store';
import type { ChatMessage } from './ai';

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
