// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { langExt, type OutputLang } from '@/editor/editor';
import { basename } from '@/shared/path';

// `langExt` maps an OutputLang to the CodeMirror extension that highlights it. Every real target
// must resolve to a non-empty extension (so the output viewer highlights it); only 'plain' opts out
// with an empty extension. A non-array extension object (StreamLanguage/LanguageSupport) is non-empty
// by construction; the only "empty" shape is the `[]` returned for 'plain'.
function isEmptyExtension(ext: ReturnType<typeof langExt>): boolean {
  return Array.isArray(ext) && ext.length === 0;
}

describe('langExt', () => {
  const highlighted: OutputLang[] = ['csharp', 'typescript', 'python', 'php', 'rust', 'java', 'kotlin'];

  it.each(highlighted)('returns a non-empty highlighting extension for %s', (lang) => {
    expect(isEmptyExtension(langExt(lang))).toBe(false);
  });

  it('returns an empty extension for plain text', () => {
    expect(isEmptyExtension(langExt('plain'))).toBe(true);
  });
});

// Characterization tests for the default uriLabel behaviour (issue #793).
// The inline default `(uri: string) => uri.split('/').pop() ?? uri` is replaced by `basename`.
// These tests pin the current behaviour so the migration can be verified as zero-change.
describe('default uriLabel behaviour (basename parity)', () => {
  // Old default: (uri: string) => uri.split('/').pop() ?? uri
  const oldDefault = (uri: string): string => uri.split('/').pop() ?? uri;

  const cases: [string, string][] = [
    ['a/b/billing.koi', 'billing.koi'],
    ['workspace/domain/Order.koi', 'Order.koi'],
    ['Order.koi', 'Order.koi'],
    ['file:///home/user/project/main.koi', 'main.koi'],
  ];

  it.each(cases)('basename(%s) equals oldDefault(%s)', (uri, expected) => {
    expect(oldDefault(uri)).toBe(expected);
    expect(basename(uri)).toBe(expected);
  });

  it('the default label falls back to basename when uriLabel is not provided', () => {
    // Mirrors the production expression: opts.uriLabel ?? basename
    const opts: { uriLabel?: (uri: string) => string } = {};
    const label = opts.uriLabel ?? basename;
    expect(label('any/path/file.koi')).toBe('file.koi');
  });

  it('explicit uriLabel wins over the default when provided', () => {
    const explicitLabel = (_uri: string) => 'custom-label';
    const opts: { uriLabel?: (uri: string) => string } = { uriLabel: explicitLabel };
    const label = opts.uriLabel ?? basename;
    expect(label('any/path/file.koi')).toBe('custom-label');
  });
});
