// Per-result quick actions for the Spotlight launcher (issue #1143, task 6). Ported from
// `actionsFor(e)` in design/design_handoff_git_spotlight_logos/koine-launcher.js: an ordered
// `[label, keycap, icon]` list per category, first entry the default (bound to ↵). The prototype's
// `run()` was `showToast(a[0], f.e.title)` with no real effect; here each action's `run()` calls a
// method on the injected `LauncherActionDeps` seam instead, so this module stays pure/DOM-free and
// unit-testable with stub deps — Task 8 supplies the concrete implementation bound to `lsp`/
// `platform`/`openUri`/clipboard (see scratchpad/SEAMS.md "LSP action seams").
//
// Import discipline (enforced by buildCatalog.test.ts's launcher-wide sweep): the only value import
// allowed from outside `@/launcher/` is `import type` — except for the shared pure constants module
// (`catalog.ts`), which exports only types and side-effect-free helpers like `relPathOf`.
import type { CatalogEntry } from '@/launcher/catalog';
import { relPathOf } from '@/launcher/catalog';

/** The 13 line-icon glyphs a quick action can render, ported verbatim (path data unchanged) from the
 * prototype's `I` map. `ActionMenu.tsx` owns the actual SVG path data keyed by this slug. */
export type ActionIcon =
  | 'goto'
  | 'ref'
  | 'peek'
  | 'rename'
  | 'copy'
  | 'run'
  | 'file'
  | 'diff'
  | 'gloss'
  | 'search'
  | 'commit'
  | 'state'
  | 'open';

/** One quick action in a result's `actionsFor` list. The first action returned for a given entry is
 * always the DEFAULT — the one ↵ runs (on the row, or as the top row of the `.lx-actmenu` popover). */
export interface LauncherAction {
  label: string;
  keycap: string;
  icon?: ActionIcon;
  run(): void | Promise<void>;
}

/**
 * The high-level effect seam a quick action's `run()` calls into. Every method is a coarse, named
 * intent ("go to definition", "copy this text") rather than a raw LSP/clipboard/host call, so this
 * module (and its tests) never import `lsp`/`platform`/`openUri` directly — Task 8 binds each method to
 * the real seam listed in its doc comment.
 */
export interface LauncherActionDeps {
  /** `lsp.definition(...)` + `deps.openUri(...)` (Task 8). */
  gotoDefinition(entry: CatalogEntry): void | Promise<void>;
  /** `lsp.references(...)`, surfaced via the Search panel (`deps.search.focus()`) or a results list. */
  findUsages(entry: CatalogEntry): void | Promise<void>;
  /** A non-navigating "quick look" at the entry (inline preview / hover), short of a full jump. */
  peek(entry: CatalogEntry): void | Promise<void>;
  /** `lsp.prepareRename(...)` + `lsp.rename(...)`. */
  rename(entry: CatalogEntry): void | Promise<void>;
  /** `navigator.clipboard.writeText(text)` — the one place raw text ever leaves this module. */
  copy(text: string): void | Promise<void>;
  /** Opens a workspace file — `deps.openUri(uri)`. */
  openFile(entry: CatalogEntry): void | Promise<void>;
  /** Opens a file's pending changes (Source Control / diff view). */
  openFileChanges(entry: CatalogEntry): void | Promise<void>;
  /** Reveals a file in the host's file explorer/finder. */
  revealFile(entry: CatalogEntry): void | Promise<void>;
  /** Opens the ubiquitous-language glossary entry (glossary panel / docs). */
  openGlossary(entry: CatalogEntry): void | Promise<void>;
  /** Finds the term across the model — `deps.search.focus()` (text search panel). */
  findInModel(entry: CatalogEntry): void | Promise<void>;
  /** Jumps to an invariant/business rule's declaration. */
  gotoRule(entry: CatalogEntry): void | Promise<void>;
  /** Opens a commit's detail view against the git store. */
  viewCommit(entry: CatalogEntry): void | Promise<void>;
  /** Reverts a commit via the git store. */
  revertCommit(entry: CatalogEntry): void | Promise<void>;
  /** `registry.run(cmdId)` for an `action`-category entry. */
  runCommand(entry: CatalogEntry): void | Promise<void>;
  /** Requests a transient confirmation toast (`.lx-toast`); the panel renders it. */
  toast(message: string): void;
}


async function copyAndToast(deps: LauncherActionDeps, text: string, message: string): Promise<void> {
  await deps.copy(text);
  deps.toast(message);
}

/**
 * The per-category ordered quick-action list — ported verbatim (labels, keycaps, icon slugs, and
 * order) from the prototype's `actionsFor`. Index 0 is always the default (↵). Every `run()` closes
 * over `entry` and calls exactly one `deps` method; the three "Copy …" actions additionally confirm
 * via `deps.toast` once the copy resolves.
 */
export function actionsFor(entry: CatalogEntry, deps: LauncherActionDeps): LauncherAction[] {
  switch (entry.cat) {
    case 'symbol':
      return [
        { label: 'Go to definition', keycap: '↵', icon: 'goto', run: () => deps.gotoDefinition(entry) },
        { label: 'Find usages', keycap: '⇧↵', icon: 'ref', run: () => deps.findUsages(entry) },
        { label: 'Peek', keycap: '⌥↵', icon: 'peek', run: () => deps.peek(entry) },
        { label: 'Rename symbol', keycap: 'F2', icon: 'rename', run: () => deps.rename(entry) },
        {
          label: 'Copy name',
          keycap: '⌘C',
          icon: 'copy',
          run: () => copyAndToast(deps, entry.title, `Copied "${entry.title}"`),
        },
      ];
    case 'event':
      return [
        { label: 'Go to definition', keycap: '↵', icon: 'goto', run: () => deps.gotoDefinition(entry) },
        { label: 'Show producers & consumers', keycap: '⇧↵', icon: 'ref', run: () => deps.findUsages(entry) },
        { label: 'Trace flow', keycap: '⌥↵', icon: 'state', run: () => deps.peek(entry) },
      ];
    case 'action':
      return [{ label: 'Run', keycap: '↵', icon: 'run', run: () => deps.runCommand(entry) }];
    case 'file':
      return [
        { label: 'Open', keycap: '↵', icon: 'file', run: () => deps.openFile(entry) },
        { label: 'Open changes', keycap: '⇧↵', icon: 'diff', run: () => deps.openFileChanges(entry) },
        { label: 'Reveal in Explorer', keycap: '⌥↵', icon: 'peek', run: () => deps.revealFile(entry) },
        {
          label: 'Copy path',
          keycap: '⌘C',
          icon: 'copy',
          run: () => copyAndToast(deps, relPathOf(entry), `Copied "${relPathOf(entry)}"`),
        },
      ];
    case 'glossary':
      return [
        { label: 'Open glossary', keycap: '↵', icon: 'gloss', run: () => deps.openGlossary(entry) },
        { label: 'Find in model', keycap: '⇧↵', icon: 'search', run: () => deps.findInModel(entry) },
      ];
    case 'rule':
      return [
        { label: 'Go to rule', keycap: '↵', icon: 'goto', run: () => deps.gotoRule(entry) },
        { label: 'Peek', keycap: '⌥↵', icon: 'peek', run: () => deps.peek(entry) },
      ];
    case 'commit':
      return [
        { label: 'View commit', keycap: '↵', icon: 'commit', run: () => deps.viewCommit(entry) },
        {
          label: 'Copy hash',
          keycap: '⌘C',
          icon: 'copy',
          run: () => copyAndToast(deps, entry.hash ?? '', `Copied "${(entry.hash ?? '').slice(0, 7)}"`),
        },
        { label: 'Revert', keycap: '⇧⌫', icon: 'diff', run: () => deps.revertCommit(entry) },
      ];
    default:
      return [{ label: 'Open', keycap: '↵', icon: 'open', run: () => deps.openFile(entry) }];
  }
}
