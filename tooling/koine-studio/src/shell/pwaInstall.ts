// PWA install-prompt state controller (#442).
//
// Studio Web ships a web manifest (#422), so Chromium-based browsers fire a `beforeinstallprompt`
// event to signal the app is installable. The browser's own install entry point (overflow menu /
// Share sheet) is buried, so this controller captures that event and drives a small, dismissible
// in-app "Install" affordance instead — never an auto-prompt.
//
// The controller is deliberately DOM-light and pure so it unit-tests under vitest; the shell
// (ide.tsx) owns the markup and wires it via `connectInstallAffordance` below.

import { localStorageFlag, type StorageLike } from './localStorageFlag';
import { announce as defaultAnnounce } from './liveRegion';
import { connectRevealAnnouncer } from './revealAnnouncer';

/** localStorage key recording that the user dismissed the in-app install affordance (non-nagging). */
export const INSTALL_DISMISSED_KEY = 'koine.studio.installDismissed';

/** What assistive tech hears when the install affordance slides into the toolbar (#522). */
export const INSTALL_ANNOUNCEMENT = 'Koine Studio can be installed';

/** The non-standard install-prompt event. Typed locally — lib.dom.d.ts ships no declaration for it. */
export interface BeforeInstallPromptEvent extends Event {
  /** Show the browser's install dialog. Single-use: a deferred event can be prompted only once. */
  prompt(): Promise<void>;
  /** Resolves once the user accepts or dismisses the browser dialog. */
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/**
 * The slice of the Web Storage API this controller needs; lets tests pass an in-memory stand-in.
 * Aliases the shared {@link StorageLike} (#514) so the dismissal flag and the helper agree on one shape.
 */
export type InstallStorage = StorageLike;

/** The result of asking the browser to install: the user's choice, or "unavailable" if not armed. */
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable';

export interface InstallController {
  /** Capture + stash a `beforeinstallprompt` event (calls preventDefault to suppress the mini-infobar). */
  onBeforeInstallPrompt(event: BeforeInstallPromptEvent): void;
  /** Clear state when the app is installed, so the affordance hides. */
  onAppInstalled(): void;
  /** True only when a deferred event is held AND the user hasn't dismissed the affordance. */
  canInstall(): boolean;
  /** Show the browser dialog for the stashed (single-use) event; clears the stash regardless of outcome. */
  promptInstall(): Promise<InstallOutcome>;
  /** Persist the dismissal flag and drop the stashed event so the affordance stays hidden. */
  dismiss(): void;
  /** Whether the user has previously dismissed the affordance (persisted across loads). */
  isDismissed(): boolean;
  /** Subscribe to state changes (arm / prompt / dismiss / appinstalled). Returns an unsubscribe fn. */
  subscribe(listener: () => void): () => void;
}

export function createInstallController(opts: { storage?: InstallStorage } = {}): InstallController {
  // The persisted dismissal flag — throw-safe and best-effort via the shared helper (#514). When no
  // storage is injected the helper falls back to its own best-effort `localStorage` adapter.
  const dismissedFlag = localStorageFlag(INSTALL_DISMISSED_KEY, opts.storage);
  let deferred: BeforeInstallPromptEvent | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of listeners) fn();
  }

  function isDismissed(): boolean {
    return dismissedFlag.isSet();
  }

  function onBeforeInstallPrompt(event: BeforeInstallPromptEvent): void {
    // Always suppress the browser's own mini-infobar; we surface a tailored, dismissible affordance.
    event.preventDefault();
    deferred = event;
    notify();
  }

  function onAppInstalled(): void {
    deferred = null;
    notify();
  }

  function canInstall(): boolean {
    return !isDismissed() && deferred !== null;
  }

  async function promptInstall(): Promise<InstallOutcome> {
    const event = deferred;
    if (event === null) return 'unavailable';
    // Single-use: drop the stash BEFORE awaiting so it can never be prompted twice.
    deferred = null;
    notify();
    try {
      await event.prompt();
      const { outcome } = await event.userChoice;
      return outcome;
    } catch {
      // prompt()/userChoice can reject (NotAllowedError / InvalidStateError if the browser declines or
      // the install criteria changed mid-flight). Swallow it: the stash is already cleared and the
      // affordance hidden, so report "unavailable" rather than leaking an unhandled rejection.
      return 'unavailable';
    }
  }

  function dismiss(): void {
    // Best-effort persist (a private-mode write that throws is swallowed by the helper — dismissal
    // simply won't survive a reload), then hide the affordance now regardless.
    dismissedFlag.set();
    deferred = null;
    notify();
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  return {
    onBeforeInstallPrompt,
    onAppInstalled,
    canInstall,
    promptInstall,
    dismiss,
    isDismissed,
    subscribe,
  };
}

/** The DOM the install affordance drives: the affordance container plus its two buttons. */
export interface InstallAffordanceDom {
  /** The container toggled visible/hidden as a unit (holds the Install + dismiss buttons). */
  root: HTMLElement;
  /** The primary "Install" button — click triggers `promptInstall()`. */
  installButton: HTMLButtonElement;
  /** The close "×" button — click triggers `dismiss()`. */
  dismissButton: HTMLButtonElement;
  /** The event source for `beforeinstallprompt`/`appinstalled` (defaults to `window`). */
  target?: EventTarget;
  /** Polite live-region announcer for the reveal (defaults to the shared {@link defaultAnnounce}; injectable for tests). */
  announce?: (message: string) => void;
  /**
   * Whether the affordance's control is currently perceivable — its `#app` ancestor is route-visible
   * (the editor route is shown). Defaults to always-perceivable, i.e. announce immediately. When this
   * returns `false` on the reveal edge, the announcement is deferred rather than dropped (#573).
   */
  isPerceivable?: () => boolean;
  /**
   * Subscribe to "became perceivable" edges (e.g. the editor route is shown). Used to flush a deferred
   * announcement; returns an unsubscribe fn disposed with the affordance. Omit to never defer (#573).
   */
  subscribePerceivable?: (cb: () => void) => () => void;
}

/**
 * Wire an {@link InstallController} to its DOM affordance: register the browser install events, toggle
 * the affordance visibility from `canInstall()`, and route clicks to prompt/dismiss. Returns a disposer
 * that removes every listener. Pure of any global lookups so it unit-tests under happy-dom.
 */
export function connectInstallAffordance(
  controller: InstallController,
  dom: InstallAffordanceDom,
): () => void {
  const target = dom.target ?? window;
  const announce = dom.announce ?? defaultAnnounce;

  // Capture the markup's initial hidden state (it ships `hidden`) before the first sync toggles it, so
  // the shared announcer can detect a reveal on the initial `sync()`.
  const initiallyVisible = !dom.root.hidden;
  const syncVisibility = (): void => {
    dom.root.hidden = !controller.canInstall();
  };
  const onBip = (e: Event): void => controller.onBeforeInstallPrompt(e as BeforeInstallPromptEvent);
  const onInstalled = (): void => controller.onAppInstalled();
  const onInstallClick = (): void => void controller.promptInstall();
  const onDismissClick = (): void => controller.dismiss();

  target.addEventListener('beforeinstallprompt', onBip);
  target.addEventListener('appinstalled', onInstalled);
  dom.installButton.addEventListener('click', onInstallClick);
  dom.dismissButton.addEventListener('click', onDismissClick);
  const unsub = controller.subscribe(syncVisibility);
  syncVisibility(); // reflect the initial visibility immediately
  // Delegate the reveal-announce + #573 defer/flush state machine to the shared helper (#580); this
  // controller keeps owning the `dom.root.hidden` toggle above, the announce side lives once in
  // connectRevealAnnouncer. The body-level live region (#522) announces on the hidden→visible edge.
  const disposeAnnouncer = connectRevealAnnouncer({
    isVisible: (): boolean => controller.canInstall(),
    subscribe: controller.subscribe,
    announce,
    message: INSTALL_ANNOUNCEMENT,
    initiallyVisible,
    isPerceivable: dom.isPerceivable,
    subscribePerceivable: dom.subscribePerceivable,
  });

  return () => {
    target.removeEventListener('beforeinstallprompt', onBip);
    target.removeEventListener('appinstalled', onInstalled);
    dom.installButton.removeEventListener('click', onInstallClick);
    dom.dismissButton.removeEventListener('click', onDismissClick);
    unsub();
    disposeAnnouncer();
  };
}
