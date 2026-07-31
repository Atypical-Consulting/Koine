import type { Decorator, Meta, StoryObj } from '@storybook/preact-vite';
import { expect, waitFor } from 'storybook/test';
import { useEffect } from 'preact/hooks';
import { LauncherPanel } from '@/launcher/LauncherPanel';
import type { LauncherActionDeps } from '@/launcher/actions';
import type { LauncherSources } from '@/launcher/buildCatalog';
import type { ModelIndex } from '@/model/modelIndex';
import type { GlossaryEntry } from '@/lsp/lsp';
import type { Command } from '@atypical/koine-ui';

// The ⌘K Spotlight launcher (issue #1143), brought to the migration's story+axe bar (#759, issue
// #1160). `LauncherPanel` owns its own async catalog load (`buildCatalog` awaits `sources.modelIndex()`
// + `sources.gitLog()`, issue #1143 task 2) rather than reading a store, so every story seeds a small
// in-memory `LauncherSources` fixture — plain (async) no-op functions, never `vi.fn()`, since stories
// run through the Chromium `@storybook/addon-vitest` project, not classic vitest unit mocks. The
// fixtures below (`makeSources`, `makeActionDeps`, `makeKnownCatalogSources`) are ported 1:1 from
// `LauncherPanel.test.tsx` (the proven unit-test fixtures), de-`vi`-ified.
//
// This first slice (Task 1 of #1160) scaffolds the file and covers only the curated empty-query
// default set ("Top hits" + "Recent", see `LauncherPanel.test.tsx`'s "empty query shows the curated
// Top hits / Recent default set" test) in both themes, via a new `withTheme` decorator — this repo had
// no prior Storybook theme-decorator precedent. Later #1160 tasks extend `makeKnownCatalogSources` in
// place (entity/integration-event kinds) and add the results/prefix-mode/preview/action-menu stories;
// keep that fixture easy to extend rather than forking it.
//
// The @storybook/addon-a11y axe pass (`a11y: { test: 'error' }` in `.storybook/preview.ts`) guards
// every story's accessibility, including the Chromium colour-contrast check the happy-dom unit axe
// can't see — hence the light-theme twins: the launcher's `--koi-*` tokens (koine-ui/src/tokens.css)
// flip under `html[data-theme='light']`, and contrast that holds on the dark surface isn't guaranteed
// to hold on the light one.

function makeSources(over: Partial<LauncherSources> = {}): LauncherSources {
  return {
    modelIndex: async () => ({ glossary: { entries: [] }, byQn: new Map(), qnByCtxName: new Map() }),
    commands: (): Command[] => [],
    files: () => [],
    gitLog: () => null,
    canUseGit: false,
    glossary: () => [],
    ...over,
  };
}

/** A no-op stub for the quick-action effect seam (issue #1143, task 6). */
function makeActionDeps(over: Partial<LauncherActionDeps> = {}): LauncherActionDeps {
  return {
    gotoDefinition: () => {},
    findUsages: () => {},
    peek: () => {},
    rename: () => {},
    copy: () => {},
    openFile: () => {},
    openFileChanges: () => {},
    revealFile: () => {},
    openGlossary: () => {},
    findInModel: () => {},
    gotoRule: () => {},
    viewCommit: () => {},
    revertCommit: () => {},
    runCommand: () => {},
    toast: () => {},
    ...over,
  };
}

const RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } };

/**
 * A known, small live catalog for the grouped-results stories: an aggregate + a value-object symbol,
 * a domain event, a workspace file, a registry command, and a git commit — one entry per `GROUPS`
 * category the fixture bothers to populate (mirrors `LauncherPanel.test.tsx`'s fixture of the same
 * name). Kept easy to extend in place: a later task adds entity/integration-event kinds here for the
 * Results story rather than forking a second fixture.
 */
function makeKnownCatalogSources(): LauncherSources {
  const orderAgg: GlossaryEntry = {
    id: 'Ordering.Order', name: 'Order', kind: 'aggregate', context: 'Ordering',
    qualifiedName: 'Ordering.Order', doc: null, nameRange: RANGE,
  };
  const moneyVo: GlossaryEntry = {
    id: 'Ordering.Money', name: 'Money', kind: 'quantity', context: 'Ordering',
    qualifiedName: 'Ordering.Money', doc: null, nameRange: RANGE,
  };
  const placedEvent: GlossaryEntry = {
    id: 'Ordering.OrderPlaced', name: 'OrderPlaced', kind: 'event', context: 'Ordering',
    qualifiedName: 'Ordering.OrderPlaced', doc: null, nameRange: RANGE,
  };
  const modelIndex: ModelIndex = {
    glossary: { entries: [orderAgg, moneyVo, placedEvent] },
    byQn: new Map([
      [orderAgg.qualifiedName, { entry: orderAgg }],
      [moneyVo.qualifiedName, { entry: moneyVo }],
      [placedEvent.qualifiedName, { entry: placedEvent }],
    ]),
    qnByCtxName: new Map(),
  };

  return makeSources({
    modelIndex: async () => modelIndex,
    commands: (): Command[] => [{ id: 'cmd:new-file', title: 'New file', run: () => {} }],
    files: () => [{ uri: 'file:///ws/src/Ordering/ordering.koi', relPath: 'src/Ordering/ordering.koi' }],
    gitLog: () =>
      Promise.resolve([{ sha: 'abc1234567890', author: 'Ada Lovelace', date: '2026-07-01T10:00:00Z', message: 'chore: initial commit' }]),
    canUseGit: true,
  });
}

/**
 * Applies/restores `document.documentElement.dataset.theme` around a story (the app's real theme
 * mechanism, `src/settings/theme.ts`) so a story can force the light or dark `--koi-*` token set
 * (koine-ui/src/tokens.css: `html[data-theme='light']` overrides every token; dark is the `:root`
 * default). Sets the dataset attribute in a `useEffect` (before paint) and restores whatever value was
 * there before on cleanup — never a bare delete — so this can't leak across stories sharing a page
 * session regardless of mount/unmount order.
 */
function withTheme(theme: 'light' | 'dark'): Decorator {
  return (Story) => {
    useEffect(() => {
      const prev = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = theme;
      return () => {
        if (prev === undefined) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = prev;
      };
    }, []);
    return <Story />;
  };
}

const meta = {
  title: 'Panels/LauncherPanel',
  component: LauncherPanel,
  parameters: { layout: 'fullscreen' },
  args: {
    visible: true,
    sources: makeKnownCatalogSources(),
    onClose: () => {},
    actionDeps: makeActionDeps(),
  },
} satisfies Meta<typeof LauncherPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// KNOWN RED (out of scope for this test-coverage-only change): as of this story's authoring, both
// `Empty` and `EmptyLight` below fail the Chromium `@storybook/addon-a11y` pass on REAL, pre-existing
// defects in the launcher's shipped markup/styles — not fixture bugs, and not something a story-only
// change can fix (see the file-level "no launcher runtime changes" constraint):
//  1. color-contrast: `.lx-sub` text and the `.lx-kind` DDD chip (e.g. the "AR" aggregate badge) sit
//     right at/under the WCAG AA 4.5:1 floor in the DARK theme (~4.09:1 / ~4.39:1 measured) and well
//     under it in the LIGHT theme (~2.0–2.4:1 measured) — a second, previously-uncaught instance of the
//     exact "happy-dom axe misses color-contrast" gap this issue (#1160) exists to close, distinct from
//     the sibling `<mark>` contrast miss the issue's Results story (Task 2) already anticipates.
//  2. nested-interactive: the auto-selected `.lx-item[role="option"]` row renders its tail `.lx-actbtn`
//     ("⌘K actions" trigger, ResultRow.tsx) — a focusable button — INSIDE the ARIA `option`, which axe's
//     `nested-interactive` rule flags. Since the first result row is always selected on open
//     (`selectedIndex` state, LauncherPanel.tsx) and any row with quick actions renders this button, this
//     reproduces on essentially every result row, in every theme — so it will resurface in the
//     Results/prefix-mode/preview/action-menu stories (Tasks 2–4) too, not just here.
// Needs a launcher-runtime follow-up (raise the `.lx-sub`/`.lx-kind` contrast tokens; stop nesting
// `.lx-actbtn` inside the `role="option"` row) before this file's axe pass — and Task 4's "full green
// storybook run" goal — can hold. Flagged for the PR/code-review pass rather than fixed here.

/** The empty-query curated default set ("Top hits" + "Recent", 3 `.lx-item` rows drawn from the known
 *  catalog fixture — 2 symbols + 1 commit) on the app's dark theme. Applies `withTheme('dark')`
 *  explicitly (rather than relying on it being the unstyled default) so this story can't inherit a
 *  leaked `dataset.theme` from an earlier story in the same browser session, and for symmetry with
 *  {@link EmptyLight}. The `play` waits for the async catalog join (`buildCatalog` awaiting
 *  `modelIndex()` + `gitLog()`) to paint before the axe/visual pass runs against a still-loading panel. */
export const Empty: Story = {
  decorators: [withTheme('dark')],
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
  },
};

/** The same curated empty-query default set, forced to the light theme (`withTheme('light')`) on the
 *  matching `light` background (#ffffff, declared in `.storybook/preview.ts`) — the Chromium
 *  colour-contrast axe check on the launcher's light `--koi-*` token set, which the dark-surface
 *  {@link Empty} story can't exercise. */
export const EmptyLight: Story = {
  decorators: [withTheme('light')],
  parameters: { backgrounds: { default: 'light' } },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.lx-item').length).toBeGreaterThan(0));
  },
};
