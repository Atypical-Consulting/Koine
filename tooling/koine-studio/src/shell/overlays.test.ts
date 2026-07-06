import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the dialog + help constructors so the confirm flow is controllable and no real modal DOM/timers
// are spun up. helpRows + formatChord stay real (pure).
const { confirmAsk, promptAsk } = vi.hoisted(() => ({ confirmAsk: vi.fn(), promptAsk: vi.fn() }));
vi.mock('@atypical/koine-ui', () => ({
  createConfirmDialog: vi.fn(() => ({ ask: confirmAsk })),
  createPromptDialog: vi.fn(() => ({ ask: promptAsk })),
}));
vi.mock('@/shared/help', () => ({ createHelpOverlay: vi.fn(() => ({ open: vi.fn(), close: vi.fn(), toggle: vi.fn() })) }));

import { createOverlays, type OverlaysDeps } from '@/shell/overlays';

function makeDeps(over: Partial<OverlaysDeps> = {}): OverlaysDeps {
  return { anyDirty: () => false, newModel: vi.fn(async () => undefined), ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('overlays', () => {
  describe('overlayOpen', () => {
    it('is false with no overlay, true when a visible backdrop exists, false when hidden', () => {
      const overlays = createOverlays(makeDeps());
      expect(overlays.overlayOpen()).toBe(false);

      const back = document.createElement('div');
      back.className = 'koi-palette-backdrop';
      document.body.appendChild(back);
      expect(overlays.overlayOpen()).toBe(true);

      back.hidden = true;
      expect(overlays.overlayOpen()).toBe(false);
    });

    it('also counts a visible modal backdrop', () => {
      const overlays = createOverlays(makeDeps());
      const modal = document.createElement('div');
      modal.className = 'koi-modal-backdrop';
      document.body.appendChild(modal);
      expect(overlays.overlayOpen()).toBe(true);
    });

    it('counts the Spotlight launcher scrim (.lx-scrim), and not when hidden (#1145)', () => {
      const overlays = createOverlays(makeDeps());
      const scrim = document.createElement('div');
      scrim.className = 'lx-scrim';
      scrim.hidden = true; // mounted-but-closed, as createLauncher keeps it
      document.body.appendChild(scrim);
      expect(overlays.overlayOpen()).toBe(false);

      scrim.hidden = false; // launcher opened
      expect(overlays.overlayOpen()).toBe(true);

      scrim.hidden = true; // launcher closed again
      expect(overlays.overlayOpen()).toBe(false);
    });

    it('counts a visible Settings center panel (#center-panel-settings)', () => {
      const overlays = createOverlays(makeDeps());
      // No overlay open initially.
      expect(overlays.overlayOpen()).toBe(false);

      // Add the Settings center panel (hidden by default, as in index.html).
      const panel = document.createElement('section');
      panel.id = 'center-panel-settings';
      panel.hidden = true;
      document.body.appendChild(panel);
      // Still hidden — should not count.
      expect(overlays.overlayOpen()).toBe(false);

      // Reveal the panel (simulating the store driving settingsOpen → hidden=false in inspectorController).
      panel.hidden = false;
      expect(overlays.overlayOpen()).toBe(true);

      // Hiding again clears it.
      panel.hidden = true;
      expect(overlays.overlayOpen()).toBe(false);
    });
  });

  describe('requestNewModel (unsaved-work guard)', () => {
    it('resets straight away when nothing is dirty (no confirm)', async () => {
      const deps = makeDeps({ anyDirty: () => false });
      await createOverlays(deps).requestNewModel();
      expect(confirmAsk).not.toHaveBeenCalled();
      expect(deps.newModel).toHaveBeenCalledOnce();
    });

    it('confirms first when dirty, and resets only when the user accepts', async () => {
      confirmAsk.mockResolvedValue(true);
      const deps = makeDeps({ anyDirty: () => true });
      await createOverlays(deps).requestNewModel();
      expect(confirmAsk).toHaveBeenCalledOnce();
      expect(deps.newModel).toHaveBeenCalledOnce();
    });

    it('aborts the reset when the user declines the confirm', async () => {
      confirmAsk.mockResolvedValue(false);
      const deps = makeDeps({ anyDirty: () => true });
      await createOverlays(deps).requestNewModel();
      expect(confirmAsk).toHaveBeenCalledOnce();
      expect(deps.newModel).not.toHaveBeenCalled();
    });
  });

  describe('showMemoryOnlyBanner', () => {
    it('prepends a single dismissible banner into #app and is idempotent', () => {
      const app = document.createElement('div');
      app.id = 'app';
      document.body.appendChild(app);
      const overlays = createOverlays(makeDeps());

      overlays.showMemoryOnlyBanner();
      overlays.showMemoryOnlyBanner(); // second call must not duplicate
      expect(app.querySelectorAll('#koi-memory-banner')).toHaveLength(1);

      const dismiss = app.querySelector('.koi-memory-banner-dismiss') as HTMLButtonElement;
      dismiss.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(document.getElementById('koi-memory-banner')).toBeNull();
    });
  });
});
