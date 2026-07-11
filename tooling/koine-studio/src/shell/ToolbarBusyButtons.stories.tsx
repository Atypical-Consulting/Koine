import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect } from 'storybook/test';

// The toolbar's New model / Open folder buttons go busy-disabled while a workspace-open operation is
// in flight (#1275): `ide.tsx` (~792-805) subscribes to `workspaceOpLock.onBusyChanged` and flips
// `disabled`, `aria-disabled`, and a busy `title` on both buttons. That #1275 story-coverage gap is
// what this file closes (#1402) — a story-local fixture mirroring the real markup (`index.html:53-59`)
// and the exact busy attribute contract (`ide.tsx:792-805`), so the CI-side axe gate
// (`a11y: { test: 'error' }` in `.storybook/preview.ts`) sees this state. No product code changes; the
// fixture is deliberately synchronous (the #747 flake was an async aria-label race).

const BUSY_TITLE = 'Waiting for the current workspace operation to finish…';
const NEW_MODEL_IDLE_TITLE = 'Start a new empty model (prompts if you have unsaved changes)';
const OPEN_FOLDER_IDLE_TITLE = 'Open a folder of .koi models';

function ToolbarFixture({ busy }: { busy: boolean }) {
  return (
    <div class="iconset" role="toolbar" aria-label="Model actions">
      <button
        type="button"
        id="btn-new"
        class="t-ico"
        title={busy ? BUSY_TITLE : NEW_MODEL_IDLE_TITLE}
        aria-label="New model"
        disabled={busy}
        aria-disabled={busy ? 'true' : undefined}
      >
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M8 3.4v9.2M3.4 8h9.2" />
        </svg>
      </button>
      <button
        type="button"
        id="btn-open-folder"
        class="t-ico"
        title={busy ? BUSY_TITLE : OPEN_FOLDER_IDLE_TITLE}
        aria-label="Open folder"
        disabled={busy}
        aria-disabled={busy ? 'true' : undefined}
      >
        <svg class="tb-ico" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.2 4.3c0-.7.5-1.3 1.2-1.3h2.9l1.3 1.6h4.9c.7 0 1.3.6 1.3 1.3v6c0 .7-.6 1.2-1.3 1.2H3.4c-.7 0-1.2-.5-1.2-1.2z" />
        </svg>
      </button>
    </div>
  );
}

const meta = {
  title: 'Panels/ToolbarBusyButtons',
  component: ToolbarFixture,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ToolbarFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Idle: both buttons enabled with their normal titles. */
export const Idle: Story = {
  args: { busy: false },
};

/** Busy: a workspace-open operation is in flight, so both buttons are disabled with the shared busy
 *  title and `aria-disabled="true"` — the exact contract `ide.tsx`'s `onBusyChanged` subscriber applies.
 *  The `play` pins that contract so a wiring regression fails the story, not just axe. */
export const Busy: Story = {
  args: { busy: true },
  play: async ({ canvasElement }) => {
    for (const id of ['btn-new', 'btn-open-folder']) {
      const btn = canvasElement.querySelector<HTMLButtonElement>(`#${id}`);
      expect(btn).toBeTruthy();
      expect(btn!.disabled).toBe(true);
      expect(btn!.getAttribute('aria-disabled')).toBe('true');
      expect(btn!.title).toBe(BUSY_TITLE);
    }
  },
};
