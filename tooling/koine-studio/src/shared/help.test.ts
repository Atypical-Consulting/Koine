import { afterEach, describe, expect, test, vi } from 'vitest';
import { createHelpOverlay, type ShortcutRow } from '@/shared/help';

afterEach(() => {
  document.body.innerHTML = '';
});

// createHelpOverlay is a long-lived singleton (built once in createOverlays()); the modal body must
// re-render from a FRESH getRows() call on every open, not just once at construction, or a Settings →
// Keyboard rebind of commandPalette/saveAll (#432) would never show up in an already-open session
// without a page reload (#1627).
describe('createHelpOverlay', () => {
  test('does not call getRows until the overlay is opened', () => {
    const getRows = vi.fn((): ShortcutRow[] => [{ keys: 'mod+K', description: 'Command palette' }]);
    createHelpOverlay(getRows);
    expect(getRows).not.toHaveBeenCalled();
  });

  test('re-invokes getRows and re-renders the body on every open', () => {
    let current: ShortcutRow[] = [{ keys: 'mod+K', description: 'Command palette' }];
    const getRows = vi.fn((): ShortcutRow[] => current);
    const help = createHelpOverlay(getRows);

    help.open();
    expect(getRows).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Command palette');

    help.close();
    current = [{ keys: 'mod+J', description: 'Command palette (rebound)' }];
    help.open();

    expect(getRows).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('Command palette (rebound)');
  });
});
