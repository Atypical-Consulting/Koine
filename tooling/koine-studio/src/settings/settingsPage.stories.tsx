import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect, waitFor } from 'storybook/test';
import { EditorView } from '@codemirror/view';
import { createSettingsPage, type SettingsPageHandle, type SettingsEditorMode } from '@/settings/settingsPage';
import type { PrefsCallbacks } from '@/settings/prefs';
import { WORKSPACE_OVERRIDE_KEY_PREFIX } from '@/settings/persistence';

// The gear-launched Settings center PAGE (#center-panel-settings) — a transient center view, NOT a modal.
// createSettingsPage is a vanilla DOM factory: it mounts a Visual/JSON segmented toggle into the page
// header and one of two body representations — the same two-pane preference form the modal embeds, or a
// schema-validated, editable settings.json editor with a role=alert diagnostics strip. These stories run
// the factory in the Storybook/Chromium project so axe checks REAL color-contrast on the toggle radios,
// the JSON editor chrome and the diagnostics strip. No secret is present in an empty story env, and the
// JSON surface never serializes the encrypted key anyway.
//
// The factory mounts into EXISTING DOM hosts, so each story renders the production host markup (mirroring
// index.html: a #settings-page-header carrying the #settings-scope-toggle + #settings-mode-toggle slots on
// one row + a #settings-page-body) and calls the factory from a callback ref once those hosts exist — the
// same imperative-mount idiom the panel hosts (DocsPanelHost) use. The whole thing sits inside a <main>
// landmark so the axe "region" best-practice rule is satisfied (matching settingsPage.test.tsx).

// localStorage key for the active representation (private to settingsPage.tsx; mirrored here so each story
// can deterministically open on its own side regardless of the previous story's persisted choice).
const MODE_KEY = 'koine.studio.settingsEditorMode';
// localStorage key for the active JSON scope (private to settingsPage.tsx; reset before each mount so a
// prior story's Workspace selection does not bleed into later stories).
const SCOPE_KEY = 'koine.studio.settingsJsonScope';

// The page only ever calls cb.onChange; every other PrefsCallbacks member is optional, and omitting
// mcpEndpoint means the bare story env never (re)starts the MCP sidecar. A no-op live-apply hook is all a
// presentational story needs.
const callbacks: PrefsCallbacks = { onChange: () => {} };

// Render the production host markup and run createSettingsPage into it once mounted. The persisted
// representation is seeded into localStorage BEFORE construct (the factory reads it at construct time), so
// the page opens on the requested side; on unmount the handle is destroyed so the next story starts clean.
// An optional `cb` override lets workspace-capable stories inject a workspaceKey callback.
function mountSettingsPage(mode: SettingsEditorMode, cb: PrefsCallbacks = callbacks) {
  let handle: SettingsPageHandle | null = null;
  const mountRef = (root: HTMLElement | null): void => {
    if (root && !handle) {
      try {
        localStorage.setItem(MODE_KEY, mode);
        // Reset scope so a prior story's Workspace selection never bleeds into this one.
        localStorage.removeItem(SCOPE_KEY);
        // If this is a workspace-capable story, clear any stale workspace overrides blob too.
        if (cb.workspaceKey) {
          const wsKey = cb.workspaceKey();
          if (wsKey) localStorage.removeItem(WORKSPACE_OVERRIDE_KEY_PREFIX + wsKey);
        }
      } catch {
        // private-mode / quota: the factory simply falls back to its default representation.
      }
      const header = root.querySelector<HTMLElement>('#settings-page-header')!;
      const body = root.querySelector<HTMLElement>('#settings-page-body')!;
      handle = createSettingsPage({ header, body }, cb);
    } else if (!root && handle) {
      handle.destroy();
      handle = null;
    }
  };
  return (
    <main>
      <section id="center-panel-settings" class="center-host" role="tabpanel" aria-label="Settings" ref={mountRef}>
        <header id="settings-page-header" class="settings-page-header">
          <h2 class="settings-page-title">Settings</h2>
          <div class="settings-page-header-controls">
            <div id="settings-scope-toggle" class="settings-scope-toggle"></div>
            <div id="settings-mode-toggle" class="settings-mode-toggle"></div>
          </div>
        </header>
        <div id="settings-page-body" class="settings-page-body"></div>
      </section>
    </main>
  );
}

const meta = {
  title: 'Settings/SettingsPage',
  parameters: { layout: 'fullscreen' },
  render: () => mountSettingsPage('visual'),
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** The Visual representation (the default): the same two-pane preference form the modal embeds, with the
 * Visual radio active in the header toggle. */
export const Visual: Story = {};

/** The JSON representation: the schema-aware settings.json editor (the encrypted key is stripped from the
 * seed), with the JSON radio active in the header toggle. */
export const Json: Story = {
  render: () => mountSettingsPage('json'),
};

/** An invalid edit in the JSON representation: the role=alert diagnostics strip is revealed (and the bad
 * document is never persisted). The play function drives a real edit through the editor's onChange seam,
 * then waits for the debounced validate to surface the strip so axe checks its contrast too. */
export const InvalidJson: Story = {
  render: () => mountSettingsPage('json'),
  play: async ({ canvasElement }) => {
    const view = EditorView.findFromDOM(canvasElement.querySelector<HTMLElement>('.cm-editor')!)!;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '{ "theme": ' } });
    await waitFor(
      () => {
        const strip = canvasElement.querySelector<HTMLElement>('.settings-json-diagnostics');
        expect(strip).not.toBeNull();
        expect(strip!.hidden).toBe(false);
      },
      { timeout: 3000 },
    );
  },
};

/** JSON mode with a workspace OPEN (Workspace pill enabled) and the editor switched to Workspace scope.
 * The play function clicks the Workspace radio so axe sees the enabled, selected scope toggle and the
 * flat workspace document. Drives the Chromium axe project's contrast + roles check for the new control. */
export const JsonWorkspaceScope: Story = {
  render: () =>
    mountSettingsPage('json', { onChange: () => {}, workspaceKey: () => 'sb-ws' }),
  play: async ({ canvasElement }) => {
    const scopeGroup = canvasElement.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Settings JSON scope"]');
    const wsRadio = scopeGroup?.querySelector<HTMLElement>('[data-value="workspace"]');
    wsRadio?.click();
    await waitFor(
      () => {
        expect(wsRadio?.getAttribute('aria-checked')).toBe('true');
      },
      { timeout: 3000 },
    );
  },
};

/** JSON mode with NO workspace open (default callbacks, no workspaceKey): the Workspace pill is disabled
 * and the empty-state note "Open a folder to edit workspace settings" renders. Lets axe verify the
 * disabled control and the note's color-contrast. */
export const JsonNoWorkspace: Story = {
  render: () => mountSettingsPage('json'),
  play: async ({ canvasElement }) => {
    const note = canvasElement.querySelector<HTMLElement>('.settings-json-scope-empty');
    expect(note).not.toBeNull();
    const scopeGroup = canvasElement.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Settings JSON scope"]');
    const wsRadio = scopeGroup?.querySelector<HTMLButtonElement>('[data-value="workspace"]');
    expect(wsRadio?.disabled).toBe(true);
  },
};
