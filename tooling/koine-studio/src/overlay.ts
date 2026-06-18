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

type CloseFn = () => void;

// Open overlays, bottom-to-top. The last entry is the one Esc closes.
const stack: CloseFn[] = [];

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
}

/**
 * Build the shared modal chrome once, mount it (hidden) on document.body, and return an
 * imperative handle. Esc is handled centrally via the overlay stack; backdrop click and the
 * header close button also close. Focus is captured on open and restored on close.
 */
export function createModal(opts: ModalOptions): ModalHandle {
  const backdrop = document.createElement('div');
  backdrop.className = 'koi-modal-backdrop';
  backdrop.hidden = true;

  const modal = document.createElement('div');
  modal.className = 'koi-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', opts.ariaLabel ?? opts.title);

  const header = document.createElement('div');
  header.className = 'koi-modal-header';
  const title = document.createElement('h2');
  title.className = 'koi-modal-title';
  title.textContent = opts.title;
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'koi-modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '✕';
  header.append(title, closeBtn);

  const body = document.createElement('div');
  body.className = 'koi-modal-body';

  const footer = document.createElement('div');
  footer.className = 'koi-modal-footer';

  modal.append(header, body, footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let isOpen = false;
  let opener: HTMLElement | null = null;
  let unregister: (() => void) | null = null;
  const openCbs: Array<() => void> = [];

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
  }

  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close(); // click outside the panel closes
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
  };
}
