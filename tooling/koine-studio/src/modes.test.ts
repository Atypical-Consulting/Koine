import { describe, expect, test } from 'vitest';
import {
  DEFAULT_MODE_ID,
  MODES,
  defaultViewForMode,
  isValidModeId,
  modeForView,
  viewsForMode,
  type RightView,
} from './modes';

// The full RightView roster, mirrored here so "every view maps to a mode" is an INDEPENDENT check
// against the type union (TS types are erased at runtime, so the test needs its own roster).
const ALL_VIEWS: RightView[] = ['preview', 'model', 'glossary', 'diagrams', 'contextmap', 'outline', 'assistant', 'check'];

describe('workspace modes', () => {
  test('viewsForMode(domain) groups the model-exploration views', () => {
    const views = viewsForMode('domain');
    expect(views).toContain('outline');
    expect(views).toContain('diagrams');
  });

  test('defaultViewForMode(code) lands on the emitted preview', () => {
    expect(defaultViewForMode('code')).toBe('preview');
  });

  test('modeForView(glossary) is the Docs mode', () => {
    expect(modeForView('glossary')).toBe('docs');
  });

  test('every RightView maps to at least one mode', () => {
    for (const view of ALL_VIEWS) {
      const mode = modeForView(view);
      expect(isValidModeId(mode)).toBe(true);
      expect(viewsForMode(mode)).toContain(view);
    }
  });

  test("each mode's default view belongs to that mode", () => {
    for (const mode of MODES) {
      expect(mode.views).toContain(mode.defaultView);
    }
  });

  test('the modes partition the views — each view in exactly one mode, all covered', () => {
    const seen = new Set<RightView>();
    for (const mode of MODES) {
      for (const v of mode.views) {
        expect(seen.has(v)).toBe(false);
        seen.add(v);
      }
    }
    expect(seen.size).toBe(ALL_VIEWS.length);
  });

  test('DEFAULT_MODE_ID is the Domain mode', () => {
    expect(DEFAULT_MODE_ID).toBe('domain');
    expect(isValidModeId(DEFAULT_MODE_ID)).toBe(true);
  });

  test('isValidModeId accepts real modes and rejects everything else', () => {
    expect(isValidModeId('code')).toBe(true);
    expect(isValidModeId('tests')).toBe(false); // a Tests mode is a future follow-up, not present yet
    expect(isValidModeId('')).toBe(false);
  });

  test('lookups fall back to the default mode for unknown ids/views', () => {
    expect(viewsForMode('bogus')).toEqual(viewsForMode(DEFAULT_MODE_ID));
    expect(defaultViewForMode('bogus')).toBe(defaultViewForMode(DEFAULT_MODE_ID));
    expect(modeForView('bogus' as RightView)).toBe(DEFAULT_MODE_ID);
  });
});
