// "Generate Project" wizard facade: wires koine-ui's shared modal chrome (overlay.ts) to the Preact
// wizard component (GenerateProjectWizard.tsx) and returns the imperative `{ open, close }` handle its
// callers (exportShare.ts) already depend on. The wizard itself — steps, state, async emit/generate — lives
// in the component; this file owns only the modal shell and the per-open remount that resets the wizard.
//
// NOTE: the component import carries an explicit `.tsx` extension on purpose. The facade
// (`generateProjectWizard.ts`) and the component (`GenerateProjectWizard.tsx`) differ only by the case of
// their first letter, so on a case-insensitive filesystem an extensionless `./GenerateProjectWizard` could
// resolve `.ts` first and (mis)load this very facade. The explicit extension pins the component.
import { createModal } from '@atypical/koine-ui';
import { renderGenerateProjectWizard, type GenerateProjectDeps } from '@/export/GenerateProjectWizard.tsx';

// Re-exported so callers keep importing the public surface from this module unchanged (exportShare.ts,
// emitTargets.test.ts, generateProjectWizard.test.ts).
export { wizardTargets } from '@/export/GenerateProjectWizard.tsx';
export type { GenerateProjectDeps, Target } from '@/export/GenerateProjectWizard.tsx';

export interface GenerateProjectHandle {
  open(): void;
  close(): void;
}

/** Build the Generate-Project wizard once and return an imperative `{ open, close }` handle. */
export function createGenerateProject(deps: GenerateProjectDeps): GenerateProjectHandle {
  const modal = createModal({ title: 'Generate Project', ariaLabel: 'Generate a project from the model' });

  // Session counter, bumped on every open so the component remounts (fresh `key`) with reset state. The
  // remount is what invalidates any async work still in flight from a previous session: the old instance
  // unmounts, its `aliveRef` flips false, and its pending emit/generate discards its result on resume —
  // the same guarantee the imperative wizard's `epoch` gave.
  let session = 0;
  modal.onOpen(() => {
    session += 1;
    renderGenerateProjectWizard(modal.body, { session, deps, onClose: modal.close });
  });

  return { open: modal.open, close: modal.close };
}
