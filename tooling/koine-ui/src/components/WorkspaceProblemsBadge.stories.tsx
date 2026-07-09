import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WorkspaceProblemsBadge, type WorkspaceProblemsSlice } from './WorkspaceProblemsBadge';
import type { ReadableStore } from '../host/store';

// The workspace-wide problems rollup in the status bar: it reads the WHOLE diagnostics slice (not just the
// active file) so a broken context in an unopened file is visible at a glance. It renders NOTHING while the
// workspace is clean — the absence is the "all good" signal — so the `Clean` story is intentionally empty.
// The host's `ReadableStore<WorkspaceProblemsSlice>` already carries classified counts (issue #944); this
// Storybook file mocks that contract directly rather than a real Zustand store + diagnosticsSummary.

function readableStoreOf(initial: WorkspaceProblemsSlice): ReadableStore<WorkspaceProblemsSlice> {
  return {
    getState: () => initial,
    subscribe: () => () => {},
  };
}

const meta = {
  title: 'Panels/WorkspaceProblemsBadge',
  component: WorkspaceProblemsBadge,
  parameters: { layout: 'centered' },
  args: {
    store: readableStoreOf({ errors: 0, warnings: 0, fileCount: 0 }),
  },
} satisfies Meta<typeof WorkspaceProblemsBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Clean workspace: the badge renders nothing (the canvas is intentionally empty). */
export const Clean: Story = {};

/** Errors and warnings spread across two files: the badge summarises them with the affected-file count. */
export const WithProblems: Story = {
  args: {
    store: readableStoreOf({ errors: 1, warnings: 1, fileCount: 2 }),
  },
};
