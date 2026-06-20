import { afterEach, describe, expect, it } from 'vitest';
import { buildShareUrl, buildWorkspaceShareUrl, readModelFromHash } from './share';

// readModelFromHash reads window.location.hash; set it via jsdom and reset after each test.
function setHash(hash: string): void {
  window.location.hash = hash;
}

function hashOf(url: string): string {
  const i = url.indexOf('#');
  return i < 0 ? '' : url.slice(i);
}

afterEach(() => {
  setHash('');
});

describe('readModelFromHash — single-string round-trip', () => {
  it('decodes a model encoded with buildShareUrl to { kind: "single", text }', () => {
    const source = 'context Billing {\n  value Money { amount: Decimal }\n}\n';
    setHash(hashOf(buildShareUrl(source)));

    const payload = readModelFromHash();

    expect(payload).toEqual({ kind: 'single', text: source });
  });
});

describe('readModelFromHash — legacy back-compat', () => {
  it('decodes a legacy #model=<base64 raw .koi> (no JSON) to { kind: "single", text }', () => {
    // buildShareUrl encodes raw source (not JSON), exactly how legacy links were produced.
    const legacySource = 'context Legacy {\n  entity Order { id: Guid }\n}\n';
    setHash(hashOf(buildShareUrl(legacySource)));

    const payload = readModelFromHash();

    expect(payload).toEqual({ kind: 'single', text: legacySource });
  });

  it('treats decoded JSON that is not a workspace shape as a single-string model', () => {
    // A .koi source that happens to be valid JSON (an array) must NOT be read as a workspace.
    const jsonishSource = '[1, 2, 3]';
    setHash(hashOf(buildShareUrl(jsonishSource)));

    const payload = readModelFromHash();

    expect(payload).toEqual({ kind: 'single', text: jsonishSource });
  });

  it('treats a decoded object without a valid files[] as a single-string model', () => {
    const jsonishSource = '{ "model": "not a workspace" }';
    setHash(hashOf(buildShareUrl(jsonishSource)));

    const payload = readModelFromHash();

    expect(payload).toEqual({ kind: 'single', text: jsonishSource });
  });
});

describe('readModelFromHash — workspace round-trip', () => {
  it('round-trips buildWorkspaceShareUrl(files, active) to { kind: "workspace", files, active }', () => {
    const files = [
      { relPath: 'a.koi', text: 'context A {}' },
      { relPath: 'sub/b.koi', text: 'context B {}' }
    ];
    setHash(hashOf(buildWorkspaceShareUrl(files, 'sub/b.koi')));

    const payload = readModelFromHash();

    expect(payload).toEqual({ kind: 'workspace', files, active: 'sub/b.koi' });
  });

  it('round-trips a workspace without an active file', () => {
    const files = [{ relPath: 'only.koi', text: 'context Only {}' }];
    setHash(hashOf(buildWorkspaceShareUrl(files)));

    const payload = readModelFromHash();

    expect(payload).toEqual({ kind: 'workspace', files });
  });
});

describe('readModelFromHash — malformed / empty', () => {
  it('returns null for an empty hash', () => {
    setHash('');
    expect(readModelFromHash()).toBeNull();
  });

  it('returns null (no throw) for garbage base64', () => {
    setHash('#model=!!!not-base64!!!');
    expect(readModelFromHash()).toBeNull();
  });

  it('returns null when the model param is absent', () => {
    setHash('#other=abc');
    expect(readModelFromHash()).toBeNull();
  });
});
