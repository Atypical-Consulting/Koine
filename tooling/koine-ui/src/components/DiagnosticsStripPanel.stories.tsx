import type { Meta, StoryObj } from '@storybook/preact-vite';
import {
  DiagnosticsStripPanel,
  type DiagnosticsStripRow,
  type DiagnosticsStripSlice,
} from './DiagnosticsStripPanel';
import type { ReadableStore } from '../host/store';

// The editor's diagnostics strip: a `clean` / `N error(s) · M warning(s)` count plus one clickable row
// per diagnostic. Rows/count arrive already scoped, classified and formatted through the
// `ReadableStore<DiagnosticsStripSlice>` host-adapter contract (issue #944); this Storybook file mocks
// that contract directly, matching DiagnosticsStripPanel.test.tsx's `createMockStripStore`.

function readableStoreOf(initial: DiagnosticsStripSlice): ReadableStore<DiagnosticsStripSlice> {
  return {
    getState: () => initial,
    subscribe: () => () => {},
  };
}

// One diagnostic on (0-based) line 2, col 3 → the strip renders it 1-based as "<sev> 3:4".
const err = (message: string): DiagnosticsStripRow => ({
  uri: 'file:///a.koi',
  severity: 'error',
  range: { start: { line: 2, character: 3 }, end: { line: 2, character: 4 } },
  message,
});
const warn = (message: string): DiagnosticsStripRow => ({
  uri: 'file:///a.koi',
  severity: 'warning',
  range: { start: { line: 5, character: 0 }, end: { line: 5, character: 6 } },
  message,
});

const meta = {
  title: 'Panels/DiagnosticsStripPanel',
  component: DiagnosticsStripPanel,
  parameters: { layout: 'padded' },
  args: {
    store: readableStoreOf({ scoped: false, rows: [], count: 'clean', kind: 'clean' }),
    onGoto: () => {},
  },
} satisfies Meta<typeof DiagnosticsStripPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No diagnostics: the count reads "clean" and the body shows "No diagnostics." */
export const Clean: Story = {};

/** A mix of errors and warnings on the active file: the count summarises them and each gets a row. */
export const WithDiagnostics: Story = {
  args: {
    store: readableStoreOf({
      scoped: false,
      rows: [err('Unknown type `OrderId`'), warn('Unused value object')],
      count: '1 error · 1 warning',
      kind: 'error',
    }),
  },
};

/** Scoped to a bounded context (ADR 0009 / #1188): rows span the context's files, each file-labelled. */
export const ScopedToContext: Story = {
  args: {
    store: readableStoreOf({
      scoped: true,
      rows: [
        { ...err('Unknown type `OrderId`'), uri: 'file:///Billing.koi', label: 'Billing.koi' },
        { ...warn('Unused value object'), uri: 'file:///Billing.koi', label: 'Billing.koi' },
      ],
      count: '1 error · 1 warning',
      kind: 'error',
    }),
    onOpen: () => {},
  },
};
