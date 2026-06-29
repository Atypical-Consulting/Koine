// Structural guard for the topbar ↔ status-bar single-home contract (#756; see
// docs/shell-bars-contract.md). Koine Studio has two horizontal chrome strips — the topbar
// (`#toolbar`) and the bottom status bar (`#statusbar`) — and the contract pins which bar owns which
// fact so a new indicator can't silently drift into the wrong one (or get mirrored into both), the
// failure mode #756 was opened to prevent:
//
//   • Status bar (#statusbar) owns PERSISTENT AMBIENT STATE read passively — context, validity,
//     problems, compiling/busy, connection, version.
//   • Topbar (#toolbar) owns ACTIONS + the transient #status action-feedback pill (the last-action
//     toast: Saved / Renamed X→Y / errors). #status is NOT a connection indicator.
//   • One home per fact — nothing is mirrored across both bars.
//
// This reads the REAL index.html (not a hand-copied fixture) so the assertions track the shipped shell.
// Like splitLayout.test.ts (#527), it is a green-on-correct regression guard: it fails the moment an
// item moves to the wrong bar, is mirrored into both, or the #status pill starts reading as connection.
import { beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let doc: Document;

beforeAll(() => {
  const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
  doc = new DOMParser().parseFromString(html, 'text/html');
});

// Persistent ambient state → the status bar. (The clickable #unsaved-indicator is also a status-bar
// item under the contract, but its placement is asserted by the unsaved-work suites — see the doc.)
const STATUS_BAR_ITEMS = [
  'sb-context',
  'sb-validity',
  'sb-problems-host',
  'sb-compiling-host',
  'sb-connection',
  'sb-version',
];

// Model actions + the transient action-feedback pill → the topbar.
const TOOLBAR_ITEMS = [
  'status',
  'btn-new',
  'btn-open-folder',
  'btn-generate-project',
  'btn-save-project',
  'btn-check',
];

/** An element's OWN text (direct text nodes only), so a container isn't credited with a child's text. */
function directText(elt: Element): string {
  return Array.from(elt.childNodes)
    .filter((n) => n.nodeType === 3 /* TEXT_NODE */)
    .map((n) => n.textContent ?? '')
    .join('');
}

describe('shell bars single-home contract (#756)', () => {
  test('#statusbar owns every persistent ambient-state item, and the topbar does not', () => {
    const statusbar = doc.getElementById('statusbar');
    const toolbar = doc.getElementById('toolbar');
    expect(statusbar, '#statusbar must exist').not.toBeNull();
    expect(toolbar, '#toolbar must exist').not.toBeNull();

    for (const id of STATUS_BAR_ITEMS) {
      const elt = doc.getElementById(id);
      expect(elt, `#${id} must exist in the shell`).not.toBeNull();
      expect(statusbar!.contains(elt!), `#${id} must live in #statusbar`).toBe(true);
      expect(toolbar!.contains(elt!), `#${id} must NOT also be in #toolbar (no mirroring)`).toBe(false);
    }
  });

  test('#toolbar owns the model-action buttons and the transient #status pill, and the status bar does not', () => {
    const toolbar = doc.getElementById('toolbar');
    const statusbar = doc.getElementById('statusbar');
    expect(toolbar, '#toolbar must exist').not.toBeNull();
    expect(statusbar, '#statusbar must exist').not.toBeNull();

    for (const id of TOOLBAR_ITEMS) {
      const elt = doc.getElementById(id);
      expect(elt, `#${id} must exist in the shell`).not.toBeNull();
      expect(toolbar!.contains(elt!), `#${id} must live in #toolbar`).toBe(true);
      expect(statusbar!.contains(elt!), `#${id} must NOT also be in #statusbar (no mirroring)`).toBe(false);
    }
  });

  test('connection text has a single home — only #sb-connection reads as connection across both bars', () => {
    // The crux of #756: the #status pill must not impersonate the connection indicator. Scan both bars
    // for any element whose OWN text reads as a connection state; exactly one (#sb-connection) may.
    const bars = [doc.getElementById('toolbar')!, doc.getElementById('statusbar')!];
    const connectionEls = bars
      .flatMap((bar) => Array.from(bar.querySelectorAll('*')))
      .filter((elt) => /connect/i.test(directText(elt)));
    expect(connectionEls.map((e) => e.id)).toEqual(['sb-connection']);
  });
});
