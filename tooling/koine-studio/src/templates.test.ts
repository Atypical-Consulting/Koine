import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The generator's pure core lives in the .mjs alongside the script runner, so it can be driven
// against a fixture here without writing src/templates.generated.ts.
import { collectTemplates, renderManifest } from '@/../scripts/generate-templates.mjs';

// A tiny fixture templates dir mirroring the real repo `templates/` layout: a nested starter group
// (single-file) and a top-level multi-file family. We assert the generator resolves `source` from
// `entryFile` and that `files[]` covers every `.koi` in each folder.
let fixtureDir: string;

const BILLING_KOI = `context Billing {\n  value Money { amount: Decimal }\n}\n`;
const PIZZA_MENU = `context Menu {\n  entity Pizza identified by PizzaId { name: String }\n}\n`;
const PIZZA_ORDERING = `context Ordering {\n  aggregate Order root Order { entity Order identified by OrderId { } }\n}\n`;
const PIZZA_MAP = `contextmap {\n  Menu -> Ordering : conformist\n}\n`;

const billingManifest = {
  id: 'billing',
  name: 'Billing',
  tagline: 'Money and invariants.',
  description: 'A small billing context.',
  difficulty: 'starter',
  tags: ['billing', 'money'],
  contexts: ['Billing'],
  coreAggregate: 'Order',
  entryFile: 'billing.koi',
  teaches: ['value objects'],
  icon: '💳',
};

const pizzeriaManifest = {
  id: 'pizzeria',
  name: 'Pizzeria',
  tagline: 'Multiple contexts.',
  description: 'Multi-file pizzeria.',
  difficulty: 'intermediate',
  tags: ['multi-file'],
  contexts: ['Menu', 'Ordering'],
  coreAggregate: 'Order',
  entryFile: 'ordering.koi',
  teaches: ['context maps'],
  icon: '🍕',
};

beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'koine-templates-'));

  // Nested starter (single-file), exercising the `starters/` group.
  const billingDir = join(fixtureDir, 'starters', 'billing');
  mkdirSync(billingDir, { recursive: true });
  writeFileSync(join(billingDir, 'template.json'), JSON.stringify(billingManifest, null, 2));
  writeFileSync(join(billingDir, 'billing.koi'), BILLING_KOI);

  // Top-level multi-file family.
  const pizzeriaDir = join(fixtureDir, 'pizzeria');
  mkdirSync(pizzeriaDir, { recursive: true });
  writeFileSync(join(pizzeriaDir, 'template.json'), JSON.stringify(pizzeriaManifest, null, 2));
  writeFileSync(join(pizzeriaDir, 'menu.koi'), PIZZA_MENU);
  writeFileSync(join(pizzeriaDir, 'ordering.koi'), PIZZA_ORDERING);
  writeFileSync(join(pizzeriaDir, 'context-map.koi'), PIZZA_MAP);

  // A non-template .koi at the root and the schema file must be ignored (no template.json sibling).
  writeFileSync(join(fixtureDir, 'template.schema.json'), '{}');
});

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('collectTemplates', () => {
  it('discovers every folder with a template.json, including nested starters', () => {
    const templates = collectTemplates(fixtureDir);
    const ids = templates.map((t) => t.id).sort();
    expect(ids).toEqual(['billing', 'pizzeria']);
  });

  it('carries every manifest field through to the Template', () => {
    const billing = collectTemplates(fixtureDir).find((t) => t.id === 'billing')!;
    expect(billing.name).toBe('Billing');
    expect(billing.tagline).toBe('Money and invariants.');
    expect(billing.difficulty).toBe('starter');
    expect(billing.tags).toEqual(['billing', 'money']);
    expect(billing.contexts).toEqual(['Billing']);
    expect(billing.coreAggregate).toBe('Order');
    expect(billing.entryFile).toBe('billing.koi');
    expect(billing.teaches).toEqual(['value objects']);
    expect(billing.icon).toBe('💳');
  });

  it('resolves `source` from the manifest entryFile', () => {
    const pizzeria = collectTemplates(fixtureDir).find((t) => t.id === 'pizzeria')!;
    // entryFile is ordering.koi, so `source` is that file's contents (NOT menu.koi).
    expect(pizzeria.source).toBe(PIZZA_ORDERING);
  });

  it('includes every .koi in the folder in files[], forward-slashed', () => {
    const pizzeria = collectTemplates(fixtureDir).find((t) => t.id === 'pizzeria')!;
    const byPath = Object.fromEntries((pizzeria.files ?? []).map((f) => [f.relPath, f.contents]));
    expect(Object.keys(byPath).sort()).toEqual(['context-map.koi', 'menu.koi', 'ordering.koi']);
    expect(byPath['menu.koi']).toBe(PIZZA_MENU);
    expect(byPath['ordering.koi']).toBe(PIZZA_ORDERING);
    expect(byPath['context-map.koi']).toBe(PIZZA_MAP);
  });

  it('throws when entryFile names a file missing from the folder', () => {
    const broken = mkdtempSync(join(tmpdir(), 'koine-templates-bad-'));
    try {
      const dir = join(broken, 'oops');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'template.json'),
        JSON.stringify({ ...billingManifest, id: 'oops', entryFile: 'nope.koi' }),
      );
      writeFileSync(join(dir, 'real.koi'), '// real');
      expect(() => collectTemplates(broken)).toThrow(/nope\.koi/);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });

  it('renders a valid TS module exporting TEMPLATES', () => {
    const templates = collectTemplates(fixtureDir);
    const ts = renderManifest(templates);
    expect(ts).toContain('export const TEMPLATES');
    expect(ts).toContain("import type { Template } from '@/templates'");
    // The generated module must be deterministic JSON-safe content.
    expect(ts).toContain('"id": "billing"');
  });
});
