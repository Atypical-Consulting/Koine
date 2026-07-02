// The modal-overlay surface, extracted from ide.tsx's init() (#757). Owns the confirm + prompt dialogs
// (Koine's own modals), the keyboard-shortcuts help overlay, the "is any overlay open?" gate that keeps
// global chords from firing through a modal, the unsaved-work New guard (requestNewModel), and the
// one-time memory-only banner. Pure structural lift: every closure keeps its exact logic; it just moves
// out of init() and reaches the workspace (dirty check, blank-model reset) through the injected `deps`.
import { createConfirmDialog, createPromptDialog, type ConfirmDialog, type PromptDialog } from '@atypical/koine-ui';
import { createHelpOverlay } from '@/shared/help';
import { helpRows } from '@/shell/ideUtils';
import { formatChord } from '@/shared/platform';

export interface OverlaysDeps {
  /** Whether any open buffer is dirty — the unsaved-work check the New/replace guard branches on. */
  anyDirty(): boolean;
  /** Reset to a fresh blank model (the raw reset; the confirm guard lives here). */
  newModel(): Promise<void>;
}

export interface Overlays {
  /** Koine's confirm modal (used by New, the canvas remove-relationship gesture, recent-open recovery,
   *  and the desktop window-close guard). */
  readonly confirm: ConfirmDialog;
  /** Koine's single-field prompt modal (name a construct / field / project). */
  readonly prompt: PromptDialog;
  /** True when the palette or a modal dialog is open, so global shortcuts don't fire through it. */
  overlayOpen(): boolean;
  /** User-initiated New: confirm before discarding unsaved work, then reset to a blank model. */
  requestNewModel(): Promise<void>;
  /** Confirm before an action that would replace the model and lose unsaved work (New + start-screen swaps). */
  confirmReplaceWork(title: string, confirmLabel: string): Promise<boolean>;
  /** A one-time, dismissible banner shown when the workspace is memory-only (no OPFS). */
  showMemoryOnlyBanner(): void;
  /** Open the keyboard-shortcuts help overlay. */
  openHelp(): void;
  /** Toggle the keyboard-shortcuts help overlay (F1). */
  toggleHelp(): void;
  dispose(): void;
}

export function createOverlays(deps: OverlaysDeps): Overlays {
  const help = createHelpOverlay(helpRows());
  // Guards the user-initiated New command against silently discarding unsaved work.
  const confirm = createConfirmDialog();
  // Single-field text prompts (name a new construct, a field, a project) — Koine's own modal, not the browser's.
  const prompt = createPromptDialog();

  // True when the command palette, a modal dialog (help, confirm/prompt, generate), or the gear-launched
  // Settings center overlay is open, so global shortcuts don't fire 'through' an overlay at the editor
  // underneath. The Settings panel (#center-panel-settings) is a center view driven by the store's
  // `settingsOpen` flag; its hidden attribute is toggled by inspectorController. The welcome screen is
  // deliberately excluded — its own actions own that surface.
  function overlayOpen(): boolean {
    return (
      document.querySelector(
        '.koi-palette-backdrop:not([hidden]), .koi-modal-backdrop:not([hidden]), #center-panel-settings:not([hidden])',
      ) !== null
    );
  }

  // A one-time, dismissible top banner shown when the workspace is memory-only (no OPFS) — so work
  // that won't survive a reload is never lost silently. Points at the durable escape hatches.
  function showMemoryOnlyBanner(): void {
    if (document.getElementById('koi-memory-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'koi-memory-banner';
    bar.className = 'koi-memory-banner';
    bar.setAttribute('role', 'status');
    const msg = document.createElement('span');
    msg.className = 'koi-memory-banner-msg';
    msg.textContent =
      'This browser can’t save to disk — your work lives only in this tab and is lost on reload. Use “Copy shareable link”, or open Studio in Chrome/Edge to keep it.';
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'koi-memory-banner-dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => bar.remove());
    bar.append(msg, dismiss);
    document.getElementById('app')?.prepend(bar);
  }

  // Does the workspace hold unsaved work that New would destroy? Files live on disk, so only a dirty
  // open buffer is at risk.
  function hasUnsavedWork(): boolean {
    return deps.anyDirty();
  }

  // Confirm before an action that would replace the current model and lose unsaved work. Resolves
  // true to proceed (nothing to lose, or the user confirmed), false to abort. Shared by New and the
  // start-screen actions that swap the workspace (open folder / recent / example).
  async function confirmReplaceWork(title: string, confirmLabel: string): Promise<boolean> {
    if (!hasUnsavedWork()) return true;
    const save = formatChord('mod+S');
    return confirm.ask({
      title,
      message: `Files with unsaved changes will lose them. Save with ${save} first to keep them.`,
      confirmLabel,
      danger: true,
    });
  }

  // User-initiated New (button, ⌘N, palette, welcome). Confirms before discarding unsaved work;
  // proceeds straight to a fresh blank model when there's nothing to lose.
  async function requestNewModel(): Promise<void> {
    if (await confirmReplaceWork('Start a new model?', 'Discard & start new')) await deps.newModel();
  }

  return {
    confirm,
    prompt,
    overlayOpen,
    requestNewModel,
    confirmReplaceWork,
    showMemoryOnlyBanner,
    openHelp: () => help.open(),
    toggleHelp: () => help.toggle(),
    dispose() {
      /* The dialogs + help overlay are page-lifetime (self-managed) — nothing to release, matching the
         pre-extraction init() teardown which never disposed them. */
    },
  };
}
