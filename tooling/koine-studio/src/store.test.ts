import { describe, expect, test, beforeEach } from 'vitest';
import {
  loadSettings,
  saveSettings,
  patchSettings,
  DEFAULT_SETTINGS,
  initSecrets,
  saveApiKey,
  clearApiKey,
  peekLegacyScratch,
  clearLegacyScratch,
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
