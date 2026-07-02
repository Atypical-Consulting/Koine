// A throw-on-missing `document.getElementById`. Koine Studio's shell controllers look up the chrome
// elements they own by id (`#split`, `#status`, `#panel-terminal`, …); a typo or a drifted layout id is
// a programmer error, so this throws rather than returning `null` and deferring the crash. The name is
// deliberately distinct from `@atypical/koine-ui`'s `el` (the tag-based element *builder*) to avoid collision — this
// is a by-id *getter*, not a constructor.
export function domById<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id); // eslint-disable-line no-restricted-properties -- this IS the sanctioned throw-on-missing wrapper the rule steers callers to
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

// The throw-on-empty sibling of `domById` for a `document.querySelectorAll` — for the fixed chrome
// selectors a controller owns (the rail axis buttons, the right-strip tool buttons). Returns the matches
// as an array; an empty match is a drifted layout / render-order bug, so it throws rather than returning an
// empty NodeList that silently no-ops every downstream loop.
export function domQueryAll<T extends Element = HTMLElement>(selector: string): T[] {
  const nodes = document.querySelectorAll<T>(selector);
  if (nodes.length === 0) throw new Error(`missing ${selector}`);
  return Array.from(nodes);
}
