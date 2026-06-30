// A throw-on-missing `document.getElementById`. Koine Studio's shell controllers look up the chrome
// elements they own by id (`#split`, `#status`, `#panel-terminal`, …); a typo or a drifted layout id is
// a programmer error, so this throws rather than returning `null` and deferring the crash. The name is
// deliberately distinct from `@/shared/el` (the tag-based element *builder*) to avoid collision — this
// is a by-id *getter*, not a constructor.
export function domById<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}
