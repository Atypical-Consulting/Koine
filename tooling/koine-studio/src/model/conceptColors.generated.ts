// GENERATED — do not edit. Source of truth: design/concept-colors.json (ADR 0004 — Concept Colors).
// Regenerate with `npm run gen:colors` in tooling/koine-studio.

/** A DDD concept slug — the key of a `--koi-ddd-<slug>` var and a `cm-st-k-<slug>` editor class. */
export type ConceptSlug = 'aggregate' | 'entity' | 'value' | 'enum' | 'event' | 'integration-event' | 'command' | 'query' | 'read-model' | 'service' | 'repository' | 'policy' | 'factory' | 'state-machine' | 'spec';

/** One concept's palette entry. `modifier` is the LSP semantic-token modifier name it maps to. */
export interface ConceptColor {
  readonly label: string;
  readonly modifier: string;
  readonly dark: string;
  readonly light: string;
}

/**
 * Concept slugs in LSP modifier-bit order: CONCEPT_SLUGS[i] is the concept for semantic-token
 * modifier bit i+1 (bit 0 is `declaration`). Editors decode a token's modifier bits against this.
 */
export const CONCEPT_SLUGS = [
  'aggregate',
  'entity',
  'value',
  'enum',
  'event',
  'integration-event',
  'command',
  'query',
  'read-model',
  'service',
  'repository',
  'policy',
  'factory',
  'state-machine',
  'spec',
] as const;

/** Every concept's palette entry, keyed by slug. Single source: design/concept-colors.json. */
export const CONCEPT_COLORS: Record<ConceptSlug, ConceptColor> = {
  'aggregate': { label: 'Aggregate', modifier: 'aggregate', dark: '#8b87f5', light: '#4f46e5' },
  'entity': { label: 'Entity', modifier: 'entity', dark: '#34d399', light: '#047857' },
  'value': { label: 'Value object', modifier: 'valueObject', dark: '#5aa9f0', light: '#2563eb' },
  'enum': { label: 'Enumeration', modifier: 'enumeration', dark: '#fbbf24', light: '#b45309' },
  'event': { label: 'Domain event', modifier: 'domainEvent', dark: '#f472b6', light: '#db2777' },
  'integration-event': { label: 'Integration event', modifier: 'integrationEvent', dark: '#2dd4bf', light: '#0f766e' },
  'command': { label: 'Command', modifier: 'command', dark: '#ef4444', light: '#dc2626' },
  'query': { label: 'Query', modifier: 'query', dark: '#38bdf8', light: '#0369a1' },
  'read-model': { label: 'Read model', modifier: 'readModel', dark: '#a3e635', light: '#4d7c0f' },
  'service': { label: 'Service', modifier: 'service', dark: '#fb923c', light: '#c2410c' },
  'repository': { label: 'Repository', modifier: 'repository', dark: '#94a3b8', light: '#475569' },
  'policy': { label: 'Policy', modifier: 'policy', dark: '#d946ef', light: '#a21caf' },
  'factory': { label: 'Factory', modifier: 'factory', dark: '#f59e0b', light: '#a16207' },
  'state-machine': { label: 'State machine', modifier: 'stateMachine', dark: '#06b6d4', light: '#0e7490' },
  'spec': { label: 'Specification', modifier: 'specification', dark: '#c084fc', light: '#7c3aed' },
};
