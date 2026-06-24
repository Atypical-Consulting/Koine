// The canonical empty / informational state for a side-rail tab — the Properties inspector, the Rules
// tab and the Notes tab all render through it, so the three read identically: same heading face
// (`.koi-rview-empty-title`), same muted body, same margin. The margin comes from the panel container
// (the shared `rail-panel-pad` mixin on `.doc-view` / `.koi-inspector`), so this block only owns its
// own light inner spacing. Pure DOM builders, decoupled from the editor, so they unit-test under
// happy-dom like the rest of the model panels.

/**
 * Build a titled, left-aligned rail empty-state block: an `<h3>` heading followed by `body`.
 * Returns the `.koi-rview-empty` element so callers can mount or further append to it.
 */
export function renderRailEmpty(title: string, ...body: readonly Node[]): HTMLElement {
  const root = document.createElement('div');
  root.className = 'koi-rview-empty';

  const heading = document.createElement('h3');
  heading.className = 'koi-rview-empty-title';
  heading.textContent = title;

  root.append(heading, ...body);
  return root;
}

/** A muted paragraph — the usual body of a {@link renderRailEmpty} block. */
export function railHint(text: string): HTMLElement {
  const p = document.createElement('p');
  p.className = 'muted';
  p.textContent = text;
  return p;
}
