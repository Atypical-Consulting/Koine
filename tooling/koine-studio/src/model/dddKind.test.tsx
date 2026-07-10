import { describe, expect, test } from 'vitest';
import { render } from '@testing-library/preact';
import { normalizeDddKind } from '@/model/dddKind';
import { normalizeKind } from '@/launcher/buildCatalog';
import { PropertiesPanel } from '@/model/PropertiesPanel';
import { buildModelIndex } from '@/model/modelIndex';
import { createAppStore } from '@/store/index';
import type { GlossaryEntry, GlossaryModel, Range } from '@/lsp/lsp';
import type { InspectorHandlers } from '@/model/inspector';

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
// routes to a chip. `PropertiesPanel`'s `constructKey` (the inspector's own accent-kind fold, #992)
// isn't exported — this exercises it the same way production does, through the real panel + a
// selected element, and reads the fold back off the rendered root's `dataset.kind`.
describe('normalizeDddKind — single source of truth between the launcher and the inspector', () => {
  const range: Range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
  const noop: InspectorHandlers = { onGoto: () => {} };

  function accentKindOf(kind: string): string | undefined {
    const glossary: GlossaryModel = {
      entries: [
        { id: 'Ctx.X', name: 'X', kind, context: 'Ctx', qualifiedName: 'Ctx.X', doc: null, nameRange: range },
      ] satisfies GlossaryEntry[],
    };
    const index = buildModelIndex(glossary, { files: [] });
    const store = createAppStore();
    store.getState().setSelection({ qualifiedName: 'Ctx.X', context: 'Ctx' });
    const { container } = render(<PropertiesPanel store={store} index={index} handlers={noop} />);
    return container.querySelector('.koi-inspector')?.getAttribute('data-kind') ?? undefined;
  }

  test.each(['aggregate', 'entity', 'enum', 'event', 'value', 'quantity', 'integration event'])(
    "buildCatalog's normalizeKind and the inspector's accent kind agree for %s",
    (kind) => {
      const fromLauncher = normalizeKind(kind);
      const fromInspector = accentKindOf(kind);
      expect(fromInspector).toBe(fromLauncher);
    },
  );
});
