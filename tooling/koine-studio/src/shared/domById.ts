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
