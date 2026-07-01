import { render } from 'preact';
import type { StoreApi } from 'zustand/vanilla';
import type { AppState } from '@/store/index';
import { EmitTargetSelector } from '@/shell/EmitTargetSelector';
import {
  effectiveSettings,
  loadSettings,
  loadWorkspaceOverrides,
  patchSettings,
  saveWorkspaceOverride,
  type PreviewTarget,
  type Settings,
} from '@/settings/persistence';

export interface EmitTargetControlDeps {
  store: StoreApi<AppState>;
  /** The #emit-target-host mount node in the top bar. */
  host: HTMLElement;
  /** The active workspace override key (folder identity), or null with no folder open. */
  wsKey: () => string | null;
  /** Read / replace ide.ts's live `settings` (patchSettings returns a fresh object). */
  getSettings: () => Settings;
  setSettings: (s: Settings) => void;
  /** Apply the now-effective scoped settings — relabel + re-emit the Generated preview AND mirror the
   *  effective emit target into the store (the shared apply path ide.ts owns). */
  applyEffectiveScoped: (eff: Settings) => void;
}

// The top-bar emit-target selector wiring (#923), extracted so init() stays thin (the #757 composition-
// root contract + its line-budget guard). It seeds the store's emit-target mirror for the first paint,
// mounts the selector into #emit-target-host, and commits a pick with the SAME scope logic the Settings
// Output picker uses: update the active workspace override when one exists for this workspace, else patch
// the user setting; then apply live. applyEffectiveScoped mirrors the effective value back into the store,
// re-rendering the selector and the status-bar Emit echo.
export function createEmitTargetControl(deps: EmitTargetControlDeps): void {
  // First-paint seed: no folder is open yet, so the effective value equals the user setting. A folder
  // open then re-applies the effective value (with any per-workspace override) via applyEffectiveScoped.
  deps.store.getState().setEmitTarget(deps.getSettings().previewTarget);

  function setEmitTarget(target: PreviewTarget): void {
    const key = deps.wsKey();
    if (key && 'previewTarget' in loadWorkspaceOverrides(key)) {
      saveWorkspaceOverride(key, 'previewTarget', target);
      deps.setSettings(loadSettings());
    } else {
      deps.setSettings(patchSettings({ previewTarget: target }));
    }
    deps.applyEffectiveScoped(effectiveSettings(deps.getSettings(), deps.wsKey()));
  }

  render(<EmitTargetSelector store={deps.store} onChange={setEmitTarget} />, deps.host);
}
