// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest';
import {
  BUILTIN_EMIT_TARGETS,
  EMIT_TARGETS,
  isEmitTarget,
  setEmitTargets,
  type EmitTarget,
} from '@/shared/emitTargets';
import { compileTargets } from '@/ai/assistantTools';
import { wizardTargets } from '@/export/generateProjectWizard';
import { langExt } from '@/editor/editor';

// EMIT_TARGETS is the single front-end source of truth for the emit-target set (issue #282): the
// picker, the generate-project wizard, the Generated-tab labels and the assistant's compile-tool
// enum all DERIVE from it instead of re-declaring the list. These tests pin the built-in set and
// assert each derived surface agrees on the same ids in the same order, so a re-hardcoded list
// (the old drift) fails the build. (The inspector's Generated-tab label derives from EMIT_TARGETS
// inline too; it isn't asserted here only to avoid importing the heavy `inspectorController` tree.)
describe('EMIT_TARGETS', () => {
  test('the built-ins list the targets with display name + file extension, in display order', () => {
    expect(BUILTIN_EMIT_TARGETS).toEqual([
      { id: 'csharp', displayName: 'C#', fileExtension: '.cs' },
      { id: 'typescript', displayName: 'TypeScript', fileExtension: '.ts' },
      { id: 'python', displayName: 'Python', fileExtension: '.py' },
      { id: 'php', displayName: 'PHP', fileExtension: '.php' },
      { id: 'rust', displayName: 'Rust', fileExtension: '.rs' },
      { id: 'asyncapi', displayName: 'AsyncAPI', fileExtension: '.yaml' },
      { id: 'openapi', displayName: 'OpenAPI', fileExtension: '.yaml' },
    ]);
  });

  const ids = BUILTIN_EMIT_TARGETS.map((t) => t.id);

  test('the assistant compile-target enum derives from EMIT_TARGETS (same ids, same order)', () => {
    expect(compileTargets()).toEqual(ids);
  });

  test('the generate-project wizard targets derive from EMIT_TARGETS (same ids, same order)', () => {
    expect(wizardTargets().map((t) => t.value)).toEqual(ids);
  });
});

// The list is SEEDED at boot from the backend capability query (koine/emitTargets); the built-ins are
// the offline fallback. A target the backend reports but Studio has no CodeMirror mode for must still
// be offered (and preview unhighlighted), and a failed fetch must degrade to the built-ins.
describe('setEmitTargets (backend seeding, issue #282)', () => {
  afterEach(() => setEmitTargets(null)); // restore the built-ins so tests stay independent.

  const GO: EmitTarget = { id: 'go', displayName: 'Go', fileExtension: '.go' };

  test('a fetched list (incl. an unknown target) becomes the active list and is offered everywhere', () => {
    setEmitTargets([...BUILTIN_EMIT_TARGETS, GO]);

    expect(EMIT_TARGETS.map((t) => t.id)).toEqual([...BUILTIN_EMIT_TARGETS.map((t) => t.id), 'go']);
    expect(isEmitTarget('go')).toBe(true);
    // The wizard (a derived surface) offers it too.
    expect(wizardTargets().map((t) => t.value)).toContain('go');
  });

  test('an unknown target with no bundled CodeMirror mode previews as plain (unhighlighted) text', () => {
    setEmitTargets([...BUILTIN_EMIT_TARGETS, GO]);
    // langExt falls back to [] (no highlighting) for a target it has no mode for, rather than throwing.
    expect(langExt('go')).toEqual([]);
  });

  test('a failed / empty fetch falls back to the built-in list', () => {
    setEmitTargets([...BUILTIN_EMIT_TARGETS, GO]);
    setEmitTargets(null); // the boot path calls this on reject.

    expect(EMIT_TARGETS).toEqual(BUILTIN_EMIT_TARGETS);
    expect(isEmitTarget('go')).toBe(false);
  });
});
