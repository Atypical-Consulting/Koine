// Pins the exact runtime (value) export surface of persistence.ts (issue #988). The monolith is about
// to be carved into settingsStore.ts / secrets.ts / workspaceState.ts / diagramState.ts (+ an internal
// storage.ts), re-exported from this file as a barrel — so this "barrel is lossless" guard exists to
// catch an export silently dropped (or its name changed) during that later split. A sorted snapshot of
// `Object.keys()` on the namespace import is exhaustive for VALUES (functions and consts) because those
// are the only things that exist on the module object at runtime.
//
// Note: `import * as persistence` (and therefore `Object.keys()`) only sees runtime bindings. Type-only
// exports (`export type ThemeName`, `export interface Settings`, `export interface RecentFolder`, etc.)
// are erased by the TypeScript compiler and never appear here — they have no runtime representation to
// pin. Those are instead guarded by `npm run build` (tsc strict): a later module dropping or renaming an
// exported type is a compile error at every import site, which is a stronger check than a runtime list
// could give anyway.
import { describe, expect, test } from 'vitest';
import * as persistence from '@/settings/persistence';

describe('persistence.ts export surface (#988 barrel guard)', () => {
  test('the exact sorted list of runtime (value) exports', () => {
    expect(Object.keys(persistence).sort()).toEqual([
      'ACCENT_NAMES',
      'CHAT_HISTORY_CAP',
      'DEFAULT_SETTINGS',
      'WORKSPACE_OVERRIDE_KEY_PREFIX',
      'WORKSPACE_SCOPED_KEYS',
      'clearApiKey',
      'clearChat',
      'clearDiagramPositions',
      'clearKeybindingOverrides',
      'clearLastWorkspace',
      'clearLegacyScratch',
      'clearRecentFolders',
      'effectiveSettings',
      'getLastSession',
      'getLastWorkspace',
      'getRecentFolders',
      'initSecrets',
      'isStartupView',
      'loadActiveContext',
      'loadChat',
      'loadDiagramAnnotations',
      'loadDiagramPositions',
      'loadDiagramZoom',
      'loadKeybindingOverrides',
      'loadSettings',
      'loadWorkspaceCenter',
      'loadWorkspaceDeck',
      'loadWorkspaceOverrides',
      'patchSettings',
      'peekLegacyScratch',
      'pinRecentFolder',
      'pushRecentFolder',
      'removeRecentFolder',
      'replaceWorkspaceOverrides',
      'resolveKeybindings',
      'saveActiveContext',
      'saveApiKey',
      'saveChat',
      'saveDiagramAnnotations',
      'saveDiagramPositions',
      'saveDiagramZoom',
      'saveKeybindingOverride',
      'saveSettings',
      'saveWorkspaceCenter',
      'saveWorkspaceDeck',
      'saveWorkspaceOverride',
      'setLastSession',
      'setLastWorkspace',
      'whenSecretsReady',
      'workspaceKeyOf',
    ]);
  });
});
