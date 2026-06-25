// The mobile inspector bottom sheet (issue #221, Task 2): the single Properties surface shown below
// $bp-narrow, replacing the fixed #right rail on a phone. It is a three-detent (peek / half / full)
// draggable sheet — peek rests at the grab handle, half opens it modal over the active zone, full takes
// (nearly) the whole viewport and traps keyboard focus. The controller mounts the existing
// PropertiesPanel into `contentNode()` (so the inspector renderer is reused untouched) and raises the
// sheet on a selection via the module-level `openInspectorSheet`.
//
// Built imperatively (like overlay.ts's modal chrome) rather than as a Preact component: it owns no
// model state, just DOM + gesture wiring, and the Preact panel lives INSIDE its body. The file is .tsx
// only to sit beside its siblings — it renders no JSX itself.

export type SheetDetent = 'peek' | 'half' | 'full';

export interface InspectorSheet {
  /** Move the sheet to a detent (peek rests it; half/full open it modal). */
  setDetent(d: SheetDetent): void;
  /** The body element the inspector mounts into (stable across detents). */
  contentNode(): HTMLElement;
  /** True while the sheet is raised (half or full) — i.e. modal. */
  isOpen(): boolean;
  /** Remove the sheet + its listeners (clears the module-level active handle if it was this one). */
  destroy(): void;
}

// peek < half < full — the order a drag steps through.
const DETENT_ORDER: SheetDetent[] = ['peek', 'half', 'full'];
// Vertical drag distance (px) past which a release commits to the next/previous detent rather than
// snapping back. A small threshold keeps a deliberate flick responsive without firing on a tap.
const SWIPE_THRESHOLD = 40;
// The focusable descendants the full-detent focus trap cycles through.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// The most-recently-created sheet, so the controller (and Task 3's accessory affordances) can raise it
// without holding the instance. There is one inspector sheet per page in production; tests build several
// and destroy() clears this when the active one is torn down.
let activeSheet: InspectorSheet | null = null;

/**
 * Raise the active inspector sheet to a detent (default `half`). A no-op when no sheet exists — e.g. on
 * desktop, where the controller never builds one. This is the stable seam the controller calls on a
 * selection and Task 3's "Properties" affordance imports.
 */
export function openInspectorSheet(detent: SheetDetent = 'half'): void {
  activeSheet?.setDetent(detent);
}

function isModal(d: SheetDetent): boolean {
  return d === 'half' || d === 'full';
}

export function createInspectorSheet(host: HTMLElement): InspectorSheet {
  let detent: SheetDetent = 'peek';
  // The element that held focus before the sheet went modal, restored when it returns to peek (so an
  // Esc/dismiss hands focus back to the editor it came from).
  let focusOrigin: HTMLElement | null = null;

  // Backdrop: dims the page while modal and dismisses on tap. Hidden at peek.
  const backdrop = document.createElement('div');
  backdrop.className = 'koi-sheet-backdrop';
  backdrop.hidden = true;
  backdrop.addEventListener('click', () => setDetent('peek'));

  // The dialog itself, named for AT via aria-label (it carries the Properties inspector).
  const sheet = document.createElement('div');
  sheet.className = 'koi-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Properties');
  sheet.dataset.detent = 'peek';

  // The grab handle: a real button so it's keyboard-reachable and announces. A tap/Enter raises one
  // detent; a vertical drag steps detents by distance (see the pointer handlers below).
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'koi-sheet-handle';
  handle.setAttribute('aria-label', 'Resize the Properties sheet');
  const grip = document.createElement('span');
  grip.className = 'koi-sheet-grip';
  grip.setAttribute('aria-hidden', 'true');
  handle.appendChild(grip);

  // The inspector's mount point — kept stable so the controller can render into it across detents.
  const body = document.createElement('div');
  body.className = 'koi-sheet-body';

  sheet.append(handle, body);
  host.append(backdrop, sheet);

  // --- drag-to-resize -------------------------------------------------------
  let dragStartY: number | null = null;
  let dragStartDetent: SheetDetent = 'peek';
  function onPointerDown(e: PointerEvent): void {
    dragStartY = e.clientY;
    dragStartDetent = detent;
    handle.setPointerCapture?.(e.pointerId);
  }
  function onPointerUp(e: PointerEvent): void {
    if (dragStartY == null) return;
    const dy = e.clientY - dragStartY;
    dragStartY = null;
    handle.releasePointerCapture?.(e.pointerId);
    if (dy > SWIPE_THRESHOLD) stepFrom(dragStartDetent, -1); // dragged down → lower
    else if (dy < -SWIPE_THRESHOLD) stepFrom(dragStartDetent, +1); // dragged up → raise
    // else: a tap or a sub-threshold nudge — leave the detent where it is.
  }
  // A plain tap/click (or Enter/Space on the focused handle) raises one detent — the keyboard + no-drag
  // path. Skipped right after a committing drag so a flick doesn't also fire the click that follows.
  function onHandleClick(): void {
    raiseOne();
  }
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointerup', onPointerUp);
  handle.addEventListener('click', onHandleClick);

  function stepFrom(from: SheetDetent, dir: number): void {
    const i = DETENT_ORDER.indexOf(from);
    setDetent(DETENT_ORDER[Math.min(DETENT_ORDER.length - 1, Math.max(0, i + dir))]);
  }
  function raiseOne(): void {
    stepFrom(detent, +1);
  }

  // --- focus trap (full) ----------------------------------------------------
  function focusables(): HTMLElement[] {
    return Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setDetent('peek');
      return;
    }
    if (e.key !== 'Tab' || detent !== 'full') return;
    const items = focusables();
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && (active === first || !sheet.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !sheet.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }
  sheet.addEventListener('keydown', onKeyDown);

  function setDetent(next: SheetDetent): void {
    const prev = detent;
    if (next === prev) return;
    // Entering modal from rest: remember where focus came from so a dismiss can hand it back.
    if (!isModal(prev) && isModal(next)) {
      focusOrigin = (document.activeElement as HTMLElement | null) ?? null;
    }
    detent = next;
    sheet.dataset.detent = next;
    backdrop.hidden = !isModal(next);
    if (isModal(next)) sheet.setAttribute('aria-modal', 'true');
    else sheet.removeAttribute('aria-modal');

    if (next === 'full') {
      // Full takes keyboard focus: blur whatever held it (the editor) and pull focus into the sheet so
      // the trap has somewhere to land and the editor can't receive keystrokes behind the sheet.
      (document.activeElement as HTMLElement | null)?.blur?.();
      (focusables()[0] ?? handle).focus();
    } else if (next === 'peek' && isModal(prev)) {
      // Dismissed back to rest: return focus to its origin (best-effort).
      focusOrigin?.focus?.();
      focusOrigin = null;
    }
  }

  const api: InspectorSheet = {
    setDetent,
    contentNode: () => body,
    isOpen: () => isModal(detent),
    destroy: () => {
      sheet.removeEventListener('keydown', onKeyDown);
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('click', onHandleClick);
      backdrop.remove();
      sheet.remove();
      if (activeSheet === api) activeSheet = null;
    },
  };
  activeSheet = api;
  return api;
}
