// A synchronous "a workspace has been opened in this profile before" flag, persisted in localStorage.
// The boot switch (main.ts) reads it before first paint to offer a one-click Resume on a cold-open Home
// for returning users — without awaiting any async workspace probe (that await was the source of the
// IDE→Home flash, issue #368). It no longer decides Home vs. Editor: opening always lands on Home, and
// the flag now only drives the Resume affordance's visibility (issue #766).
//
// The throw-safe localStorage idiom lives in the shared `localStorageFlag` helper (#514); this module
// keeps its named, domain-specific API over a single flag instance.

import { localStorageFlag } from './localStorageFlag';

const flag = localStorageFlag('koine.studio.workspace-opened');

/** True if a workspace was opened on a prior visit. Synchronous; never throws (storage may be absent). */
export function hasPersistedWorkspace(): boolean {
  return flag.isSet();
}

/** Record that a workspace was opened, so a later cold-open Home offers a one-click Resume. Best-effort. */
export function markWorkspaceOpened(): void {
  flag.set();
}
