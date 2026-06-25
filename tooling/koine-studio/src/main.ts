// Brand typefaces, self-hosted (offline-safe for the Tauri shell) and shared with the docs site:
// Archivo (display / wordmark), Hanken Grotesk (body), JetBrains Mono (code). Bundled by Vite.
import '@fontsource-variable/archivo';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '@maxgraph/core/css/common.css';
import '@/styles/main.scss';
import { init } from '@/shell/ide';
import { mountHome, type WelcomeCallbacks } from '@/welcome/welcome';
import { appStore } from '@/store';
import { type Route, routeFromHash, hashFromRoute, resolveInitialRoute } from '@/store/slices/route';
import { hasPersistedWorkspace, markWorkspaceOpened } from '@/shell/workspaceFlag';
import { setStartIntent, type StartIntent } from '@/shell/bootIntent';
import { readModelFromHash } from '@/export/share';

// Home actions: each queues what the editor should do on its next boot (the start-intent), remembers a
// workspace was opened (so the next cold load returns to the editor), then navigates to the editor —
// where the IDE consumes the intent and performs the real work. Home can't call the IDE directly
// because, by design (#368), the editor isn't mounted while Home is showing.
function homeCallbacks(): WelcomeCallbacks {
  const go = (intent: StartIntent): void => {
    setStartIntent(intent);
    markWorkspaceOpened();
    appStore.getState().navigate('editor');
  };
  return {
    onNewModel: () => go({ kind: 'new' }),
    onOpenFolder: () => go({ kind: 'open-folder' }),
    onOpenRecent: (path) => go({ kind: 'open-recent', path }),
    onOpenExample: (template) => go({ kind: 'open-example', template }),
    // Resume (#392): step straight back into the already-live editor session. Unlike the start actions
    // it sets no start-intent and opens no workspace — the IDE stayed initialised behind the route
    // (#368), so this is a pure route swap that leaves the session exactly as it was.
    onResume: () => appStore.getState().navigate('editor'),
  };
}

/**
 * The Studio boot switch. Resolves the initial route **synchronously** (no async workspace probe) and
 * mounts exactly one view — Home *or* the editor — then swaps on route changes. Mounting only one view
 * is what removes the historic IDE→Home flash (#368): the home overlay used to fade in over an
 * already-painted editor because its visibility was gated on an async flow that resolved a frame late.
 *
 * The IDE shell (`init()`) is started lazily, the first time the editor route is active, and is never
 * torn down on a later Home↔Editor swap (the shell's LSP/workspace stay alive; only visibility toggles).
 */
export function bootStudio(homeRoot: HTMLElement | null = document.getElementById('home-root')): () => void {
  const appEl = document.getElementById('app');

  // A shared playground link (`#model=…`) always opens the editor; otherwise the hash and the
  // synchronous "a workspace was open" flag decide. Resolved before any paint.
  const isShareLink = readModelFromHash() !== null;
  const initial: Route = isShareLink
    ? 'editor'
    : resolveInitialRoute({ hash: location.hash, hasPersistedWorkspace: hasPersistedWorkspace() });
  appStore.setState({ route: initial });

  // Canonicalise the URL hash to the resolved route so a refresh / bookmark lands on the same view —
  // but never clobber a share link; the IDE consumes and clears `#model=…` itself.
  if (!isShareLink) {
    const wantHash = hashFromRoute(initial);
    if (location.hash !== wantHash) {
      try {
        history.replaceState(null, '', wantHash);
      } catch {
        // history unavailable — harmless; routing still works off the in-memory slice.
      }
    }
  }

  let ideStarted = false;
  let ideDispose: (() => void) | null = null;
  let home: { destroy(): void } | null = null;

  function showEditor(): void {
    home?.destroy();
    home = null;
    if (homeRoot) homeRoot.hidden = true;
    if (appEl) appEl.hidden = false;
    if (!ideStarted) {
      ideStarted = true;
      ideDispose = init();
    }
  }

  function showHome(): void {
    if (appEl) appEl.hidden = true;
    if (homeRoot) {
      homeRoot.hidden = false;
      // A session is "live" once the IDE has booted (#392): `ideStarted` never resets, so every Home
      // entry after the first editor visit offers a Resume-editing control, while a pristine first-load
      // Home (ideStarted still false) stays clean.
      if (!home) home = mountHome(homeRoot, homeCallbacks(), undefined, undefined, { canResume: ideStarted });
    }
  }

  function apply(route: Route): void {
    if (route === 'editor') showEditor();
    else showHome();
  }

  apply(initial);

  // Swap the mounted view whenever the route changes — via navigate() or a manual hash edit / browser
  // back-forward (the hashchange listener feeds the slice). The slice change fires on every setState,
  // so gate on the route actually differing (prev is the store's own previous state — no local mirror).
  const unsub = appStore.subscribe((s, prev) => {
    if (s.route !== prev.route) apply(s.route);
  });
  const onHash = (): void => appStore.setState({ route: routeFromHash(location.hash) });
  window.addEventListener('hashchange', onHash);

  return () => {
    unsub();
    window.removeEventListener('hashchange', onHash);
    ideDispose?.();
    home?.destroy();
  };
}

window.addEventListener('DOMContentLoaded', () => bootStudio());
