// A typed, minimal DOM builder. Koine Studio's panels are hand-built imperative DOM (the explorer's
// role=tree, the settings rows, the modal chrome, …), and the `createElement` + `className =` +
// `setAttribute` + `addEventListener` quartet was repeated hundreds of times. `el()` collapses that
// into one expression while staying framework-free. Scope is HTML elements only — SVG needs
// createElementNS and is out of scope here.

export type ElChild = Node | string | null | undefined | false;

export interface ElOptions {
  /** Sets className. */
  class?: string;
  /** Sets textContent — a shortcut for a single text child. Applied BEFORE `children`. */
  text?: string;
  /** Sets innerHTML. Only for already-trusted/escaped markup (e.g. renderMarkdown output). */
  html?: string;
  /**
   * Attributes applied via setAttribute: data-*, aria-*, role, type, tabindex, etc. A `null`,
   * `undefined`, or `false` value omits the attribute; `true` sets it empty (a boolean attribute).
   */
  attrs?: Record<string, string | number | boolean | null | undefined>;
  /** Event listeners keyed by event name, e.g. `{ click: () => … }`. */
  on?: { [K in keyof HTMLElementEventMap]?: (ev: HTMLElementEventMap[K]) => void };
}

/**
 * Create an HTML element: `el(tag, options?, children?)`. Children may be a single value or an array;
 * strings become text nodes and `null`/`undefined`/`false` entries are skipped (so `cond && el(…)`
 * works). Returns the precisely-typed element for the tag.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElOptions = {},
  children?: ElChild | ElChild[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class !== undefined) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  if (options.attrs) {
    for (const [name, value] of Object.entries(options.attrs)) {
      if (value == null || value === false) continue;
      node.setAttribute(name, value === true ? '' : String(value));
    }
  }
  if (options.on) {
    for (const [type, handler] of Object.entries(options.on)) {
      node.addEventListener(type, handler as EventListener);
    }
  }
  if (children !== undefined) {
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child == null || child === false) continue;
      node.append(child); // Element.append accepts strings (→ text node) and Nodes alike
    }
  }
  return node;
}
