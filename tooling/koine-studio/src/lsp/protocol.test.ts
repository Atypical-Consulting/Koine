import { describe, expect, test } from 'vitest';
import type { ModelNode } from '@/lsp/lsp';

// Pins the state-transition projection the Studio launcher reads off a `koine/model` node (#1163). A
// `transition` ModelMember reuses the generic leaf fields: name=from-state, value=to-state, type=guard,
// and the additive `via`=the correlated triggering command. An entity/aggregate owner node also surfaces
// the flattened per-edge transitions on its `transitions` array (so a consumer needn't reconstruct
// ownership from the nested `.states.<field>` qualifiedName). Because vitest doesn't typecheck, the
// LOAD-BEARING gate for the type mirror is `tsc --noEmit`: this fixture references `transitions`/`via`,
// which only exist once protocol.ts carries them.
describe('ModelNode transition projection', () => {
  const owner: ModelNode = {
    kind: 'entity',
    qualifiedName: 'Ordering.Order.Order',
    title: 'Order',
    members: [],
    children: [],
    transitions: [
      { kind: 'transition', name: 'Draft', type: 'totalIsPositive', value: 'Submitted', via: 'Submit' },
    ],
  };

  test('a transition member projects from/to/guard/trigger onto the generic leaf fields', () => {
    const edge = owner.transitions[0];
    expect(edge.name).toBe('Draft'); // from-state
    expect(edge.value).toBe('Submitted'); // to-state
    expect(edge.type).toBe('totalIsPositive'); // guard
    expect(edge.via).toBe('Submit'); // triggering command
  });

  test('the owner entity node carries its flattened transitions', () => {
    expect(owner.transitions).toHaveLength(1);
    expect(owner.transitions.every((t) => t.kind === 'transition')).toBe(true);
  });
});
