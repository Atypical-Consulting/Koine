// A synchronous "a workspace has been opened in this profile before" flag, persisted in localStorage.
// The boot switch (main.ts) reads it before first paint to decide Home vs. Editor without awaiting any
// async workspace probe — that await was the source of the IDE→Home flash (issue #368). Written when a
// workspace is opened so a returning user lands straight in the editor.
//
// The throw-safe localStorage idiom lives in the shared `localStorageFlag` helper (#514); this module
// keeps its named, domain-specific API over a single flag instance.

import { localStorageFlag } from './localStorageFlag';

const flag = localStorageFlag('koine.studio.workspace-opened');

/** True if a workspace was opened on a prior visit. Synchronous; never throws (storage may be absent). */
export function hasPersistedWorkspace(): boolean {
  return flag.isSet();
}

/** Record that a workspace was opened, so the next cold load boots straight to the editor. Best-effort. */
export function markWorkspaceOpened(): void {
  flag.set();
}
