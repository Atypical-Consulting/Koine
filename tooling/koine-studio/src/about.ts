// About dialog for Koine Studio: uses the shared createModal() chrome to show the app logo,
// the version fetched from the `app_version` Tauri command, and a one-line tagline. The
// version is (re)fetched each time the dialog opens; a failed fetch shows a neutral fallback.
import { invoke } from '@tauri-apps/api/core';
import { createModal } from './overlay';
import { LOGO_SVG } from './logo';

export interface AboutHandle {
  open(): void;
  close(): void;
}

const TAGLINE = 'A studio for the Koine DDD language.';

/** Build the About modal (once) and return an `{ open, close }` handle. */
export function createAboutDialog(): AboutHandle {
  const modal = createModal({ title: 'About', ariaLabel: 'About Koine Studio' });

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

  modal.body.append(logo, version, tagline);

  // Fetch the version lazily on each open so a slow/absent command never blocks construction.
  // A failed invoke leaves a neutral "Koine Studio" label rather than surfacing an error.
  modal.onOpen(() => {
    void invoke<string>('app_version')
      .then((v) => {
        version.textContent = v ? `Koine Studio v${v}` : 'Koine Studio';
      })
      .catch(() => {
        version.textContent = 'Koine Studio';
      });
  });

  return { open: modal.open, close: modal.close };
}
