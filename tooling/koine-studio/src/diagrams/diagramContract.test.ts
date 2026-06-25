import { afterEach, describe, expect, test } from 'vitest';
import {
  isDiagramEditing,
  isDiagramTouchMode,
  setDiagramEditing,
  setDiagramTouchMode,
} from '@/diagrams/diagramContract';

// Reset both module-level flags after every test so one can't leak into the next.
afterEach(() => {
  setDiagramTouchMode(false);
  setDiagramEditing(false);
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
