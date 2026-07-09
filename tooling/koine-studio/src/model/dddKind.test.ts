import { afterEach, describe, expect, test } from 'vitest';
import { normalizeDddKind } from '@/model/dddKind';
import { normalizeKind } from '@/launcher/buildCatalog';
import { renderInspector, type InspectorElement, type InspectorHandlers } from '@/model/inspector';

afterEach(() => {
  document.body.innerHTML = '';
});

// The canonical alias-fold kernel (issue #1162): `quantity` -> `value`, the SPACE-spelled
// "integration event" -> `integration-event`, everything else passes through unchanged. Both
// `buildCatalog.normalizeKind` and `inspector.constructKey` delegate to this.
describe('normalizeDddKind — the canonical DDD-kind alias fold', () => {
  test.each([
    ['aggregate', 'aggregate'],
    ['entity', 'entity'],
    ['enum', 'enum'],
    ['event', 'event'],
    ['value', 'value'],
    ['quantity', 'value'],
    ['integration event', 'integration-event'],
    ['integration-event', 'integration-event'],
    ['service', 'service'], // passthrough — constructKey folds this to 'type' itself, not here
    ['weird', 'weird'], // passthrough
  ])('normalizeDddKind(%s) === %s', (input, expected) => {
    expect(normalizeDddKind(input)).toBe(expected);
  });
});

// Single-source-of-truth guard (issue #1162): before the refactor these were two independently
// hand-maintained folds that had already drifted on their fallback. After both call sites delegate
// to `normalizeDddKind`, they must agree on every kind the backend's `GlossaryModelBuilder.KindOf`
// routes to a chip.
describe('normalizeDddKind — single source of truth between the launcher and the inspector', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const noop: InspectorHandlers = { onGoto: () => {} };
  const elementOf = (kind: string): InspectorElement => ({
    id: 'Ctx.X', name: 'X', qualifiedName: 'Ctx.X', context: 'Ctx', kind,
    stereotype: null, description: null, properties: [], behaviors: [], values: [], nameRange: range,
  });

  test.each(['aggregate', 'entity', 'enum', 'event', 'value', 'quantity', 'integration event'])(
    "buildCatalog's normalizeKind and the inspector's accent kind agree for %s",
    (kind) => {
      const fromLauncher = normalizeKind(kind);
      const fromInspector = renderInspector(elementOf(kind), noop).dataset.kind;
      expect(fromInspector).toBe(fromLauncher);
    },
  );
});
