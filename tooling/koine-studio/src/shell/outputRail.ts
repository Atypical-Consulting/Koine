// The Generated-preview surface's supporting DOM pieces: the `[rail][crumb + code]` scaffold that hosts
// a per-file browser beside a single-file viewer (concept-7 "Flush"). Clicking a file drives the existing
// read-only CodeMirror `OutputView` (no new editor). The file browser itself — grouping files into a
// nested folder tree, rendering, selection, and the ADR-0009 scope-emphasis pass over its top-level
// (bounded-context) rows (`emphasizeTopLevel`, #1363; formerly this module's `applyOutputTreeEmphasis`)
// — is `shell/output/generatedFileTree.ts` (#871 Task 2); it used to be a flat, context-grouped rail
// rendered here (`renderOutputRail`, #871 Task 3 replaced it with the real tree), so this module now only
// builds the surrounding scaffold and paints the breadcrumb.
//
// The scaffold is built imperatively INSIDE the existing `#view-preview` host (rather than in index.html)
// so it needs no markup change and degrades gracefully in the controller's DOM-fixture tests: it's
// idempotent, so `ide.tsx` (which mounts the OutputView into `.out-code`) and `inspectorController.tsx`
// (which mounts the file tree/crumb) can both call it, in either order.

export interface OutputScaffold {
  rail: HTMLElement;
  /** The small "N files" count header living above the tree inside `.out-rail` (the issue's UI-spec
   *  requirement Task 3 dropped along with the old flat rail's `renderOutputRail` — restored here via
   *  `renderOutputRailHead`, not by the flat rail's own per-file rendering). */
  railHead: HTMLElement;
  crumbPath: HTMLElement;
  lang: HTMLElement;
  /** The single-file viewer mount (the CodeMirror OutputView lives here). */
  code: HTMLElement;
  /** The crumb bar itself — the controller appends its persistent Copy button here. */
  crumb: HTMLElement;
}

/** Build (once) the `[rail][crumb + code]` grid inside `previewEl`, or return the existing parts. */
export function ensureOutputScaffold(previewEl: HTMLElement): OutputScaffold {
  const existing = previewEl.querySelector<HTMLElement>('.out2');
  if (existing) {
    return {
      rail: existing.querySelector<HTMLElement>('.out-rail')!,
      railHead: existing.querySelector<HTMLElement>('.out-railhead')!,
      crumb: existing.querySelector<HTMLElement>('.out-crumb')!,
      crumbPath: existing.querySelector<HTMLElement>('.out-crumb-path')!,
      lang: existing.querySelector<HTMLElement>('.out-lang')!,
      code: existing.querySelector<HTMLElement>('.out-code')!,
    };
  }

  const mk = (cls: string, parent?: HTMLElement): HTMLElement => {
    const el = document.createElement('div');
    el.className = cls;
    parent?.appendChild(el);
    return el;
  };

  const grid = mk('out2', previewEl);
  // `.out-rail` is a plain scroll container: the tree mounted into it (generatedFileTree.ts) carries its
  // OWN `role="tree"`/`aria-label` on its `<ul>`, so this element must not ALSO claim a widget role — it
  // used to be `role="tablist"` back when it held flat `role="tab"` buttons directly; that's now an
  // invalid tablist-containing-a-tree nesting and has been removed. Code-review fix: that removal left the
  // rail with NO accessible role/name at all whenever the tree itself has none — `generatedFileTree.ts`'s
  // `setFiles([])` (hit on every error/empty/loading state) strips role/aria-label from its own `<ul>` with
  // no fallback. `role="region"` + a static `aria-label` here restores an always-present accessible name
  // without reintroducing the old tablist-containing-a-tree problem — a region containing a tree (once
  // files exist) is valid ARIA nesting.
  const rail = mk('out-rail koi-scroll', grid);
  rail.setAttribute('role', 'region');
  rail.setAttribute('aria-label', 'Generated files');
  const railHead = mk('out-railhead', rail);
  const view = mk('out-view', grid);
  const crumb = mk('out-crumb', view);
  const crumbPath = mk('out-crumb-path', crumb);
  const lang = mk('out-lang', crumb);
  lang.hidden = true;
  const code = mk('out-code', view);

  return { rail, railHead, crumb, crumbPath, lang, code };
}

/** Paint (or clear) the small file-count header above the tree — the issue's "a small count ('12 files')
 *  sits in the header" requirement, dropped when Task 3 replaced the flat rail with the tree and not
 *  replaced since (a real gap, not an intentional drop). `count === 0` clears it (the empty/error states). */
export function renderOutputRailHead(scaffold: OutputScaffold, count: number): void {
  scaffold.railHead.textContent = '';
  if (count === 0) return;
  const b = document.createElement('b');
  b.textContent = `${count} file${count === 1 ? '' : 's'}`;
  scaffold.railHead.appendChild(b);
}

/** Update the breadcrumb (path segments + a language chip). Pass `null` to clear it (error/empty states). */
export function renderOutputCrumb(scaffold: OutputScaffold, path: string | null, langLabel: string): void {
  const { crumbPath, lang } = scaffold;
  crumbPath.textContent = '';
  if (!path) {
    lang.hidden = true;
    return;
  }
  const parts = path.split('/');
  parts.forEach((p, i) => {
    if (i > 0) {
      const sl = document.createElement('span');
      sl.className = 'sl';
      sl.textContent = '/';
      crumbPath.appendChild(sl);
    }
    const seg = document.createElement('span');
    seg.className = 'seg' + (i === parts.length - 1 ? ' leaf' : '');
    seg.textContent = p;
    crumbPath.appendChild(seg);
  });
  lang.textContent = langLabel;
  lang.hidden = false;
}
