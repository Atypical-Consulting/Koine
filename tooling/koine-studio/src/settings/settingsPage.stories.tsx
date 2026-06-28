import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect, waitFor } from 'storybook/test';
import { EditorView } from '@codemirror/view';
import { createSettingsPage, type SettingsPageHandle, type SettingsEditorMode } from '@/settings/settingsPage';
import type { PrefsCallbacks } from '@/settings/prefs';

// The gear-launched Settings center PAGE (#center-panel-settings) — a transient center view, NOT a modal.
// createSettingsPage is a vanilla DOM factory: it mounts a Visual/JSON segmented toggle into the page
// header and one of two body representations — the same two-pane preference form the modal embeds, or a
// schema-validated, editable settings.json editor with a role=alert diagnostics strip. These stories run
// the factory in the Storybook/Chromium project so axe checks REAL color-contrast on the toggle radios,
// the JSON editor chrome and the diagnostics strip. No secret is present in an empty story env, and the
// JSON surface never serializes the encrypted key anyway.
//
// The factory mounts into EXISTING DOM hosts, so each story renders the production host markup (mirroring
// index.html: a #settings-page-header carrying the #settings-mode-toggle slot + a #settings-page-body) and
// calls the factory from a callback ref once those hosts exist — the same imperative-mount idiom the panel
// hosts (DocsPanelHost) use. The whole thing sits inside a <main> landmark so the axe "region"
// best-practice rule is satisfied (matching settingsPage.test.tsx).

// localStorage key for the active representation (private to settingsPage.tsx; mirrored here so each story
// can deterministically open on its own side regardless of the previous story's persisted choice).
const MODE_KEY = 'koine.studio.settingsEditorMode';

// The page only ever calls cb.onChange; every other PrefsCallbacks member is optional, and omitting
// mcpEndpoint means the bare story env never (re)starts the MCP sidecar. A no-op live-apply hook is all a
// presentational story needs.
const callbacks: PrefsCallbacks = { onChange: () => {} };

// Render the production host markup and run createSettingsPage into it once mounted. The persisted
// representation is seeded into localStorage BEFORE construct (the factory reads it at construct time), so
// the page opens on the requested side; on unmount the handle is destroyed so the next story starts clean.
function mountSettingsPage(mode: SettingsEditorMode) {
  let handle: SettingsPageHandle | null = null;
  const mountRef = (root: HTMLElement | null): void => {
    if (root && !handle) {
      try {
        localStorage.setItem(MODE_KEY, mode);
      } catch {
        // private-mode / quota: the factory simply falls back to its default representation.
      }
      const header = root.querySelector<HTMLElement>('#settings-page-header')!;
      const body = root.querySelector<HTMLElement>('#settings-page-body')!;
      handle = createSettingsPage({ header, body }, callbacks);
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
          <div id="settings-mode-toggle" class="settings-mode-toggle"></div>
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
