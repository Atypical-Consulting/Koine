import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { downloadBytes } from '@/host/browser/fs';

// Regression guard for #623: the browser-host download helper (`triggerDownload`, feeding both
// `downloadBytes` and `downloadFile`) must NOT revoke the blob object-URL synchronously after
// `a.click()` — that races the browser's deferred blob fetch and cancels the download on
// Firefox/Safari. It must instead attach the anchor to the DOM and defer `revokeObjectURL` +
// `a.remove()` to a later macrotask. happy-dom ships no `URL.createObjectURL`/`revokeObjectURL`,
// so we install mocks for the duration of the test; `HTMLAnchorElement.prototype.click` is stubbed
// so the (un-navigable) download never actually fires and we can observe DOM/ordering instead.
describe('triggerDownload (browser-host download helper, #623)', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi.fn(() => 'blob:mock-url');
    revokeObjectURL = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
    document.body.querySelectorAll('a[download]').forEach((a) => a.remove());
  });

  it('attaches the anchor to document.body before click() and never revokes synchronously', () => {
    let anchorInBodyAtClick: boolean | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        // The anchor must be live in the document at the moment the browser reads it.
        anchorInBodyAtClick = document.body.contains(this);
      });

    downloadBytes('export.zip', new Uint8Array([1, 2, 3]), 'application/zip');

    // (a) the anchor is mounted in the DOM when click() fires.
    expect(anchorInBodyAtClick).toBe(true);
    // (b) the object-URL is NOT revoked synchronously during the call — that is the bug that
    //     cancels the download on Firefox/Safari.
    expect(revokeObjectURL).not.toHaveBeenCalled();

    // The deferred macrotask revokes the URL and removes the anchor (no leak on Chromium).
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    expect(document.body.querySelector('a[download]')).toBeNull();

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(clickSpy).toHaveBeenCalledOnce();
  });
});
