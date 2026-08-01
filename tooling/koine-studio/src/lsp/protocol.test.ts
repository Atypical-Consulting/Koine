import { describe, expect, test } from 'vitest';
import type { ContextRelation, ModelNode } from '@/lsp/lsp';
import { constructForKind } from '@/model/modelOutline';

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
    const edge = owner.transitions![0];
    expect(edge.name).toBe('Draft'); // from-state
    expect(edge.value).toBe('Submitted'); // to-state
    expect(edge.type).toBe('totalIsPositive'); // guard
    expect(edge.via).toBe('Submit'); // triggering command
  });

  test('the owner entity node carries its flattened transitions', () => {
    expect(owner.transitions).toHaveLength(1);
    expect(owner.transitions!.every((t) => t.kind === 'transition')).toBe(true);
  });
});

// Pins the behavioural-vocabulary vocabulary the backend added in #483 to the two payloads that carry
// it. As above, vitest doesn't typecheck, so the LOAD-BEARING gate for the type mirror is
// `tsc --noEmit`: these fixtures name `upstreamRole`/`downstreamRole` and the behavioural
// `ModelNode.kind`/`ModelMember.kind` spellings, which only conform once protocol.ts carries them.
describe('behavioural vocabulary (#483)', () => {
  // `koine/contextMap` now derives each relation's DDD role names from its kind. Both properties are
  // always present on the wire and are null for the symmetric patterns (partnership, shared kernel).
  const conformist: ContextRelation = {
    upstream: 'Ordering',
    downstream: 'Shipping',
    kind: 'conformist',
    bidirectional: false,
    sharedTypes: [],
    acl: [],
    upstreamRole: 'Upstream',
    downstreamRole: 'Conformist',
  };
  const partnership: ContextRelation = {
    upstream: 'Ordering',
    downstream: 'Billing',
    kind: 'partnership',
    bidirectional: true,
    sharedTypes: [],
    acl: [],
    upstreamRole: null,
    downstreamRole: null,
  };

  test('an asymmetric relation names both ends’ DDD roles', () => {
    expect(conformist.upstreamRole).toBe('Upstream');
    expect(conformist.downstreamRole).toBe('Conformist');
  });

  test('a symmetric relation carries both role properties as null', () => {
    expect(partnership.upstreamRole).toBeNull();
    expect(partnership.downstreamRole).toBeNull();
  });

  // A `koine/model` context child of one new behavioural kind: a policy, whose single `reaction`
  // member correlates the triggering event (name) with the command it reacts with (value).
  const policy: ModelNode = {
    kind: 'policy',
    qualifiedName: 'Ordering.NotifyOnSubmit',
    title: 'NotifyOnSubmit',
    members: [{ kind: 'reaction', name: 'OrderSubmitted', type: null, value: 'Mailer.notify()' }],
    children: [],
  };

  test('a behavioural node projects its correlated reaction member', () => {
    expect(policy.members[0].kind).toBe('reaction');
    expect(policy.members[0].name).toBe('OrderSubmitted'); // triggering event
    expect(policy.members[0].value).toBe('Mailer.notify()'); // the command it reacts with
  });

  // Every behavioural `ModelNode.kind` the payload now emits must resolve a REAL construct glyph, not
  // the generic `Type` fallback — otherwise the navigator would render a policy/repository/query with
  // the same colourless square as an unknown declaration.
  test.each([
    ['command', { slug: 'command', label: 'Command' }],
    ['policy', { slug: 'policy', label: 'Policy' }],
    ['service', { slug: 'service', label: 'Domain Service' }],
    ['repository', { slug: 'repository', label: 'Repository' }],
    ['read-model', { slug: 'read-model', label: 'Read Model' }],
    ['query', { slug: 'query', label: 'Query' }],
    ['factory', { slug: 'factory', label: 'Factory' }],
    ['spec', { slug: 'spec', label: 'Specification' }],
  ])('constructForKind(%j) resolves a non-Type construct', (kind, expected) => {
    expect(constructForKind(kind)).toEqual(expected);
    expect(constructForKind(kind).slug).not.toBe('type');
    expect(constructForKind(kind).label).not.toBe('Type');
  });
});
