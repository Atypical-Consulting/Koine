// Shared overlay infrastructure for Koine Studio.
//
// Two pieces:
//  1. A z-order stack so a single Esc closes only the TOP-MOST open overlay rather than
//     every layered one. Each overlay registers its close handler while open and unregisters
//     on close; one document-level Esc listener routes to the top of the stack. This replaces
//     the per-overlay document Esc listeners, which all fired on the same keypress (so closing
//     a modal layered over the welcome screen also dismissed the welcome screen).
//  2. createModal(): the common .koi-modal* chrome (backdrop, header with title + close, body,
//     footer) plus backdrop-click-to-close, focus capture/restore, and stack registration —
//     shared by Preferences, About, and the keyboard-shortcuts Help dialog.

import { el } from '@/shared/el';

type CloseFn = () => void;

// Open overlays, bottom-to-top. The last entry is the one Esc closes.
const stack: CloseFn[] = [];

// Elements that can hold keyboard focus, used to find a modal's first/last tab stop.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Register an open overlay as the new top of the Esc stack. Returns an unregister function
 * the overlay MUST call when it closes by any path (button, backdrop, Esc, programmatic).
 */
export function registerOverlay(close: CloseFn): () => void {
  stack.push(close);
  return () => {
    const i = stack.lastIndexOf(close);
    if (i >= 0) stack.splice(i, 1);
  };
}

// One document-level Esc handler for the whole app: close only the top-most overlay.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || stack.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  stack[stack.length - 1]();
});

export interface ModalOptions {
  /** Heading shown in the modal header and used as the default aria-label. */
  title: string;
  ariaLabel?: string;
  /** Extra class added to the .koi-modal element (e.g. a width/layout variant). */
  variant?: string;
}

export interface ModalHandle {
  /** The backdrop element (already mounted on document.body, hidden until open). */
  readonly backdrop: HTMLElement;
  /** The .koi-modal-body element to populate with content. */
  readonly body: HTMLElement;
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  /** Register a callback run every time the modal opens (e.g. to (re)populate or fetch). */
  onOpen(cb: () => void): void;
  /** Register a callback run every time the modal closes by ANY path (button, backdrop, Esc). */
  onClose(cb: () => void): void;
}

/**
 * Build the shared modal chrome once, mount it (hidden) on document.body, and return an
 * imperative handle. Esc is handled centrally via the overlay stack; backdrop click and the
 * header close button also close. Focus is captured on open and restored on close.
 */
export function createModal(opts: ModalOptions): ModalHandle {
  const closeBtn = el('button', {
    class: 'koi-modal-close',
    text: '✕',
    attrs: { type: 'button', 'aria-label': 'Close' },
  });
  const body = el('div', { class: 'koi-modal-body' });
  const modal = el(
    'div',
    {
      class: 'koi-modal',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': opts.ariaLabel ?? opts.title },
    },
    [
      el('div', { class: 'koi-modal-header' }, [
        el('h2', { class: 'koi-modal-title', text: opts.title }),
        closeBtn,
      ]),
      body,
      el('div', { class: 'koi-modal-footer' }),
    ],
  );
  if (opts.variant) modal.classList.add(opts.variant);

  const backdrop = el('div', { class: 'koi-modal-backdrop' }, modal);
  backdrop.hidden = true;
  document.body.appendChild(backdrop);

  let isOpen = false;
  let opener: HTMLElement | null = null;
  let unregister: (() => void) | null = null;
  const openCbs: Array<() => void> = [];
  const closeCbs: Array<() => void> = [];

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    opener = document.activeElement as HTMLElement | null; // restore focus here on close
    backdrop.hidden = false;
    unregister = registerOverlay(close);
    closeBtn.focus();
    for (const cb of openCbs) cb(); // a callback may move focus (e.g. to the first field)
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    backdrop.hidden = true;
    unregister?.();
    unregister = null;
    opener?.focus?.();
    opener = null;
    for (const cb of closeCbs) cb();
  }

  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close(); // click outside the panel closes
  });

  // Tab focus trap: keep Tab/Shift+Tab cycling within the modal so focus never reaches the
  // toolbar/editor behind the backdrop, honouring the aria-modal contract (WCAG 2.4.3).
  modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    // Only ACTUALLY-rendered controls are valid tab stops: a control inside a display:none panel
    // (a collapsed Settings category, a hidden field row) has no client rects, so excluding it
    // keeps the computed first/last stops on visible elements — otherwise the wrap targets an
    // unfocusable element and focus escapes the modal.
    const focusable = Array.from(
      modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((el) => !el.hasAttribute('hidden') && el.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  });

  return {
    backdrop,
    body,
    open,
    close,
    toggle,
    get isOpen() {
      return isOpen;
    },
    onOpen(cb) {
      openCbs.push(cb);
    },
    onClose(cb) {
      closeCbs.push(cb);
    },
  };
}

export interface ConfirmRequest {
  /** Heading shown in the modal header. */
  title: string;
  /** Body copy explaining the consequence and, ideally, the safe alternative. */
  message: string;
  /** Label for the affirmative (proceed) button. */
  confirmLabel: string;
  /** Label for the dismiss button. Defaults to 'Cancel'. */
  cancelLabel?: string;
  /** Style the affirmative button as destructive (red). Defaults to false. */
  danger?: boolean;
}

export interface ConfirmDialog {
  /** Resolve true if the user confirms, false on cancel / Esc / backdrop / ✕. */
  ask(req: ConfirmRequest): Promise<boolean>;
}

/**
 * A reusable yes/no confirmation built once on top of createModal(), so it inherits the app's
 * Esc-stack, focus trap, theming, and focus restore. Unlike a delete prompt, the dismiss button
 * is focused by default — a reflexive Enter must never trigger a destructive proceed.
 */
export function createConfirmDialog(): ConfirmDialog {
  const modal = createModal({ title: 'Confirm', ariaLabel: 'Confirm' });
  const titleEl = modal.backdrop.querySelector<HTMLElement>('.koi-modal-title');
  const msgEl = document.createElement('p');
  msgEl.className = 'koi-confirm-msg';
  modal.body.appendChild(msgEl);

  const footer = modal.backdrop.querySelector<HTMLElement>('.koi-modal-footer')!;
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'koi-confirm-btn';
  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  footer.append(cancelBtn, okBtn);

  let resolve: ((ok: boolean) => void) | null = null;
  const settle = (ok: boolean): void => {
    const r = resolve;
    resolve = null;
    r?.(ok);
  };

  cancelBtn.addEventListener('click', () => {
    settle(false);
    modal.close();
  });
  okBtn.addEventListener('click', () => {
    settle(true);
    modal.close();
  });
  // Esc / backdrop / ✕ all route through close → resolve false (if still pending).
  modal.onClose(() => settle(false));

  return {
    ask(req) {
      settle(false); // defensively settle any stale promise before reusing the dialog
      if (titleEl) titleEl.textContent = req.title;
      msgEl.textContent = req.message;
      cancelBtn.textContent = req.cancelLabel ?? 'Cancel';
      okBtn.textContent = req.confirmLabel;
      okBtn.className = req.danger ? 'koi-confirm-btn koi-confirm-btn-danger' : 'koi-confirm-btn';
      return new Promise<boolean>((res) => {
        resolve = res;
        modal.open();
        cancelBtn.focus(); // safe default: createModal focuses ✕; we prefer Cancel here
      });
    },
  };
}
