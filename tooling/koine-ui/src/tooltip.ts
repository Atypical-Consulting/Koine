// Instant custom tooltip — a framework-free singleton that replaces the native `title` attribute (which
// waits ~1s before showing, can't be themed, and can't carry a keyboard hint). One `.koi-tip` element is
// created on <body>; a single delegated `mouseover` listener reads `data-tip` (text) + optional `data-key`
// (a keyboard/shortcut chip) off the hovered element, so it needs NO rewiring across re-renders and works
// for both Preact chrome and imperatively-managed DOM. It shows with a ~90ms fade, auto-flips above when
// there's no room below, follows the cursor between adjacent tips with no flicker, and hides on
// click/scroll/blur so it never strands. Opt an element in with `data-tip="…"` (+ `data-key="…"`) and keep
// an `aria-label` alongside — the tooltip is a visual enhancement, not the accessible name.

export interface TooltipController {
  /** Tear down: remove the delegated listeners and the tooltip element. */
  destroy(): void;
}

let active: TooltipController | null = null;

/**
 * Install the instant-tooltip controller once (idempotent — a second call returns the live one). Call at
 * app boot. Elements opt in via `data-tip` / `data-key`.
 */
export function initInstantTooltip(doc: Document = document): TooltipController {
  if (active) return active;

  const tip = doc.createElement('div');
  tip.className = 'koi-tip';
  tip.setAttribute('role', 'tooltip');
  doc.body.appendChild(tip);

  let tipEl: Element | null = null;

  function place(el: Element): void {
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const win = doc.defaultView ?? window;
    const flip = r.bottom + 8 + tr.height > win.innerHeight - 4;
    const left = Math.max(6, Math.min(r.left + r.width / 2 - tr.width / 2, win.innerWidth - tr.width - 6));
    tip.style.left = `${left}px`;
    tip.style.top = `${flip ? r.top - tr.height - 8 : r.bottom + 8}px`;
  }

  function show(el: Element): void {
    const text = el.getAttribute('data-tip');
    if (!text) return;
    tip.textContent = text; // textContent (not innerHTML) — a data-tip can be a file path
    const key = el.getAttribute('data-key');
    if (key) {
      const kbd = doc.createElement('kbd');
      kbd.textContent = key;
      tip.appendChild(kbd);
    }
    tip.classList.add('on');
    tipEl = el;
    place(el);
  }

  function hide(): void {
    tip.classList.remove('on');
    tipEl = null;
  }

  const onOver = (e: Event): void => {
    const target = e.target as Element | null;
    const el = target && target.closest ? target.closest('[data-tip]') : null;
    if (el) {
      if (el !== tipEl) show(el);
    } else if (tipEl) {
      hide();
    }
  };

  doc.addEventListener('mouseover', onOver);
  doc.addEventListener('click', hide, true); // a click acted — don't strand a tooltip
  doc.addEventListener('scroll', hide, true);
  const win = doc.defaultView ?? window;
  win.addEventListener('blur', hide);

  active = {
    destroy() {
      doc.removeEventListener('mouseover', onOver);
      doc.removeEventListener('click', hide, true);
      doc.removeEventListener('scroll', hide, true);
      win.removeEventListener('blur', hide);
      tip.remove();
      active = null;
    },
  };
  return active;
}
