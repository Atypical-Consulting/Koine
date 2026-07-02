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

// The status-bar reactive wiring (chrome v2, #923), extracted so init() stays thin (#757). It mounts the
// two store-bound panels (the docs-coverage ring + the emit echo), wires the Problems segment's click,
// and keeps the git-branch segment current. The problems split + cursor + connection are driven by
// editorSession; the context segment by the inspector controller — each owns the data it already holds.
export function createStatusBar(deps: StatusBarDeps): void {
  render(<DocsCoverageRing store={deps.store} />, domById('sb-docs-ring'));
  render(<EmitEcho store={deps.store} />, domById('sb-emit'));

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
      // A quick folder switch overlaps in-flight gitStatus calls — only the CURRENT folder's result
      // may touch the segment, else a slow previous repo's branch overwrites the fresh one.
      if (token !== deps.folderRootToken()) return;
      if (branchNameEl) branchNameEl.textContent = branch;
      branchEl.hidden = !branch;
    } catch {
      // No repo yet, or git unavailable for this folder — keep the segment out of the bar.
      if (token !== deps.folderRootToken()) return;
      branchEl.hidden = true;
    }
  }
  let lastToken = deps.folderRootToken();
  deps.store.subscribe((s) => {
    if (s.folderRootToken !== lastToken) {
      lastToken = s.folderRootToken;
      void refreshBranch();
    }
  });
  void refreshBranch();
}
