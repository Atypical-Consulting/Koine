import { isDevMode } from './devMode';
import { localStorageFlag, type PersistedFlag, type StorageLike } from './localStorageFlag';

// A capability gate for Studio chrome panels (#759 — the #193 Preact-migration finish). A surface that
// is not yet ready for users declares a named capability; until that capability is explicitly enabled
// the panel is HIDDEN (not rendered) rather than shipped as an empty void or a "Coming soon."
// placeholder — the recurring class of bug the migration set out to stop. The gate is the single,
// tested decision point for "should this surface render?", so panels stop hand-rolling ad-hoc checks.
//
// Storage model: each capability is one throw-safe localStorage flag (the shared #514 `localStorageFlag`
// primitive), keyed `koine.studio.panel.<capability>`. Default-closed and fail-closed — an unset flag,
// or a storage read that throws (Safari private mode / disabled cookies / sandboxed iframe), reads as
// DISABLED, so an incomplete panel never leaks when storage is unavailable.
//
// Dev affordance: in a dev build (`isDevMode()` → vite serve) a gated panel is forced visible so the
// developer building it sees it without flipping a flag; shipped builds (`vite build`) honour the flag
// only. Both knobs are injectable so tests pin behaviour deterministically.

/** The localStorage key namespace for panel capabilities; one key per capability. */
const KEY_PREFIX = 'koine.studio.panel.';

/** A default-closed capability gate over a single named panel-readiness flag. */
export interface PanelGate {
  /** True iff the panel should render: the capability flag is set, or a dev build forces it on. */
  enabled(): boolean;
  /** Persist the capability as enabled (best-effort; never throws). */
  enable(): void;
  /** Remove the capability flag so the panel hides again (best-effort; never throws). */
  disable(): void;
}

/** Knobs for {@link panelGate}; all optional, defaulting to production behaviour. */
export interface PanelGateOptions {
  /** Storage stand-in (tests). Defaults to the shared best-effort `localStorage` adapter. */
  storage?: StorageLike;
  /** Force the panel visible in dev builds even when the flag is unset. Default `true`. */
  devForcesOn?: boolean;
  /** Dev-build probe (tests). Defaults to `isDevMode`. */
  isDev?: () => boolean;
}

/**
 * A default-closed capability gate for the panel named `capability`. The panel renders only when the
 * capability has been explicitly enabled — or, in a dev build, when `devForcesOn` (the default) is set.
 * Reuses the throw-safe {@link PersistedFlag}; introduces no new storage primitive.
 */
export function panelGate(capability: string, options: PanelGateOptions = {}): PanelGate {
  const { storage, devForcesOn = true, isDev = isDevMode } = options;
  // Passing `storage === undefined` triggers localStorageFlag's default best-effort localStorage adapter.
  const flag: PersistedFlag = localStorageFlag(KEY_PREFIX + capability, storage);
  return {
    enabled(): boolean {
      // Flag wins; the dev affordance only force-shows an otherwise-hidden panel. isSet() already
      // returns false on a storage throw, so this is fail-closed by construction.
      if (flag.isSet()) return true;
      return devForcesOn && isDev();
    },
    enable(): void {
      flag.set();
    },
    disable(): void {
      flag.clear();
    },
  };
}

/** Convenience: is the panel named `capability` enabled right now? See {@link panelGate}. */
export function panelEnabled(capability: string, options?: PanelGateOptions): boolean {
  return panelGate(capability, options).enabled();
}
