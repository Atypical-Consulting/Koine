import { describe, expect, test, beforeEach } from 'vitest';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './store';

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
