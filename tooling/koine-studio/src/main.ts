// Brand typefaces, self-hosted (offline-safe for the Tauri shell) and shared with the docs site:
// Archivo (display / wordmark), Hanken Grotesk (body), JetBrains Mono (code). Bundled by Vite.
import '@fontsource-variable/archivo';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '@maxgraph/core/css/common.css';
import '@xterm/xterm/css/xterm.css';
import '@/styles/main.scss';
import { init } from '@/shell/ide';
import { mountHome, type WelcomeCallbacks } from '@/welcome/welcome';
import { appStore } from '@/store';
import { type Route, routeFromHash, hashFromRoute, resolveInitialRoute } from '@/store/slices/route';
import { hasPersistedWorkspace, markWorkspaceOpened } from '@/shell/workspaceFlag';
import { setStartIntent, type StartIntent } from '@/shell/bootIntent';
import { readModelFromHash } from '@/export/share';
import { connectInstallAffordance, createInstallController } from '@/shell/pwaInstall';
import {
  connectUpdateAffordance,
  createUpdateController,
  registerStudioServiceWorker,
  scheduleCompilerPrecache,
} from '@/shell/serviceWorkerUpdate';

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

  // PWA install affordance (#442): wired here, at boot, rather than in the lazy IDE init() — the
  // browser's one-shot `beforeinstallprompt` fires early in page load, often while a first-time visitor
  // is still on Home (before the editor route ever activates init()). Capturing it here, regardless of
  // route, means the deferred event isn't lost; connectInstallAffordance stashes it and reveals the
  // toolbar's dismissible Install button once the editor is shown. The toolbar nodes live inside #app
  // (present but hidden until the editor route), so they resolve at boot. A no-op where the event never
  // fires (Safari/iOS, already installed, or a prior dismissal persisted in localStorage).
  const installRoot = document.getElementById('install-affordance');
  const installButton = document.getElementById('btn-install');
  const installDismiss = document.getElementById('btn-install-dismiss');
  const disposeInstall =
    installRoot && installButton && installDismiss
      ? connectInstallAffordance(createInstallController(), {
          root: installRoot,
          installButton: installButton as HTMLButtonElement,
          dismissButton: installDismiss as HTMLButtonElement,
        })
      : null;

  // Service-worker offline support + update flow (#443): register koine-studio-sw.js (guarded for
  // browsers without the API; skipped under the Tauri desktop shell), then reveal a dismissible
  // "reload to update" affordance when a new build is deployed so an installed PWA never gets stuck on
  // a stale offline cache. Wired here at boot for the same reason as the install affordance: the
  // toolbar nodes live inside #app (present but hidden until the editor route) and resolve now, and
  // registration shouldn't wait on the lazy editor init().
  const swUpdateRoot = document.getElementById('sw-update');
  const swReloadButton = document.getElementById('btn-sw-reload');
  const swDismissButton = document.getElementById('btn-sw-dismiss');
  const updateController = createUpdateController();
  const disposeSwUpdate =
    swUpdateRoot && swReloadButton && swDismissButton
      ? connectUpdateAffordance(updateController, {
          root: swUpdateRoot,
          reloadButton: swReloadButton as HTMLButtonElement,
          dismissButton: swDismissButton as HTMLButtonElement,
        })
      : null;
  registerStudioServiceWorker({ onUpdateReady: () => updateController.markUpdateReady() });

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
      // Warm the offline WASM compiler cache now that the editor (the only surface that needs the
      // multi-MB bundle) is in use — on idle, never blocking first paint, and never on a Home-only
      // visit. No-op where the SW didn't register (unsupported browser / Tauri desktop). (#443)
      scheduleCompilerPrecache();
    }
  }

  function showHome(): void {
    if (appEl) appEl.hidden = true;
    if (homeRoot) {
      homeRoot.hidden = false;
      // A session is "live" once the IDE has booted (#392): `ideStarted` never resets, so every Home
      // entry after the first editor visit offers a Resume-editing control, while a pristine first-load
      // Home (ideStarted still false) stays clean. The two `undefined`s keep mountHome's `templates`
      // and `canOpenFolders` defaults (a default param applies when the arg is undefined) — we only
      // want to set the trailing `opts`.
      if (!home) home = mountHome(homeRoot, homeCallbacks(), undefined, undefined, { canResume: ideStarted });
    }
  }

  function apply(route: Route): void {
    // Expose the active route to CSS so route-aware chrome is deliberate, not accidental: on Home the
    // editor's #toolbar still paints (it shares #app, kept visible by #368's [hidden] override), but its
    // model-action group (New/Open/Generate/Save/Check) is useless before a model exists — a stylesheet
    // rule keyed on body[data-route="home"] trims it while keeping the brand + global controls (#490).
    document.body.dataset.route = route;
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
    // Clear the route flag so a teardown leaves no stale body[data-route] behind to mis-style a later
    // mount in the same document (symmetry with apply() setting it; #490).
    delete document.body.dataset.route;
    ideDispose?.();
    home?.destroy();
    disposeInstall?.();
    disposeSwUpdate?.();
  };
}

window.addEventListener('DOMContentLoaded', () => bootStudio());
