import type { Meta, StoryObj } from '@storybook/preact-vite';
import { StoreInspector } from '@/shell/StoreInspector';
import type { LspDiagnostic } from '@/lsp/lsp';
import type { Buffer } from '@/shell/workspaceController';
import { createAppStore } from '@/store/index';

// A read-only live view of the app store — the single source of truth made visible (debug overlay). It
// owns no setters; stories just seed a store and pass it in. The `Populated` story seeds selection, scope,
// chrome views, an active file, dirty buffers and diagnostics so every field reads non-default. Below the
// curated rows, a collapsible "Raw state" section dumps the whole store (getState() minus its setters) —
// the dump is lazy (#1134): it only populates (and serializes) once the section is expanded.

const err: LspDiagnostic = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: 'Unknown type `OrderId`',
  severity: 1,
};

const buf = (uri: string, dirty: boolean): Buffer => ({
  uri,
  path: uri,
  relPath: uri,
  name: uri,
  text: '',
  dirty,
  rootToken: '',
});

const meta = {
  title: 'Panels/StoreInspector',
  component: StoreInspector,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
  },
} satisfies Meta<typeof StoreInspector>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A fresh store: every field shows its default (scope "all", no selection, "visual" center, clean). */
export const Defaults: Story = {};

/** A working session: selection, scope, chrome views, dirty files and diagnostics all populated. */
export const Populated: Story = {
  render: (args) => {
    const store = createAppStore();
    const s = store.getState();
    s.setActiveContext('Ordering');
    s.setSelection({ qualifiedName: 'Ordering.Order', context: 'Ordering' });
    s.setBottom('events');
    s.setRight('source-control');
    s.setActive('file:///ordering.koi');
    // Seed the store-owned buffer Map (#982), keyed by uri.
    store.setState({
      buffers: new Map([
        ['file:///ordering.koi', buf('file:///ordering.koi', true)],
        ['file:///billing.koi', buf('file:///billing.koi', false)],
      ]),
    });
    s.setDiagnostics('file:///ordering.koi', [err]);
    return <StoreInspector {...args} store={store} />;
  },
};
