import type { Meta, StoryObj } from '@storybook/preact-vite';
import { DiagnosticsStripPanel } from '@/diagnostics/DiagnosticsStripPanel';
import type { LspDiagnostic } from '@/lsp/lsp';
import { createAppStore } from '@/store/index';

// The editor's diagnostics strip for the ACTIVE file: a `clean` / `N error(s) · M warning(s)` count plus
// one clickable row per diagnostic. `activeUri` selects which file's diagnostics it shows; diagnostics are
// pushed into the store with `setDiagnostics`. Each non-default story builds a fresh createAppStore() and
// seeds it before render, so the rows are present on first paint (no act()/re-render needed in a story).

const ACTIVE = 'file:///a.koi';

// One diagnostic on (0-based) line 2, col 3 → the strip renders it 1-based as "<sev> 3:4".
const err = (msg: string): LspDiagnostic => ({
  range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
  message: msg,
  severity: 1,
});
const warn = (msg: string): LspDiagnostic => ({
  range: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } },
  message: msg,
  severity: 2,
});

const meta = {
  title: 'Panels/DiagnosticsStripPanel',
  component: DiagnosticsStripPanel,
  parameters: { layout: 'padded' },
  args: {
    store: createAppStore(),
    activeUri: () => ACTIVE,
    onGoto: () => {},
  },
} satisfies Meta<typeof DiagnosticsStripPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No diagnostics: the count reads "clean" and the body shows "No diagnostics." */
export const Clean: Story = {};

/** A mix of errors and warnings on the active file: the count summarises them and each gets a row. */
export const WithDiagnostics: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setDiagnostics(ACTIVE, [err('Unknown type `OrderId`'), warn('Unused value object')]);
    return <DiagnosticsStripPanel {...args} store={store} />;
  },
};
