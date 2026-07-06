import { describe, expect, test } from 'vitest';
import { createStore } from 'zustand/vanilla';
import { createDiagramsSlice, type DiagramsSlice } from '@/store/slices/diagrams';

const make = () => createStore<DiagramsSlice>((set) => createDiagramsSlice(set));

describe('diagrams slice', () => {
  test('defaults: editing off, touch off, zoom 100, scope scratch', () => {
    const s = make();
    expect(s.getState().diagramEditing).toBe(false);
    expect(s.getState().diagramTouchMode).toBe(false);
    expect(s.getState().defaultCanvasZoom).toBe(100);
    expect(s.getState().diagramPersistScope).toBe('scratch');
  });

  test('setDiagramEditing round-trips', () => {
    const s = make();
    s.getState().setDiagramEditing(true);
    expect(s.getState().diagramEditing).toBe(true);
    s.getState().setDiagramEditing(false);
    expect(s.getState().diagramEditing).toBe(false);
  });

  test('setDiagramTouchMode round-trips independently of editing', () => {
    const s = make();
    s.getState().setDiagramTouchMode(true);
    expect(s.getState().diagramTouchMode).toBe(true);
    expect(s.getState().diagramEditing).toBe(false);
    s.getState().setDiagramTouchMode(false);
    expect(s.getState().diagramTouchMode).toBe(false);
  });

  test('setDefaultCanvasZoom clamps to the 10–800 band', () => {
    const s = make();
    s.getState().setDefaultCanvasZoom(150);
    expect(s.getState().defaultCanvasZoom).toBe(150);
    s.getState().setDefaultCanvasZoom(9999);
    expect(s.getState().defaultCanvasZoom).toBe(800);
    s.getState().setDefaultCanvasZoom(1);
    expect(s.getState().defaultCanvasZoom).toBe(10);
  });

  test('setDefaultCanvasZoom ignores a non-finite value (keeps the last good zoom)', () => {
    const s = make();
    s.getState().setDefaultCanvasZoom(150);
    s.getState().setDefaultCanvasZoom(Number.NaN);
    expect(s.getState().defaultCanvasZoom).toBe(150);
  });

  test('setDiagramPersistScope round-trips and falls back to scratch on empty', () => {
    const s = make();
    s.getState().setDiagramPersistScope('ws-1');
    expect(s.getState().diagramPersistScope).toBe('ws-1');
    s.getState().setDiagramPersistScope('');
    expect(s.getState().diagramPersistScope).toBe('scratch');
  });
});
