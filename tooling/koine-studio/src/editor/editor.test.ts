// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { langExt, type OutputLang } from '@/editor/editor';

// `langExt` maps an OutputLang to the CodeMirror extension that highlights it. Every real target
// must resolve to a non-empty extension (so the output viewer highlights it); only 'plain' opts out
// with an empty extension. A non-array extension object (StreamLanguage/LanguageSupport) is non-empty
// by construction; the only "empty" shape is the `[]` returned for 'plain'.
function isEmptyExtension(ext: ReturnType<typeof langExt>): boolean {
  return Array.isArray(ext) && ext.length === 0;
}

describe('langExt', () => {
  const highlighted: OutputLang[] = ['csharp', 'typescript', 'python', 'php', 'rust'];

  it.each(highlighted)('returns a non-empty highlighting extension for %s', (lang) => {
    expect(isEmptyExtension(langExt(lang))).toBe(false);
  });

  it('returns an empty extension for plain text', () => {
    expect(isEmptyExtension(langExt('plain'))).toBe(true);
  });
});
