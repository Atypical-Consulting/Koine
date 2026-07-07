// Output file-rail (concept-7 "Flush") — turns the Generated-preview surface from one concatenated blob
// into a per-file rail beside a single-file viewer. The rail groups the emit result by bounded context
// (the file's top-level folder), tints each file's dot by its DDD stereotype `kind`, and shows a line
// count; clicking a file drives the existing read-only CodeMirror `OutputView` (no new editor).
//
// The scaffold is built imperatively INSIDE the existing `#view-preview` host (rather than in index.html)
// so it needs no markup change and degrades gracefully in the controller's DOM-fixture tests: it's
// idempotent, so `ide.tsx` (which mounts the OutputView into `.out-code`) and `inspectorController.tsx`
// (which renders the rail/crumb) can both call it, in either order.

/** One emitted file as the rail needs it — a subset of the LSP `EmitFile` (path + optional DDD kind). */
export interface OutputRailFile {
  path: string;
  /** The DDD stereotype slug (matches a `--koi-ddd-*` token), or null for infra/runtime files. */
  kind?: string | null;
  /** Line count, shown on the rail row. */
  loc: number;
}

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

/** The bounded context a file belongs to = its top-level folder (or "(root)" when it has none). */
function contextOf(path: string): string {
  const slash = path.indexOf('/');
  return slash > 0 ? path.slice(0, slash) : '(root)';
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Render the file rail: a `N files · LANG` head, then files grouped by context (first-seen order), each a
 * button tinted by `kind`. The selected file's row is marked `.on`. Clicking a row calls `onSelect(path)`.
 */
export function renderOutputRail(
  scaffold: OutputScaffold,
  files: OutputRailFile[],
  selectedPath: string | null,
  langLabel: string,
  onSelect: (path: string) => void,
): void {
  const rail = scaffold.rail;
  rail.textContent = '';

  const head = document.createElement('div');
  head.className = 'out-railhead';
  const count = document.createElement('b');
  count.textContent = `${files.length} file${files.length === 1 ? '' : 's'}`;
  head.append(count, document.createTextNode(` · ${langLabel}`));
  rail.appendChild(head);

  // Group by context, preserving the order files first appear.
  const groups: string[] = [];
  const byGroup = new Map<string, OutputRailFile[]>();
  for (const f of files) {
    const ctx = contextOf(f.path);
    if (!byGroup.has(ctx)) {
      byGroup.set(ctx, []);
      groups.push(ctx);
    }
    byGroup.get(ctx)!.push(f);
  }

  for (const ctx of groups) {
    const head = document.createElement('div');
    head.className = 'out-ctx';
    head.textContent = ctx;
    rail.appendChild(head);

    for (const f of byGroup.get(ctx)!) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'out-file' + (f.path === selectedPath ? ' on' : '');
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', f.path === selectedPath ? 'true' : 'false');
      btn.dataset.tip = f.path; // the full path — the row shows only the basename
      btn.dataset.key = `${f.loc} line${f.loc === 1 ? '' : 's'}`;
      btn.style.setProperty('--fc', `var(--koi-ddd-${f.kind ?? 'x'}, var(--koi-muted))`);

      const dot = document.createElement('span');
      dot.className = 'fdot';
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = basename(f.path);
      const loc = document.createElement('span');
      loc.className = 'floc';
      loc.textContent = String(f.loc);
      btn.append(dot, name, loc);
      btn.addEventListener('click', () => onSelect(f.path));
      rail.appendChild(btn);
    }
  }
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
