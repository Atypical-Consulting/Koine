// @vitest-environment node
//
// Pinned to the `node` environment (rather than the package default `happy-dom` — see
// vite.config.ts's `test.environment`, added for the DOM primitives in issue #905 Task 3):
// this test reads tokens.css straight off disk via `import.meta.url` + node:fs, which needs a
// real file:// URL. happy-dom's `import.meta.url` is not of scheme file and breaks
// fileURLToPath() below.
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the --koi-* design-token relocation (issue #905, Task 2): tokens.css is now the single
// source of truth for the runtime CSS custom properties Koine Studio (and any other consumer) reads
// via var(...). This is a plain string check — the file is plain CSS, not a stylesheet the DOM parses
// in this Node test environment — so it just proves the core tokens made the move byte-for-byte.
const tokensCssPath = fileURLToPath(new URL('./tokens.css', import.meta.url));

describe('tokens.css', () => {
  const css = readFileSync(tokensCssPath, 'utf8');

  test('defines the default (dark) theme tokens on :root', () => {
    expect(css).toContain('--koi-fg:');
    expect(css).toContain('--koi-muted:');
    expect(css).toContain('--koi-accent:');
  });

  test('redefines the theme tokens for light mode under html[data-theme=\'light\']', () => {
    expect(css).toContain("html[data-theme='light']");
    expect(css).toContain('--koi-fg: #1c2230;');
  });

  test('defines the theme-independent DDD-construct hue tokens', () => {
    expect(css).toContain('--koi-ddd-aggregate:');
    expect(css).toContain('--koi-ddd-entity:');
  });
});
