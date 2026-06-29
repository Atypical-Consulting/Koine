import type { Command } from '@/shared/palette';
import { isDevMode } from '@/shell/devMode';

// Dev-only command-palette entries. Registered ALWAYS, but gated through `when: () => isDevMode()`
// (the command registry's enablement predicate, #758): the registry keeps the command but the palette
// filters it by isEnabled, so it is visible/runnable under run-ide / run-ide-web (vite serve) and
// hidden — and a no-op if dispatched — in shipped builds (vite build). That keeps debug surfaces like
// the store inspector out of the published desktop app and the deployed web playground exactly as
// before. isDevMode() is read lazily inside when() (not captured) so the gate is unit-testable with
// vi.stubEnv('DEV', …).
export function devCommands(toggleStoreInspector: () => void): Command[] {
  return [
    {
      id: 'toggle-store-inspector',
      title: 'Toggle store inspector (debug)',
      group: 'Help',
      run: toggleStoreInspector,
      when: () => isDevMode(),
    },
  ];
}
