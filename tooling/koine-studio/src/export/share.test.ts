import { afterEach, describe, expect, it } from 'vitest';
import {
  buildShareUrl,
  buildWorkspaceShareUrl,
  MAX_SHARE_HASH_LEN,
  readModelFromHash,
  workspaceShareUrlOrNull
} from '@/export/share';

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

describe('workspaceShareUrlOrNull — URL-length guard', () => {
  // The guard measures the full `#model=<base64>` fragment against MAX_SHARE_HASH_LEN.
  function fragmentOf(url: string): string {
    const i = url.indexOf('#');
    return i < 0 ? '' : url.slice(i);
  }

  it('returns a shareable URL when the encoded fragment is just under the cap', () => {
    // ~5000 chars of source ⇒ base64-of-JSON fragment well under the 8000-char cap.
    const files = [{ relPath: 'a.koi', text: 'x'.repeat(5000) }];

    const url = workspaceShareUrlOrNull(files, 'a.koi');

    expect(url).not.toBeNull();
    // Sanity: the returned link's fragment really is within the cap.
    expect(fragmentOf(url as string).length).toBeLessThanOrEqual(MAX_SHARE_HASH_LEN);
    // And it round-trips back to the same workspace.
    expect(url as string).toBe(buildWorkspaceShareUrl(files, 'a.koi'));
  });

  it('returns null (no broken link) when the encoded fragment exceeds the cap', () => {
    // ~7000 chars of source ⇒ base64 inflates it past the 8000-char fragment cap.
    const files = [{ relPath: 'big.koi', text: 'y'.repeat(7000) }];

    // Guard rejects it…
    expect(workspaceShareUrlOrNull(files, 'big.koi')).toBeNull();
    // …and the bare builder confirms the fragment really is over the cap (the guard isn't lying).
    expect(fragmentOf(buildWorkspaceShareUrl(files, 'big.koi')).length).toBeGreaterThan(
      MAX_SHARE_HASH_LEN
    );
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
