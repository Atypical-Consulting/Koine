import type { Meta, StoryObj } from '@storybook/preact-vite';
import { WorkspaceProblemsBadge, type WorkspaceProblemsSlice } from './WorkspaceProblemsBadge';
import { readableStoreOf } from '../host/storeTestUtils';

// The workspace-wide problems rollup in the status bar: it reads the WHOLE diagnostics slice (not just the
// active file) so a broken context in an unopened file is visible at a glance. It renders NOTHING while the
// workspace is clean — the absence is the "all good" signal — so the `Clean` story is intentionally empty.
// The host's `ReadableStore<WorkspaceProblemsSlice>` already carries classified counts (issue #944); this
// Storybook file mocks that contract directly (the shared `readableStoreOf` double, host/storeTestUtils)
// rather than a real Zustand store + diagnosticsSummary.

const meta = {
  title: 'Panels/WorkspaceProblemsBadge',
  component: WorkspaceProblemsBadge,
  parameters: { layout: 'centered' },
  args: {
    store: readableStoreOf<WorkspaceProblemsSlice>({ kind: 'clean', parts: [], fileCount: 0 }),
  },
} satisfies Meta<typeof WorkspaceProblemsBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Clean workspace: the badge renders nothing (the canvas is intentionally empty). */
export const Clean: Story = {};

/** Errors and warnings spread across two files: the badge summarises them with the affected-file count. */
export const WithProblems: Story = {
  args: {
    store: readableStoreOf<WorkspaceProblemsSlice>({ kind: 'error', parts: ['1 error', '1 warning'], fileCount: 2 }),
  },
};
