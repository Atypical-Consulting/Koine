import { describe, test, beforeEach, expect } from 'vitest';
import { loadLayout, saveLayout, DEFAULT_LAYOUT } from '@/shell/layoutStore';

describe('layoutStore defaults', () => {
  beforeEach(() => localStorage.clear());

  test('single-editor: splitOpen is false by default', () => {
    expect(DEFAULT_LAYOUT.splitOpen).toBe(false);
    expect(loadLayout().splitOpen).toBe(false);
  });

  test('horizontal orientation by default', () => {
    expect(DEFAULT_LAYOUT.orientation).toBe('horizontal');
    expect(loadLayout().orientation).toBe('horizontal');
  });

  test('bottom panel by default', () => {
    expect(DEFAULT_LAYOUT.panelSide).toBe('bottom');
    expect(loadLayout().panelSide).toBe('bottom');
  });

  test('right side rail by default', () => {
    expect(DEFAULT_LAYOUT.sideRail).toBe('right');
    expect(loadLayout().sideRail).toBe('right');
  });

  test('groupActiveUris defaults to empty-A and no B', () => {
    expect(DEFAULT_LAYOUT.groupActiveUris).toEqual(['', undefined]);
    expect(loadLayout().groupActiveUris).toEqual(['', undefined]);
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
      splitOpen: true,
      orientation: 'vertical',
      panelSide: 'right',
      sideRail: 'left',
      groupActiveUris: ['file:///a.koi', 'file:///b.koi'],
    });
    const loaded = loadLayout();
    expect(loaded.splitOpen).toBe(true);
    expect(loaded.orientation).toBe('vertical');
    expect(loaded.panelSide).toBe('right');
    expect(loaded.sideRail).toBe('left');
    expect(loaded.groupActiveUris).toEqual(['file:///a.koi', 'file:///b.koi']);
  });

  test('saveLayout is a patch: unspecified fields keep their prior value', () => {
    saveLayout({ splitOpen: true });
    saveLayout({ orientation: 'vertical' });
    const loaded = loadLayout();
    expect(loaded.splitOpen).toBe(true);
    expect(loaded.orientation).toBe('vertical');
  });

  test('saveLayout with only group-A uri (group-B omitted)', () => {
    saveLayout({ groupActiveUris: ['file:///a.koi'] });
    expect(loadLayout().groupActiveUris).toEqual(['file:///a.koi', undefined]);
  });

  test('rightCollapsed round-trips', () => {
    saveLayout({ rightCollapsed: true });
    expect(loadLayout().rightCollapsed).toBe(true);
  });

  test('saveLayout returns the full merged state', () => {
    const result = saveLayout({ splitOpen: true, panelSide: 'right' });
    expect(result.splitOpen).toBe(true);
    expect(result.panelSide).toBe('right');
    expect(result.orientation).toBe('horizontal'); // default unchanged
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

  test('bogus orientation value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ orientation: 'diagonal' }));
    expect(loadLayout().orientation).toBe('horizontal');
  });

  test('bogus panelSide value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ panelSide: 'top' }));
    expect(loadLayout().panelSide).toBe('bottom');
  });

  test('bogus sideRail value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ sideRail: 'center' }));
    expect(loadLayout().sideRail).toBe('right');
  });

  test('bogus splitOpen value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ splitOpen: 'yes' }));
    expect(loadLayout().splitOpen).toBe(false);
  });

  test('non-array groupActiveUris coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ groupActiveUris: 'file:///a.koi' }));
    expect(loadLayout().groupActiveUris).toEqual(['', undefined]);
  });

  test('bogus rightCollapsed value coerces to the default', () => {
    localStorage.setItem('koine.studio.layout', JSON.stringify({ rightCollapsed: 'yes' }));
    expect(loadLayout().rightCollapsed).toBe(false);
  });

  test('valid fields survive alongside a bogus field', () => {
    localStorage.setItem(
      'koine.studio.layout',
      JSON.stringify({ splitOpen: true, orientation: 'bad', panelSide: 'right', sideRail: 'left' }),
    );
    const loaded = loadLayout();
    expect(loaded.splitOpen).toBe(true);
    expect(loaded.orientation).toBe('horizontal'); // coerced to default
    expect(loaded.panelSide).toBe('right');
    expect(loaded.sideRail).toBe('left');
  });
});
