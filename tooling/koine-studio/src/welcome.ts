// Welcome / empty-state overlay for Koine Studio. Self-mounts a full-cover screen to
// document.body once (sits above #app, below modals) offering the first actions: start a
// scratch model, open a folder, or reopen a recent folder. The recent list is rebuilt from
// store.getRecentFolders() on every show() so it always reflects the latest history.
import { getRecentFolders } from './store';
import { LOGO_SVG } from './logo';
import { registerOverlay } from './overlay';
import { EXAMPLES, type Example } from './examples';

/** What the welcome actions delegate to; the host (ide.ts) performs the real work. */
export interface WelcomeCallbacks {
  onNewModel(): void;
  onOpenFolder(): void;
  onOpenRecent(path: string): void;
  /** Open one of the starter examples. */
  onOpenExample(example: Example): void;
}

/** Imperative handle returned by createWelcome. */
export interface WelcomeHandle {
  show(): void;
  hide(): void;
  readonly visible: boolean;
}

/** Shorten an absolute path to its last segment for a compact recent-item label. */
function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/**
 * Build the welcome overlay (once) and return show/hide controls. On show() the recent
 * list is rebuilt from getRecentFolders(); any action invokes its callback then hides.
 */
export function createWelcome(cb: WelcomeCallbacks): WelcomeHandle {
  let shown = false;

  const root = document.createElement('div');
  root.className = 'koi-welcome';
  root.hidden = true;
  // Clicking the dimmed area outside the card returns to the editor — mirrors the modal
  // backdrop convention now that the start screen is reachable on demand (logo / palette).
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) hide();
  });

  const card = document.createElement('div');
  card.className = 'koi-welcome-card';
  root.appendChild(card);

  // Dismiss back to the current editor. Invisible Esc was the only exit before; now that "home"
  // is a deliberate destination, the way back has to be visible.
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'koi-welcome-close';
  closeBtn.setAttribute('aria-label', 'Back to editor');
  closeBtn.title = 'Back to editor';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', () => hide());
  card.appendChild(closeBtn);

  // Logo container — the inline SVG (currentColor wordmark) themes with the surrounding text.
  const logo = document.createElement('div');
  logo.className = 'koi-welcome-logo';
  logo.innerHTML = LOGO_SVG;
  card.appendChild(logo);

  const title = document.createElement('h1');
  title.className = 'koi-welcome-title';
  title.textContent = 'Koine Studio';
  card.appendChild(title);

  const tagline = document.createElement('p');
  tagline.className = 'koi-welcome-tagline';
  tagline.textContent = 'A studio for the Koine DDD language.';
  card.appendChild(tagline);

  // Primary actions.
  const actions = document.createElement('div');
  actions.className = 'koi-welcome-actions';
  card.appendChild(actions);

  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'koi-welcome-action primary';
  newBtn.textContent = 'New model';
  newBtn.addEventListener('click', () => {
    hide();
    cb.onNewModel();
  });
  actions.appendChild(newBtn);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'koi-welcome-action';
  openBtn.textContent = 'Open folder…';
  openBtn.addEventListener('click', () => {
    hide();
    cb.onOpenFolder();
  });
  actions.appendChild(openBtn);

  // Example gallery — one-click starter models so a first run has something real to explore.
  const gallery = document.createElement('div');
  gallery.className = 'koi-welcome-gallery';
  const galleryTitle = document.createElement('div');
  galleryTitle.className = 'koi-welcome-recent-title';
  galleryTitle.textContent = 'Start from an example';
  gallery.appendChild(galleryTitle);
  const galleryGrid = document.createElement('div');
  galleryGrid.className = 'koi-welcome-gallery-grid';
  for (const example of EXAMPLES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'koi-welcome-example';
    const name = document.createElement('span');
    name.className = 'koi-welcome-example-name';
    name.textContent = example.name;
    const blurb = document.createElement('span');
    blurb.className = 'koi-welcome-example-blurb';
    blurb.textContent = example.blurb;
    item.append(name, blurb);
    item.addEventListener('click', () => {
      hide();
      cb.onOpenExample(example);
    });
    galleryGrid.appendChild(item);
  }
  gallery.appendChild(galleryGrid);
  card.appendChild(gallery);

  // Recent folders — populated on each show().
  const recent = document.createElement('div');
  recent.className = 'koi-welcome-recent';
  card.appendChild(recent);

  function renderRecent(): void {
    recent.innerHTML = '';

    const heading = document.createElement('div');
    heading.className = 'koi-welcome-recent-title';
    heading.textContent = 'Recent folders';
    recent.appendChild(heading);

    const folders = getRecentFolders();
    if (!folders.length) {
      const empty = document.createElement('p');
      empty.className = 'koi-welcome-empty';
      empty.textContent = 'No recent folders yet.';
      recent.appendChild(empty);
      return;
    }

    for (const path of folders) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'koi-welcome-recent-item';
      item.title = path; // full path on hover

      const name = document.createElement('span');
      name.className = 'koi-welcome-recent-item-name';
      name.textContent = baseName(path);
      item.appendChild(name);

      const full = document.createElement('span');
      full.className = 'koi-welcome-recent-item-path';
      full.textContent = path;
      item.appendChild(full);

      item.addEventListener('click', () => {
        hide();
        cb.onOpenRecent(path);
      });
      recent.appendChild(item);
    }
  }

  // Registered with the shared overlay stack while shown, so Esc dismisses the welcome screen
  // (revealing the seeded scratch editor behind it) and layered overlays close top-first.
  let unregister: (() => void) | null = null;

  function show(): void {
    if (shown) return;
    renderRecent();
    root.hidden = false;
    shown = true;
    unregister = registerOverlay(hide);
    newBtn.focus();
  }

  function hide(): void {
    if (!shown) return;
    root.hidden = true;
    shown = false;
    unregister?.();
    unregister = null;
  }

  document.body.appendChild(root);

  return {
    show,
    hide,
    get visible() {
      return shown;
    },
  };
}
