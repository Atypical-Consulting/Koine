import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect, waitFor } from 'storybook/test';
import { UnsavedIndicator, type UnsavedIndicatorSlice } from './UnsavedIndicator';
import type { ReadableStore } from '../host/store';
import { readableStoreOf } from '../host/storeTestUtils';

// The global unsaved-work indicator. It renders no tree of its own (returns null) — instead it OWNS a
// static host `<button class="unsaved-indicator">` via effects, driving its "N unsaved" text/aria/hidden
// state and the document title's bullet from the host's dirty-buffer count. Dirty state arrives through
// the `ReadableStore<UnsavedIndicatorSlice>` host-adapter contract (issue #944); this Storybook file
// mocks that contract directly via the shared `readableStoreOf` double (host/storeTestUtils), matching
// UnsavedIndicator.test.tsx's `createTestReadableStore`. To make the pill visible in isolation, the
// story builds the host button, mounts it into the canvas, and seeds the slice before render so the
// component's effect paints the pill on first commit.

/** The static host button the indicator drives: a `<button class="unsaved-indicator">`. */
function makeHost(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'unsaved-indicator';
  return b;
}

// Render the null-rendering indicator alongside the host button it owns. The host is appended to a wrapper
// via a ref (so the pill is visible on the canvas); the component's effect — which runs after commit —
// drives the host's text/aria/hidden from the seeded slice.
function mount(store: ReadableStore<UnsavedIndicatorSlice>) {
  const host = makeHost();
  return (
    <div>
      <div
        ref={(el: HTMLElement | null) => {
          if (el && !el.contains(host)) el.append(host);
        }}
      />
      <UnsavedIndicator store={store} host={host} baseTitle="Koine Studio" onSaveAll={() => {}} />
    </div>
  );
}

const meta = {
  title: 'Panels/UnsavedIndicator',
  component: UnsavedIndicator,
  parameters: { layout: 'centered' },
  // Defaults satisfy the (all-required) props for the type; every story uses `render` to build its own
  // host button + seeded store, so these placeholders are never actually mounted.
  args: {
    store: readableStoreOf<UnsavedIndicatorSlice>({ dirtyCount: 0 }),
    host: makeHost(),
    baseTitle: 'Koine Studio',
    onSaveAll: () => {},
  },
} satisfies Meta<typeof UnsavedIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

// Only the meaningful, visible state is storied: two dirty buffers → the pill shows "2 unsaved" and the
// title gains a bullet. The inverse "all saved → pill hidden" state renders an empty `hidden` button
// (nothing to look at) and is already covered by UnsavedIndicator.test.tsx, so it earns no story here.

/** Two dirty buffers: the pill shows "2 unsaved" and the title gains a bullet. */
export const Unsaved: Story = {
  render: () => mount(readableStoreOf<UnsavedIndicatorSlice>({ dirtyCount: 2 })),
  // The indicator returns null and drives the host button's text + aria-label from a deferred effect, so
  // the button is momentarily empty after first commit. Await the effect's paint here — `play` runs before
  // the a11y `afterEach` — so axe never races the empty button into a spurious `button-name` violation.
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const host = canvasElement.querySelector<HTMLButtonElement>('.unsaved-indicator');
      expect(host).not.toBeNull();
      expect(host!.textContent).toBe('2 unsaved');
      expect(host!.getAttribute('aria-label')).toBe('Save 2 unsaved files');
    });
  },
};
