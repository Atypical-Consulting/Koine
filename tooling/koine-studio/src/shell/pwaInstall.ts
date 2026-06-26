// PWA install-prompt state controller (#442).
//
// Studio Web ships a web manifest (#422), so Chromium-based browsers fire a `beforeinstallprompt`
// event to signal the app is installable. The browser's own install entry point (overflow menu /
// Share sheet) is buried, so this controller captures that event and drives a small, dismissible
// in-app "Install" affordance instead — never an auto-prompt.
//
// The controller is deliberately DOM-light and pure so it unit-tests under vitest; the shell
// (ide.tsx) owns the markup and wires it via `connectInstallAffordance` below.

/** localStorage key recording that the user dismissed the in-app install affordance (non-nagging). */
export const INSTALL_DISMISSED_KEY = 'koine.studio.installDismissed';

/** The non-standard install-prompt event. Typed locally — lib.dom.d.ts ships no declaration for it. */
export interface BeforeInstallPromptEvent extends Event {
  /** Show the browser's install dialog. Single-use: a deferred event can be prompted only once. */
  prompt(): Promise<void>;
  /** Resolves once the user accepts or dismisses the browser dialog. */
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** The slice of the Web Storage API this controller needs; lets tests pass an in-memory stand-in. */
export interface InstallStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

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

/** A best-effort `InstallStorage` backed by `localStorage`, degrading to a no-op if storage is absent. */
function defaultStorage(): InstallStorage {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    // localStorage access can throw (sandboxed iframe / disabled cookies) — fall through to the no-op.
  }
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

export function createInstallController(opts: { storage?: InstallStorage } = {}): InstallController {
  const storage = opts.storage ?? defaultStorage();
  let deferred: BeforeInstallPromptEvent | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const fn of listeners) fn();
  }

  function isDismissed(): boolean {
    try {
      return storage.getItem(INSTALL_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
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
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome;
  }

  function dismiss(): void {
    try {
      storage.setItem(INSTALL_DISMISSED_KEY, '1');
    } catch {
      // storage unavailable (private mode) — dismissal won't persist across loads, but still hide now.
    }
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
