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

export interface PromptRequest {
  /** Heading shown in the modal header. */
  title: string;
  /** Optional helper copy under the heading (muted) — context for what the value is for. */
  message?: string;
  /** Label for the input. Defaults to 'Name'. */
  label?: string;
  /** Pre-filled value; selected on open so it can be typed over (mirrors window.prompt). */
  initialValue?: string;
  placeholder?: string;
  /** Label for the affirmative button. Defaults to 'OK'. */
  confirmLabel?: string;
  /** Label for the dismiss button. Defaults to 'Cancel'. */
  cancelLabel?: string;
  /** Render the input in the monospace face — for identifiers (type/field/member names). */
  mono?: boolean;
  /** Seed an inline error under the field (e.g. a prior attempt's "already exists"). */
  error?: string;
  /** Live validation: return an error string to block submit, or null when the value is valid. */
  validate?: (value: string) => string | null;
}

export interface PromptDialog {
  /** Resolve the trimmed value on confirm, or null on cancel / Esc / backdrop / ✕ / empty. */
  ask(req: PromptRequest): Promise<string | null>;
}

// Unique-id seed so a dialog's input/label/error wire up via for/aria-describedby even if more
// than one prompt dialog is ever constructed.
let promptSeq = 0;

/**
 * A reusable single-field text prompt built on createModal() — Koine's replacement for window.prompt.
 * The field is the editor in miniature (mono face for identifiers) and validation surfaces INLINE,
 * compiler-style, rather than stacking a second browser alert. Enter submits when valid; the OK
 * button is disabled while the value is empty or fails validation.
 */
export function createPromptDialog(): PromptDialog {
  const modal = createModal({ title: 'Prompt', ariaLabel: 'Prompt' });
  const titleEl = modal.backdrop.querySelector<HTMLElement>('.koi-modal-title');
  const uid = `koi-prompt-${(promptSeq += 1)}`;

  const msgEl = el('p', { class: 'koi-prompt-msg', attrs: { id: `${uid}-msg` } });
  const labelEl = el('label', { class: 'koi-prompt-label', attrs: { for: `${uid}-input` } });
  const input = el('input', {
    class: 'koi-prompt-input',
    // spellcheck must be the string 'false' — el() omits any attribute whose value is the boolean false.
    attrs: { id: `${uid}-input`, type: 'text', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${uid}-msg ${uid}-error` },
  });
  const errorEl = el('p', {
    class: 'koi-prompt-error',
    attrs: { id: `${uid}-error`, role: 'alert', 'aria-live': 'polite' },
  });
  modal.body.appendChild(el('div', { class: 'koi-prompt' }, [msgEl, labelEl, input, errorEl]));

  const footer = modal.backdrop.querySelector<HTMLElement>('.koi-modal-footer')!;
  const cancelBtn = el('button', { class: 'koi-confirm-btn', attrs: { type: 'button' } });
  const okBtn = el('button', { class: 'koi-confirm-btn koi-confirm-btn-primary', attrs: { type: 'button' } });
  footer.append(cancelBtn, okBtn);

  let resolve: ((value: string | null) => void) | null = null;
  let validate: PromptRequest['validate'];
  const settle = (value: string | null): void => {
    const r = resolve;
    resolve = null;
    r?.(value);
  };

  // Show (or clear) the inline error and mirror it onto the input's invalid state for the ring + aria.
  function showError(text: string): void {
    errorEl.textContent = text;
    input.classList.toggle('is-invalid', text !== '');
    input.setAttribute('aria-invalid', text !== '' ? 'true' : 'false');
  }

  // The OK button is disabled while there's nothing usable to submit: empty, or a live-validation error.
  function refresh(): void {
    const value = input.value.trim();
    const liveError = value !== '' && validate ? validate(value) : '';
    okBtn.disabled = value === '' || liveError != null && liveError !== '';
    if (liveError) showError(liveError);
  }

  function submit(): void {
    const value = input.value.trim();
    if (value === '') return; // nothing to commit; OK is disabled anyway
    const err = validate?.(value);
    if (err) {
      showError(err);
      input.focus();
      return; // keep the dialog open so the user can fix it in place
    }
    settle(value);
    modal.close();
  }

  cancelBtn.addEventListener('click', () => {
    settle(null);
    modal.close();
  });
  okBtn.addEventListener('click', submit);
  input.addEventListener('input', () => {
    showError(''); // typing clears a stale/seeded error...
    refresh(); // ...then re-derive disabled + any live error from the new value
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!okBtn.disabled) submit();
  });
  // Esc / backdrop / ✕ all route through close → resolve null (if still pending).
  modal.onClose(() => settle(null));

  return {
    ask(req) {
      settle(null); // defensively settle any stale promise before reusing the dialog
      if (titleEl) titleEl.textContent = req.title;
      validate = req.validate;
      msgEl.textContent = req.message ?? '';
      msgEl.hidden = !req.message;
      labelEl.textContent = req.label ?? 'Name';
      input.value = req.initialValue ?? '';
      input.placeholder = req.placeholder ?? '';
      input.classList.toggle('is-mono', req.mono === true);
      cancelBtn.textContent = req.cancelLabel ?? 'Cancel';
      okBtn.textContent = req.confirmLabel ?? 'OK';
      showError(req.error ?? '');
      refresh();
      return new Promise<string | null>((res) => {
        resolve = res;
        modal.open();
        input.focus(); // createModal focuses ✕; for a prompt we want the field, with its text selected
        input.select();
      });
    },
  };
}

// --- shared lazy singletons --------------------------------------------------
// One confirm + one prompt dialog for the whole app, so callers don't each construct (and leak) a
// modal. Built on first use, then reused — both dialogs settle any stale promise on the next ask().
let sharedConfirm: ConfirmDialog | null = null;
let sharedPrompt: PromptDialog | null = null;

/** Ask a yes/no question with the shared Koine confirm dialog. Replaces window.confirm(). */
export function koiConfirm(req: ConfirmRequest): Promise<boolean> {
  return (sharedConfirm ??= createConfirmDialog()).ask(req);
}

/** Ask for a single line of text with the shared Koine prompt dialog. Replaces window.prompt(). */
export function koiPrompt(req: PromptRequest): Promise<string | null> {
  return (sharedPrompt ??= createPromptDialog()).ask(req);
}
