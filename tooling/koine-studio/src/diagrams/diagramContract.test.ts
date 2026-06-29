import { afterEach, describe, expect, test } from 'vitest';
import {
  getDefaultCanvasZoom,
  isDiagramEditing,
  isDiagramTouchMode,
  setDefaultCanvasZoom,
  setDiagramEditing,
  setDiagramTouchMode,
} from '@/diagrams/diagramContract';

// Reset module-level state after every test so one can't leak into the next.
afterEach(() => {
  setDiagramTouchMode(false);
  setDiagramEditing(false);
  setDefaultCanvasZoom(100);
});

describe('diagram touch mode (mobile tap-to-edit)', () => {
  test('defaults to false', () => {
    expect(isDiagramTouchMode()).toBe(false);
  });

  test('setDiagramTouchMode(true) flips isDiagramTouchMode() to true', () => {
    setDiagramTouchMode(true);
    expect(isDiagramTouchMode()).toBe(true);
    setDiagramTouchMode(false);
    expect(isDiagramTouchMode()).toBe(false);
  });

  test('is INDEPENDENT of the editing flag (neither toggles the other)', () => {
    // Turning touch on must not enable editing…
    setDiagramTouchMode(true);
    expect(isDiagramEditing()).toBe(false);
    // …and turning editing on must not enable touch.
    setDiagramTouchMode(false);
    setDiagramEditing(true);
    expect(isDiagramTouchMode()).toBe(false);
    // Both can be on at once (the mobile authoring shell: editing-capable but freehand-off).
    setDiagramTouchMode(true);
    expect(isDiagramEditing()).toBe(true);
    expect(isDiagramTouchMode()).toBe(true);
  });
});

describe('default canvas zoom (#762)', () => {
  test('defaults to 100', () => {
    expect(getDefaultCanvasZoom()).toBe(100);
  });

  test('setDefaultCanvasZoom updates the value the renderer reads', () => {
    setDefaultCanvasZoom(150);
    expect(getDefaultCanvasZoom()).toBe(150);
  });

  test('clamps to the diagram zoom band (10–800)', () => {
    setDefaultCanvasZoom(9999);
    expect(getDefaultCanvasZoom()).toBe(800);
    setDefaultCanvasZoom(1);
    expect(getDefaultCanvasZoom()).toBe(10);
  });

  test('ignores a non-finite value (keeps the last good zoom)', () => {
    setDefaultCanvasZoom(150);
    setDefaultCanvasZoom(Number.NaN);
    expect(getDefaultCanvasZoom()).toBe(150);
  });
});
