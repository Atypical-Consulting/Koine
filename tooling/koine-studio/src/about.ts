// About dialog for Koine Studio: a generic modal (.koi-modal* classes) that shows the
// app logo, the version fetched from the `app_version` Tauri command, and a one-line
// tagline. Self-mounts to document.body once; closes on Esc, backdrop click, or the
// header close button. Degrades gracefully when the version command or logo is absent.
import { invoke } from '@tauri-apps/api/core';
import { LOGO_SVG } from './logo';

export interface AboutHandle {
  open(): void;
  close(): void;
}

const TAGLINE = 'A studio for the Koine DDD language.';

/**
 * Build (once) the About modal: backdrop + centered panel with a header (title + close),
 * a body holding the logo, version line, and tagline, and a footer. Returns an
 * `{ open, close }` handle. `open()` shows the modal and (re)fetches `app_version`,
 * updating the version line in place; a failed fetch shows a neutral fallback string.
 */
export function createAboutDialog(): AboutHandle {
  const backdrop = document.createElement('div');
  backdrop.className = 'koi-modal-backdrop';
  backdrop.hidden = true;

  const modal = document.createElement('div');
  modal.className = 'koi-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'About Koine Studio');

  // Header: title + close button.
  const header = document.createElement('div');
  header.className = 'koi-modal-header';
  const title = document.createElement('h2');
  title.className = 'koi-modal-title';
  title.textContent = 'About';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'koi-modal-close';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  // Body: logo + version + tagline.
  const body = document.createElement('div');
  body.className = 'koi-modal-body';

  const logo = document.createElement('div');
  logo.className = 'koi-welcome-logo'; // shared logo container
  logo.setAttribute('aria-hidden', 'true');
  logo.innerHTML = LOGO_SVG;

  const version = document.createElement('p');
  version.className = 'koi-about-version';
  version.textContent = 'Koine Studio'; // filled with the version on open()

  const tagline = document.createElement('p');
  tagline.className = 'koi-about-tagline';
  tagline.textContent = TAGLINE;

  body.append(logo, version, tagline);

  // Footer (kept for layout parity with the other modals; no actions needed here).
  const footer = document.createElement('div');
  footer.className = 'koi-modal-footer';

  modal.append(header, body, footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  let open = false;
  let opener: HTMLElement | null = null;

  function show(): void {
    if (open) return;
    open = true;
    opener = document.activeElement as HTMLElement | null;
    backdrop.hidden = false;
    document.addEventListener('keydown', onKeydown);
    closeBtn.focus();
    void loadVersion();
  }

  function hide(): void {
    if (!open) return;
    open = false;
    backdrop.hidden = true;
    document.removeEventListener('keydown', onKeydown);
    opener?.focus?.(); // restore focus to whatever opened the dialog
    opener = null;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  }

  // Fetch the version lazily on open so a slow/absent command never blocks construction.
  // A failed invoke leaves a neutral "Koine Studio" label rather than surfacing an error.
  async function loadVersion(): Promise<void> {
    try {
      const v = await invoke<string>('app_version');
      version.textContent = v ? `Koine Studio v${v}` : 'Koine Studio';
    } catch {
      version.textContent = 'Koine Studio';
    }
  }

  closeBtn.addEventListener('click', () => hide());
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) hide(); // backdrop click (outside the panel) closes
  });

  return { open: show, close: hide };
}
