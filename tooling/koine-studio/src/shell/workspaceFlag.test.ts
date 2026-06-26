import { describe, it, expect, beforeEach } from 'vitest';
import { hasPersistedWorkspace, markWorkspaceOpened } from '@/shell/workspaceFlag';

// The module binds a single flag over the real (happy-dom) localStorage at import time, so each test
// clears the key first to stay isolated. Proves the named API and the persisted key/value are unchanged
// by the move onto the shared localStorageFlag helper (#514).
const KEY = 'koine.studio.workspace-opened';

describe('workspaceFlag', () => {
  beforeEach(() => {
    localStorage.removeItem(KEY);
  });

  it('hasPersistedWorkspace() is false on a fresh profile', () => {
    expect(hasPersistedWorkspace()).toBe(false);
  });

  it("markWorkspaceOpened() persists the '1' sentinel so hasPersistedWorkspace() reads true", () => {
    markWorkspaceOpened();

    expect(hasPersistedWorkspace()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('reads a flag previously written directly to storage', () => {
    localStorage.setItem(KEY, '1');
    expect(hasPersistedWorkspace()).toBe(true);
  });
});
