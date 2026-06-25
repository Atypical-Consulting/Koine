// A synchronous "a workspace has been opened in this profile before" flag, persisted in localStorage.
// The boot switch (main.ts) reads it before first paint to decide Home vs. Editor without awaiting any
// async workspace probe — that await was the source of the IDE→Home flash (issue #368). Written when a
// workspace is opened so a returning user lands straight in the editor.

const KEY = 'koine.studio.workspace-opened';

/** True if a workspace was opened on a prior visit. Synchronous; never throws (storage may be absent). */
export function hasPersistedWorkspace(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Record that a workspace was opened, so the next cold load boots straight to the editor. Best-effort. */
export function markWorkspaceOpened(): void {
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    // storage unavailable (private mode / no Web Storage) — the flash fix degrades to "always Home first".
  }
}
