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

import { registerOverlay, visibleFocusables } from '@/shared/overlay';

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
  // The overlay-stack unregister fn while the sheet is modal (registered on going modal, called on
  // dismiss/destroy). Esc routes through the shared stack so it closes only the top-most overlay.
  let unregisterOverlay: (() => void) | null = null;

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
  // A committing pointer drag is followed by a synthetic `click` (the browser's pointer→click sequence).
  // Set on a threshold-crossing release so onHandleClick swallows that trailing click — otherwise the
  // click ALSO steps a detent: a swipe-up double-steps (peek→half→full), and a swipe-down-to-dismiss is
  // immediately re-raised so drag-to-dismiss never works.
  let suppressNextClick = false;
  function onPointerDown(e: PointerEvent): void {
    suppressNextClick = false; // a fresh gesture clears any uncomsumed suppression
    dragStartY = e.clientY;
    dragStartDetent = detent;
    handle.setPointerCapture?.(e.pointerId);
  }
  function onPointerUp(e: PointerEvent): void {
    if (dragStartY == null) return;
    const dy = e.clientY - dragStartY;
    dragStartY = null;
    handle.releasePointerCapture?.(e.pointerId);
    const swiped = dy > SWIPE_THRESHOLD || dy < -SWIPE_THRESHOLD;
    if (dy > SWIPE_THRESHOLD) stepFrom(dragStartDetent, -1); // dragged down → lower
    else if (dy < -SWIPE_THRESHOLD) stepFrom(dragStartDetent, +1); // dragged up → raise
    // else: a tap or a sub-threshold nudge — leave the detent where it is.
    // Swallow the synthetic click that trails a threshold-crossing drag so it doesn't step again.
    if (swiped) suppressNextClick = true;
  }
  // A plain tap/click (or Enter/Space on the focused handle) raises one detent — the keyboard + no-drag
  // path. Skipped right after a committing drag so a flick doesn't also fire the click that follows.
  function onHandleClick(): void {
    if (suppressNextClick) {
      suppressNextClick = false; // consumed: this click trailed a committing drag
      return;
    }
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

  // --- focus trap (any modal detent: half AND full) -------------------------
  // The sheet shows a page-covering backdrop and sets aria-modal at BOTH half and full, and half is the
  // COMMON path (a node tap / selection raises to half), so the modal behaviours — focus-in, Tab trap,
  // Esc-to-dismiss, focus restore — must apply to ANY modal detent, not just full. The trap reuses
  // overlay.ts's shared FOCUSABLE_SELECTOR + visible-focusable filter (no drifted local copy) so a hidden
  // control can never become the wrap target. Esc is handled centrally via the overlay stack (registered
  // in setDetent), not a sheet-scoped listener, so a single Esc closes only the top-most overlay.
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !isModal(detent)) return;
    const items = visibleFocusables(sheet);
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

  // Toggle the body in/out of the tab + AT order. At peek the full Properties form stays mounted but the
  // sheet is clipped to the grab-handle strip, so its controls must NOT be reachable while collapsed
  // (#221): `inert` blocks focus/pointer and aria-hidden removes it from AT. Cleared at half/full.
  function setBodyInteractive(on: boolean): void {
    if (on) {
      body.removeAttribute('inert');
      body.removeAttribute('aria-hidden');
    } else {
      body.setAttribute('inert', '');
      body.setAttribute('aria-hidden', 'true');
    }
  }
  setBodyInteractive(isModal(detent)); // initialise for the starting (peek) detent

  function setDetent(next: SheetDetent): void {
    const prev = detent;
    if (next === prev) return;
    const wasModal = isModal(prev);
    const nowModal = isModal(next);
    // Entering modal from rest: remember where focus came from so a dismiss can hand it back.
    if (!wasModal && nowModal) {
      focusOrigin = (document.activeElement as HTMLElement | null) ?? null;
    }
    detent = next;
    sheet.dataset.detent = next;
    backdrop.hidden = !nowModal;
    setBodyInteractive(nowModal);
    if (nowModal) sheet.setAttribute('aria-modal', 'true');
    else sheet.removeAttribute('aria-modal');

    if (!wasModal && nowModal) {
      // Going modal (peek → half/full): join the app's single Esc stack and pull focus into the dialog so
      // the trap has somewhere to land and the editor behind the backdrop can't receive keystrokes.
      unregisterOverlay = registerOverlay(() => setDetent('peek'));
      (document.activeElement as HTMLElement | null)?.blur?.();
      (visibleFocusables(sheet)[0] ?? handle).focus();
    } else if (wasModal && !nowModal) {
      // Dismissed back to rest: leave the Esc stack and return focus to its origin (best-effort).
      unregisterOverlay?.();
      unregisterOverlay = null;
      focusOrigin?.focus?.();
      focusOrigin = null;
    }
    // half ↔ full stays modal: the overlay registration + focus are already in place — nothing to do.
  }

  const api: InspectorSheet = {
    setDetent,
    contentNode: () => body,
    isOpen: () => isModal(detent),
    destroy: () => {
      unregisterOverlay?.(); // leave the Esc stack if torn down while modal (no stale close lingers)
      unregisterOverlay = null;
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
