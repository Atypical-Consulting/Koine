// @vitest-environment happy-dom
// The editor font stack (Settings → Appearance → Editor font, #750) is applied like the other
// <html>-level appearance metrics: a CSS custom property the CodeMirror theme reads. A non-empty
// stack pins `--koi-editor-font-family`; an empty value removes it so the theme's default mono font
// (var(--koi-font-mono)) wins again.
import { describe, expect, it, beforeEach } from 'vitest';
import { applyAppearance, applyEditorFont } from '@/settings/appearance';
import { DEFAULT_SETTINGS } from '@/settings/persistence';

const fontVar = (): string => document.documentElement.style.getPropertyValue('--koi-editor-font-family');

beforeEach(() => {
  document.documentElement.removeAttribute('style');
});

describe('appearance: editor font family (#750)', () => {
  it('applyAppearance sets --koi-editor-font-family when a font stack is configured', () => {
    applyAppearance({ ...DEFAULT_SETTINGS, fontFamily: 'JetBrains Mono, monospace' });
    expect(fontVar()).toContain('JetBrains Mono');
  });

  it('an empty fontFamily removes the override so the theme mono font wins', () => {
    applyEditorFont('JetBrains Mono');
    expect(fontVar()).toContain('JetBrains Mono');
    applyEditorFont('');
    expect(fontVar()).toBe('');
  });
});
