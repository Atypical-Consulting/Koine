import { describe, test, beforeEach, expect } from 'vitest';
import { loadLayout, saveLayout, DEFAULT_LAYOUT } from '@/shell/layoutStore';

describe('layoutStore defaults', () => {
  beforeEach(() => localStorage.clear());

  test('bottom panel by default', () => {
    expect(DEFAULT_LAYOUT.panelSide).toBe('bottom');
    expect(loadLayout().panelSide).toBe('bottom');
  });

  test('right side rail by default', () => {
    expect(DEFAULT_LAYOUT.sideRail).toBe('right');
    expect(loadLayout().sideRail).toBe('right');
  });

  test('right rail is not collapsed by default', () => {
    expect(DEFAULT_LAYOUT.rightCollapsed).toBe(false);
    expect(loadLayout().rightCollapsed).toBe(false);
  });
});

describe('layoutStore round-trip', () => {
  beforeEach(() => localStorage.clear());

  test('saveLayout then loadLayout round-trips all fields', () => {
    saveLayout({
      panelSide: 'right',
      sideRail: 'left',
      rightCollapsed: true,
    });
    const loaded = loadLayout();
    expect(loaded.panelSide).toBe('right');
    expect(loaded.sideRail).toBe('left');
    expect(loaded.rightCollapsed).toBe(true);
  });

  test('saveLayout is a patch: unspecified fields keep their prior value', () => {
    saveLayout({ panelSide: 'right' });
    saveLayout({ sideRail: 'left' });
    const loaded = loadLayout();
    expect(loaded.panelSide).toBe('right');
    expect(loaded.sideRail).toBe('left');
  });

  test('rightCollapsed round-trips', () => {
    saveLayout({ rightCollapsed: true });
    expect(loadLayout().rightCollapsed).toBe(true);
  });

  test('saveLayout returns the full merged state', () => {
    const result = saveLayout({ panelSide: 'right' });
    expect(result.panelSide).toBe('right');
    expect(result.sideRail).toBe('right'); // default unchanged
  });
});

describe('layoutStore absent/corrupt key', () => {
  beforeEach(() => localStorage.clear());

  test('absent key returns defaults', () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  test('corrupt blob returns defaults', () => {
    localStorage.setItem('koine.studio.layout', '{not valid json');
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  test('a non-object stored value returns defaults', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify([1, 2, 3]));
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });
});

describe('layoutStore per-field coercion', () => {
  beforeEach(() => localStorage.clear());

  test('bogus panelSide value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ panelSide: 'top' }));
    expect(loadLayout().panelSide).toBe('bottom');
  });

  test('bogus sideRail value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ sideRail: 'center' }));
    expect(loadLayout().sideRail).toBe('right');
  });

  test('bogus rightCollapsed value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ rightCollapsed: 'yes' }));
    expect(loadLayout().rightCollapsed).toBe(false);
  });

  test('valid fields survive alongside a bogus field', () => {
    localStorage.setItem(
      'koine.studio.layout',
      JSON.stringify({ panelSide: 'right', sideRail: 'bad', rightCollapsed: true }),
    );
    const loaded = loadLayout();
    expect(loaded.panelSide).toBe('right');
    expect(loaded.sideRail).toBe('right'); // coerced to default
    expect(loaded.rightCollapsed).toBe(true);
  });
});
