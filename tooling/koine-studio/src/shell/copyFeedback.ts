// The shared "copy text to the clipboard, flash the button label to reflect success/failure, then
// reset it after a delay" idiom (#1362) — previously reinvented three times: mcp.ts's mcpCopyBtn and
// mcpRecipeCopy click handlers, and surfaceLoaders.tsx's own makeCopyButton (backing the Generated
// panel's Copy file / Copy all buttons, #871). PURE REFACTOR: this module reproduces that exact
// sequence — `navigator.clipboard.writeText(text)` → 'Copied ✓' on resolve / 'Copy failed' on reject →
// back to the idle label 1600ms later, with a second click before the reset clearing + restarting the
// timer — verbatim, just relocated to one shared home both `settings/` and `shell/` can import (the
// codebase already has precedent for `settings/` importing from `shell/`, e.g. `{ readRaw, writeRaw }`
// from `@/shell/storage`).
//
// The button's OWN `disabled` state gates a click — NOT a falsy-string check on `getText()` (ported
// from surfaceLoaders.tsx's prior local makeCopyButton, a deliberate code-review fix: the Python
// emitter always emits an empty `py.typed` file, so an empty `writeText('')` must still proceed).

/** Attach the click listener implementing the clipboard-write + flash + timed-reset sequence to an
 *  EXISTING button. `getText()` is read fresh at click time (so a caller's live state — the selected
 *  output file, the current recipe snippet — is always what gets copied). Returns a `cancelReset`
 *  disposer that clears any pending reset timer, for a caller's own teardown (`dispose()`/`destroy()`). */
export function wireCopyButton(btn: HTMLButtonElement, idleLabel: string, getText: () => string): () => void {
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelReset = (): void => clearTimeout(resetTimer);
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    // `navigator.clipboard` is undefined in a non-secure context (plain http, some webviews), where
    // `navigator.clipboard.writeText` would throw a SYNCHRONOUS TypeError that `.catch()` (rejected
    // promises only) can't see. Optional-chain + a rejected fallback routes that case through the same
    // 'Copy failed' flash instead of an uncaught throw.
    void Promise.resolve(navigator.clipboard?.writeText(getText()) ?? Promise.reject(new Error('no clipboard')))
      .then(() => (btn.textContent = 'Copied ✓'))
      .catch(() => (btn.textContent = 'Copy failed'))
      .finally(() => {
        cancelReset();
        resetTimer = setTimeout(() => (btn.textContent = idleLabel), 1600);
      });
  });
  return cancelReset;
}

/** Build a fresh `<button>` (class, idle label, `data-tip`, starts `disabled`) and wire it via
 *  `wireCopyButton` — the "also create the button" case `wireCopyButton` alone doesn't cover, for a
 *  caller that owns no pre-existing button (surfaceLoaders.tsx's Copy file / Copy all). */
export function makeCopyButton(
  cls: string,
  idleLabel: string,
  tip: string,
  getText: () => string,
): { el: HTMLButtonElement; cancelReset: () => void } {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = idleLabel;
  btn.dataset.tip = tip;
  btn.disabled = true;
  const cancelReset = wireCopyButton(btn, idleLabel, getText);
  return { el: btn, cancelReset };
}
