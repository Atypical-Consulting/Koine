import type { Command } from '@/shared/palette';
import { isDevMode } from '@/shell/devMode';

// Dev-only command-palette entries. Gated on isDevMode() so they register under run-ide /
// run-ide-web (vite serve) but never in shipped builds (vite build) — keeping debug surfaces
// like the store inspector out of the published desktop app and the deployed web playground.
// Kept a pure helper (takes its action as a parameter, reads isDevMode() at call time) so the
// gate is unit-testable with vi.stubEnv('DEV', …).
export function devCommands(toggleStoreInspector: () => void): Command[] {
  if (!isDevMode()) return [];
  return [
    {
      id: 'toggle-store-inspector',
      title: 'Toggle store inspector (debug)',
      group: 'Help',
      run: toggleStoreInspector,
    },
  ];
}
