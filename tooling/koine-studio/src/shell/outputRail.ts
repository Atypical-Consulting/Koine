// The Generated-preview surface's supporting DOM pieces: the `[rail][crumb + code]` scaffold that hosts
// a per-file browser beside a single-file viewer (concept-7 "Flush"), plus the ADR-0009 scope-emphasis
// pass over that browser's top-level (bounded-context) rows. Clicking a file drives the existing
// read-only CodeMirror `OutputView` (no new editor). The file browser itself — grouping files into a
// nested folder tree, rendering, selection — is `shell/output/generatedFileTree.ts` (#871 Task 2); it
// used to be a flat, context-grouped rail rendered here (`renderOutputRail`, #871 Task 3 replaced it with
// the real tree), so this module now only builds the surrounding scaffold, paints the breadcrumb, and
// applies scope emphasis to whatever tree fills `.out-rail`.
//
// The scaffold is built imperatively INSIDE the existing `#view-preview` host (rather than in index.html)
// so it needs no markup change and degrades gracefully in the controller's DOM-fixture tests: it's
// idempotent, so `ide.tsx` (which mounts the OutputView into `.out-code`) and `inspectorController.tsx`
// (which mounts the file tree/crumb) can both call it, in either order.

export interface OutputScaffold {
  rail: HTMLElement;
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
  const rail = mk('out-rail koi-scroll', grid);
  rail.setAttribute('role', 'tablist');
  rail.setAttribute('aria-label', 'Generated files');
  const view = mk('out-view', grid);
  const crumb = mk('out-crumb', view);
  const crumbPath = mk('out-crumb-path', crumb);
  const lang = mk('out-lang', crumb);
  lang.hidden = true;
  const code = mk('out-code', view);

  return { rail, crumb, crumbPath, lang, code };
}

/**
 * Apply ADR-0009 scope emphasis to the Generated file tree's TOP-LEVEL rows (the bounded-context
 * folders/files — `[role="treeitem"][aria-level="1"]`, matched by `data-path`): the row whose path
 * matches `activeContext` is marked `.on` and every other top-level row `.dim`, so the active scope reads
 * without hiding anything (the whole-model overview stays browsable). Any previous emphasis is cleared
 * first. `activeContext` of `null` (the *All contexts* case), or a scope that matches no top-level path,
 * leaves every row neutral — a graceful no-op, the same behavior the old flat rail had.
 */
export function applyOutputTreeEmphasis(treeRoot: HTMLElement, activeContext: string | null): void {
  const topLevel = Array.from(treeRoot.querySelectorAll<HTMLElement>('[role="treeitem"][aria-level="1"]'));
  for (const el of topLevel) el.classList.remove('on', 'dim');

  const matches = activeContext !== null && topLevel.some((el) => el.dataset.path === activeContext);
  if (!matches) return;

  for (const el of topLevel) el.classList.add(el.dataset.path === activeContext ? 'on' : 'dim');
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
