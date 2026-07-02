// Brand typefaces, self-hosted (offline-safe for the Tauri shell) and shared with the docs site:
// Archivo (display / wordmark), Hanken Grotesk (body), JetBrains Mono (code). Bundled by Vite.
import '@fontsource-variable/archivo';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '@maxgraph/core/css/common.css';
import '@xterm/xterm/css/xterm.css';
// The --koi-* design tokens (dark/light theme + DDD-construct hues) now live in the
// @atypical/koine-ui package (issue #905, Task 2). Import it before main.scss so every
// var(--koi-*) reference in the component styles below resolves at load time.
import '@atypical/koine-ui/styles.css';
import '@/styles/main.scss';
import { init } from '@/shell/ide';
import { mountHome, type WelcomeCallbacks, type HomeHandle } from '@/welcome/welcome';
import { appStore } from '@/store';
import { type Route, routeFromHash, hashFromRoute, resolveInitialRoute } from '@/store/slices/route';
import { hasPersistedWorkspace, markWorkspaceOpened } from '@/shell/workspaceFlag';
import { loadSettings } from '@/settings/persistence';
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
// workspace was opened (so a later cold-open Home offers a one-click Resume back to it — #766), then
// navigates to the editor — where the IDE consumes the intent and performs the real work. Home can't
// call the IDE directly because, by design (#368), the editor isn't mounted while Home is showing.
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
    // Resume (#392 / #766): return to the editor. It sets no start-intent and opens no workspace, so the
    // outcome depends on whether the IDE is already live. Warm — returning Home after an editor visit
    // this session — is a pure route swap that leaves the session exactly as it was (the IDE stayed
    // initialised behind the route, #368). Cold — a returning user whose Home offered Resume from the
    // persisted-workspace flag before the IDE booted this session (#766) — navigates in, boots the IDE,
    // and the cold-boot ladder restores the last workspace via getLastWorkspace(): the old auto-skip,
    // now an explicit choice.
    onResume: () => appStore.getState().navigate('editor'),
    // Settings gear on Home (#1005): Home can't render Settings itself (it's an editor-hosted overlay),
    // so navigate to the editor first — showEditor() mounts the IDE synchronously on the route change —
    // then flip the uiChrome `settingsOpen` flag, which the now-mounted editor renders reactively. The
    // order matters: the overlay must be shown AFTER the editor exists to host it.
    onOpenSettings: () => {
      appStore.getState().navigate('editor');
      appStore.getState().showSettings();
    },
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
export function bootStudio(homeRoot: HTMLElement | null = document.getElementById('home-root')): () => void { // eslint-disable-line no-restricted-properties -- #home-root is optional by design (typed HTMLElement | null; every use is `if (homeRoot)` guarded), so a hard throw would break boot on a host that omits it
  const appEl = document.getElementById('app'); // eslint-disable-line no-restricted-properties -- #app is route-hidden chrome read nullably (every use is `if (appEl)` guarded); throwing would wrongly hard-fail boot

  // Perceivability signal for the toolbar affordances (#573). The install/update affordances live in the
  // toolbar inside #app, which is route-hidden until the editor route. Their shared live region is
  // body-level (#522), so without a gate an affordance armed on Home — the install one is wired at boot,
  // and `beforeinstallprompt` often fires pre-editor — would be announced to a screen reader before its
  // control is reachable. Gate the announcement on the route: `route === 'editor'` is the canonical
  // "#app is shown" signal (apply() un-hides #app exactly then), read live from the store so it's
  // correct regardless of subscriber order; the route→editor edge flushes any deferred announcement,
  // never dropping it.
  const isToolbarPerceivable = (): boolean => appStore.getState().route === 'editor';
  const subscribeToolbarPerceivable = (cb: () => void): (() => void) =>
    appStore.subscribe((s, prev) => {
      if (s.route !== prev.route) cb();
    });

  // PWA install affordance (#442): wired here, at boot, rather than in the lazy IDE init() — the
  // browser's one-shot `beforeinstallprompt` fires early in page load, often while a first-time visitor
  // is still on Home (before the editor route ever activates init()). Capturing it here, regardless of
  // route, means the deferred event isn't lost; connectInstallAffordance stashes it and reveals the
  // toolbar's dismissible Install button once the editor is shown. The toolbar nodes live inside #app
  // (present but hidden until the editor route), so they resolve at boot. A no-op where the event never
  // fires (Safari/iOS, already installed, or a prior dismissal persisted in localStorage).
  const installRoot = document.getElementById('install-affordance'); // eslint-disable-line no-restricted-properties -- install affordance is optional; the `installRoot && installButton && installDismiss` ternary no-ops when absent (Safari/iOS, already installed)
  const installButton = document.getElementById('btn-install'); // eslint-disable-line no-restricted-properties -- see install-affordance above: optional, guarded by the null-checking ternary
  const installDismiss = document.getElementById('btn-install-dismiss'); // eslint-disable-line no-restricted-properties -- see install-affordance above: optional, guarded by the null-checking ternary
  const disposeInstall =
    installRoot && installButton && installDismiss
      ? connectInstallAffordance(createInstallController(), {
          root: installRoot,
          installButton: installButton as HTMLButtonElement,
          dismissButton: installDismiss as HTMLButtonElement,
          // Defer the "can be installed" announcement until the editor toolbar is perceivable (#573).
          isPerceivable: isToolbarPerceivable,
          subscribePerceivable: subscribeToolbarPerceivable,
        })
      : null;

  // Service-worker offline support + update flow (#443): register koine-studio-sw.js (guarded for
  // browsers without the API; skipped under the Tauri desktop shell), then reveal a dismissible
  // "reload to update" affordance when a new build is deployed so an installed PWA never gets stuck on
  // a stale offline cache. Wired here at boot for the same reason as the install affordance: the
  // toolbar nodes live inside #app (present but hidden until the editor route) and resolve now, and
  // registration shouldn't wait on the lazy editor init().
  const swUpdateRoot = document.getElementById('sw-update'); // eslint-disable-line no-restricted-properties -- SW-update affordance is optional; the `swUpdateRoot && swReloadButton && swDismissButton` ternary no-ops when absent (no SW / Tauri desktop)
  const swReloadButton = document.getElementById('btn-sw-reload'); // eslint-disable-line no-restricted-properties -- see sw-update above: optional, guarded by the null-checking ternary
  const swDismissButton = document.getElementById('btn-sw-dismiss'); // eslint-disable-line no-restricted-properties -- see sw-update above: optional, guarded by the null-checking ternary
  const updateController = createUpdateController();
  const disposeSwUpdate =
    swUpdateRoot && swReloadButton && swDismissButton
      ? connectUpdateAffordance(updateController, {
          root: swUpdateRoot,
          reloadButton: swReloadButton as HTMLButtonElement,
          dismissButton: swDismissButton as HTMLButtonElement,
          // Defer the "new version" announcement until the editor toolbar is perceivable (#573).
          isPerceivable: isToolbarPerceivable,
          subscribePerceivable: subscribeToolbarPerceivable,
        })
      : null;
  registerStudioServiceWorker({ onUpdateReady: () => updateController.markUpdateReady() });

  // A shared playground link (`#model=…`) always opens the editor. Otherwise the startup policy
  // decides: by default a plain open (``, `#/`, unknown hash) lands on Home (#766), but the user can
  // opt into "Last workspace" via Settings → On startup, which auto-resumes the editor when a prior
  // workspace exists (#770). Both inputs are read here (IO boundary) and passed pure to the resolver.
  const isShareLink = readModelFromHash() !== null;
  const initial: Route = isShareLink
    ? 'editor'
    : resolveInitialRoute(location.hash, {
        startupView: loadSettings().startupView,
        hasWorkspace: hasPersistedWorkspace(),
      });
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
  let home: HomeHandle | null = null;

  function showEditor(): void {
    home?.destroy();
    home = null;
    if (homeRoot) homeRoot.hidden = true;
    if (appEl) appEl.hidden = false;
    if (!ideStarted) {
      ideStarted = true;
      ideDispose = init({
        // The editor→Home leg of the route hand-off (#391): an open-recent start-intent that fails to
        // open its folder recovers on Home, not via an overlay over the editor. Returning to Home
        // re-mounts it (showHome runs synchronously inside navigate), so `home` is set before recover();
        // for a vanished folder we then offer to forget the dead entry there.
        onOpenRecentFailed: (path, reason) => {
          appStore.getState().navigate('home');
          if (reason === 'unreadable') void home?.recover(path);
        },
      });
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
      // The resume-session card (#1005) self-gates on the persisted last-session snapshot, so Home no
      // longer needs to be told *whether* to offer a resume — only whether the editor is live this
      // session (`ideStarted`, #392), which drives the card's live "ping" dot. A cold-open Home still
      // gets the card (the snapshot is on disk); `onResume` navigates to the editor, which boots the IDE
      // and restores the last workspace (#766). The two `undefined`s keep mountHome's `templates` and
      // `canOpenFolders` defaults (a default param applies when the arg is undefined) — we only set opts.
      if (!home) {
        home = mountHome(homeRoot, homeCallbacks(), undefined, undefined, {
          warm: ideStarted,
        });
      }
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
