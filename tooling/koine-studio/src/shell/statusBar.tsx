import { render } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import type { Platform } from '@/host';
import { domById } from '@/shared/domById';
import { DocsCoverageRing } from '@/shell/DocsCoverageRing';
import { EmitEcho } from '@/shell/EmitEcho';

export interface StatusBarDeps {
  store: StoreApi<AppState>;
  /** Host platform — used to read the git branch (desktop only; gated by canUseGit). */
  platform: Platform;
  /** The active workspace folder token, or '' / null with no folder open. */
  folderRootToken: () => string | null;
  /** Open the Problems bottom tab — the #sb-problems segment's click. */
  onOpenProblems: () => void;
}

/** Teardown seam for the status bar (#980): release the folder-token subscription and unmount the two
 *  Preact panels so nothing the bar created survives a shell teardown. */
export interface StatusBarHandle {
  dispose(): void;
}

// The status-bar reactive wiring (chrome v2, #923), extracted so init() stays thin (#757). It mounts the
// two store-bound panels (the docs-coverage ring + the emit echo), wires the Problems segment's click,
// and keeps the git-branch segment current. The problems split + cursor + connection are driven by
// editorSession; the context segment by the inspector controller — each owns the data it already holds.
export function createStatusBar(deps: StatusBarDeps): StatusBarHandle {
  const docsRingHost = domById('sb-docs-ring');
  const emitHost = domById('sb-emit');
  render(<DocsCoverageRing store={deps.store} />, docsRingHost);
  render(<EmitEcho store={deps.store} />, emitHost);

  // Flipped by dispose(); consulted after every `await` in refreshBranch so an in-flight gitStatus that
  // resolves post-teardown cannot write into a torn-down bar (the existing token guard covers a folder
  // switch, not a teardown — the token can be unchanged).
  let disposed = false;

  // Problems segment → the Problems bottom tab (the split ✕/⚠ counts are filled by editorSession).
  domById('sb-problems').addEventListener('click', () => deps.onOpenProblems());

  // Git branch: desktop-only (canUseGit). Refresh whenever the workspace folder changes; hide the segment
  // when there's no git or no branch. (Branch is read imperatively so the static git-branch glyph in the
  // markup is preserved.) A checkout from the Source Control panel is rare and out of scope here — the
  // segment refreshes on the next folder open.
  const branchEl = domById<HTMLElement>('sb-branch');
  const branchNameEl = branchEl.querySelector<HTMLElement>('[data-role="branch-name"]');
  async function refreshBranch(): Promise<void> {
    const token = deps.folderRootToken();
    if (!deps.platform.canUseGit || !token) {
      branchEl.hidden = true;
      return;
    }
    try {
      const { branch } = await deps.platform.gitStatus(token);
      if (disposed) return; // the bar was torn down while this fetch was in flight — do not write.
      // A quick folder switch overlaps in-flight gitStatus calls — only the CURRENT folder's result
      // may touch the segment, else a slow previous repo's branch overwrites the fresh one.
      if (token !== deps.folderRootToken()) return;
      if (branchNameEl) branchNameEl.textContent = branch;
      branchEl.hidden = !branch;
    } catch {
      if (disposed) return; // likewise on the failure path — a torn-down bar's segment must stay put.
      // No repo yet, or git unavailable for this folder — keep the segment out of the bar.
      if (token !== deps.folderRootToken()) return;
      branchEl.hidden = true;
    }
  }
  let lastToken = deps.folderRootToken();
  const unsubscribe = deps.store.subscribe((s) => {
    if (s.folderRootToken !== lastToken) {
      lastToken = s.folderRootToken;
      void refreshBranch();
    }
  });
  void refreshBranch();

  return {
    dispose(): void {
      disposed = true;
      unsubscribe();
      // Unmount the two Preact panels so their own store (useStore) subscriptions and any window
      // listeners detach — the render(null, host) idiom the inspector controller uses on dispose.
      render(null, docsRingHost);
      render(null, emitHost);
    },
  };
}
