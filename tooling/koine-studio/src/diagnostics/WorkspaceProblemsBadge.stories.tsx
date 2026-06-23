import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WorkspaceProblemsBadge } from '@/diagnostics/WorkspaceProblemsBadge';
import type { LspDiagnostic } from '@/lsp/lsp';
import { createAppStore } from '@/store/index';

// The workspace-wide problems rollup in the status bar: it reads the WHOLE diagnostics slice (not just the
// active file) so a broken context in an unopened file is visible at a glance. It renders NOTHING while the
// workspace is clean — the absence is the "all good" signal — so the `Clean` story is intentionally empty.

const err = (msg: string): LspDiagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: msg,
  severity: 1,
});
const warn = (msg: string): LspDiagnostic => ({
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  message: msg,
  severity: 2,
});

const meta = {
  title: 'Panels/WorkspaceProblemsBadge',
  component: WorkspaceProblemsBadge,
  parameters: { layout: 'centered' },
  args: {
    store: createAppStore(),
  },
} satisfies Meta<typeof WorkspaceProblemsBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Clean workspace: the badge renders nothing (the canvas is intentionally empty). */
export const Clean: Story = {};

/** Errors and warnings spread across two files: the badge summarises them with the affected-file count. */
export const WithProblems: Story = {
  render: (args) => {
    const store = createAppStore();
    store.getState().setDiagnostics('file:///a.koi', [err('Unknown type `OrderId`')]);
    store.getState().setDiagnostics('file:///b.koi', [warn('Unused value object')]);
    return <WorkspaceProblemsBadge {...args} store={store} />;
  },
};
