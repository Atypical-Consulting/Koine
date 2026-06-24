// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { EMIT_TARGETS } from '@/shared/emitTargets';
import { PREVIEW_TARGETS } from '@/settings/persistence';
import { COMPILE_TARGETS } from '@/ai/assistantTools';
import { TARGETS as WIZARD_TARGETS } from '@/export/generateProjectWizard';

// EMIT_TARGETS is the single front-end source of truth for the emit-target set (issue #282): the
// picker, the generate-project wizard, the Generated-tab labels and the assistant's compile-tool
// enum all DERIVE from it instead of re-declaring the list. These tests pin the built-in set and
// assert each derived surface agrees on the same ids in the same order, so a re-hardcoded list
// (the old drift) fails the build. (The inspector's `LANGS` derives from EMIT_TARGETS inline too;
// it isn't asserted here only to avoid importing the heavy `inspectorController` dependency tree.)
describe('EMIT_TARGETS', () => {
  test('lists the five built-in targets with display name + file extension, in display order', () => {
    expect(EMIT_TARGETS).toEqual([
      { id: 'csharp', displayName: 'C#', fileExtension: '.cs' },
      { id: 'typescript', displayName: 'TypeScript', fileExtension: '.ts' },
      { id: 'python', displayName: 'Python', fileExtension: '.py' },
      { id: 'php', displayName: 'PHP', fileExtension: '.php' },
      { id: 'rust', displayName: 'Rust', fileExtension: '.rs' },
    ]);
  });

  const ids = EMIT_TARGETS.map((t) => t.id);

  test('the settings PREVIEW_TARGETS list derives from EMIT_TARGETS (same ids, same order)', () => {
    expect([...PREVIEW_TARGETS]).toEqual(ids);
  });

  test('the assistant COMPILE_TARGETS enum derives from EMIT_TARGETS (same ids, same order)', () => {
    expect([...COMPILE_TARGETS]).toEqual(ids);
  });

  test('the generate-project wizard targets derive from EMIT_TARGETS (same ids, same order)', () => {
    expect(WIZARD_TARGETS.map((t) => t.value)).toEqual(ids);
  });
});
