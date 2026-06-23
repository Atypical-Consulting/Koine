import type { Meta, StoryObj } from '@storybook/preact-vite';
import type { StoreApi } from 'zustand/vanilla';
import { UnsavedIndicator } from '@/shell/UnsavedIndicator';
import type { Buffer } from '@/shell/workspaceController';
import { createAppStore, type AppState } from '@/store/index';

// The global unsaved-work indicator. It renders no tree of its own (returns null) — instead it OWNS a
// static index.html `<button id="unsaved-indicator">` via effects, driving its "N unsaved" text/aria/hidden
// state and the document title's bullet from the dirty-buffer count. To make it visible in isolation, the
// stories build that host button, mount it into the canvas, and seed the store's buffers before render so
// the component's effect paints the pill on first commit.

const buf = (uri: string, dirty: boolean): Buffer => ({
  uri,
  path: uri,
  relPath: uri,
  name: uri,
  text: '',
  dirty,
});

/** The static index.html host the indicator drives: a `<button class="unsaved-indicator">`. */
function makeHost(): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'unsaved-indicator';
  return b;
}

// Render the null-rendering indicator alongside the host button it owns. The host is appended to a wrapper
// via a ref (so the pill is visible on the canvas); the component's effect — which runs after commit —
// drives the host's text/aria/hidden from the seeded buffers.
function mount(store: StoreApi<AppState>) {
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
    store: createAppStore(),
    host: makeHost(),
    baseTitle: 'Koine Studio',
    onSaveAll: () => {},
  },
} satisfies Meta<typeof UnsavedIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

// Only the meaningful, visible state is storied: two dirty buffers (plus a clean one) → the pill shows
// "2 unsaved" and the title gains a bullet. The inverse "all saved → pill hidden" state renders an empty
// `hidden` button (nothing to look at) and is already covered by UnsavedIndicator.test.tsx, so it earns no
// story here.

/** Two dirty buffers (plus a clean one): the pill shows "2 unsaved" and the title gains a bullet. */
export const Unsaved: Story = {
  render: () => {
    const store = createAppStore();
    store.getState().setBuffers({
      a: buf('file:///ordering.koi', true),
      b: buf('file:///billing.koi', true),
      c: buf('file:///shipping.koi', false),
    });
    return mount(store);
  },
};
