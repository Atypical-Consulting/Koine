import type { Meta, StoryObj } from '@storybook/preact-vite';
import { expect, waitFor } from 'storybook/test';
// Explicit `.tsx` extension: the facade `generateProjectWizard.ts` and this component
// `GenerateProjectWizard.tsx` differ only by first-letter case, so on a case-insensitive filesystem an
// extensionless import could resolve `.ts` first and load the facade (which doesn't export the component).
import { GenerateProjectWizard, type GenerateProjectDeps, type Target } from '@/export/GenerateProjectWizard.tsx';
import type { EmitPreviewResult } from '@/lsp/lsp';

// The Generate Project wizard (#991 Task 2) — the multi-step "model → downloadable archive" assistant, as a
// Preact component. In the app it renders into a shared modal (createModal); here each story renders the
// bare `.koi-wizard` so the @storybook/addon-a11y axe pass (Chromium/CI — the color-contrast rules happy-dom
// can't run) audits each step. Stories run in the Chromium project, so `deps` are plain async fakes (no
// `vi`); the multi-step ones drive the real Next button through the async emit via `play`.

const EXT: Record<string, string> = { csharp: 'cs', typescript: 'ts', python: 'py', php: 'php', rust: 'rs' };

/** A successful emit: two namespaced files under a `Billing/` context, extension keyed to the target. */
function previewOk(target: Target): EmitPreviewResult {
  const ext = EXT[target] ?? 'txt';
  return {
    target,
    files: [
      { path: `Billing/Orders/Order.${ext}`, contents: '// order' },
      { path: `Billing/Money.${ext}`, contents: '// money' },
    ],
    diagnostics: [],
    error: null,
  };
}

/** The happy-path deps: compiles clean, has a glossary, saves successfully. */
const okDeps: GenerateProjectDeps = {
  emitPreview: async (target) => previewOk(target),
  glossary: async () => ({ markdown: '# Glossary' }),
  saveZip: async () => true,
};

/** Deps whose emit fails, for the Language-step error banner. */
const errorDeps: GenerateProjectDeps = {
  emitPreview: async () => ({ target: 'csharp', files: [], diagnostics: [], error: 'KOI0042: Unknown type `Money`' }),
  glossary: async () => ({ markdown: '' }),
  saveZip: async () => false,
};

const primaryBtn = (root: HTMLElement): HTMLButtonElement =>
  root.querySelector<HTMLButtonElement>('.koi-wizard-btn.primary')!;

/** Click Next and wait until the given step marker mounts (the first Next compiles asynchronously). */
async function advanceTo(root: HTMLElement, marker: string): Promise<void> {
  primaryBtn(root).click();
  await waitFor(() => expect(root.querySelector(marker)).toBeTruthy());
}

const meta = {
  title: 'Panels/GenerateProjectWizard',
  component: GenerateProjectWizard,
  parameters: { layout: 'padded' },
  args: {
    deps: okDeps,
    onClose: () => {},
  },
} satisfies Meta<typeof GenerateProjectWizard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Step 1 — Language: the target radiogroup, seeded from the live EMIT_TARGETS, C# selected. */
export const Language: Story = {};

/** Step 2 — Artifacts: the always-on "Source files", the C#-only `.csproj`, and the glossary toggle. */
export const Artifacts: Story = {
  play: async ({ canvasElement }) => {
    await advanceTo(canvasElement, '.koi-wizard-checks');
  },
};

/** Step 3 — Name: the project-name field with its live validity aria (starts valid, defaulted from the
 *  emitted namespace). */
export const Name: Story = {
  play: async ({ canvasElement }) => {
    await advanceTo(canvasElement, '.koi-wizard-checks');
    await advanceTo(canvasElement, '#koi-gen-name');
  },
};

/** Step 4 — Generate: the review summary (language, name, artifacts, source-file count). */
export const Generate: Story = {
  play: async ({ canvasElement }) => {
    await advanceTo(canvasElement, '.koi-wizard-checks');
    await advanceTo(canvasElement, '#koi-gen-name');
    await advanceTo(canvasElement, '.koi-wizard-generate');
  },
};

/** The model can't emit: the wizard holds on the Language step and announces the error via the persistent
 *  live region + the error banner, rather than advancing. */
export const EmitError: Story = {
  args: { deps: errorDeps },
  play: async ({ canvasElement }) => {
    primaryBtn(canvasElement).click();
    await waitFor(() => expect(canvasElement.querySelector('.koi-wizard-banner.error')).toBeTruthy());
  },
};
