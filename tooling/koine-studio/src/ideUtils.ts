// Pure helper functions extracted from ide.ts. These are module-scope stateless utilities with
// no side-effects, no DOM access, and no host-platform dependency — safe to import anywhere and
// to test in a plain Node/vitest environment.
import { type CheckResult, type ContextMapResult, type LspDiagnostic, type Range } from '@/lsp/lsp';
import { type ShortcutRow } from '@/shared/help';

/**
 * Build a file:// uri from an absolute path. Each non-empty segment is percent-encoded.
 * A Windows drive path ('C:\…') is normalised to forward slashes and gets a 'file:///'
 * prefix; POSIX absolute paths get 'file://' + the encoded path so the leading slash
 * yields the canonical triple-slash form.
 */
export function pathToFileUri(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    // Windows: C:\a\b -> file:///C:/a/b
    const parts = path.replace(/\\/g, '/').split('/').filter((s) => s.length > 0);
    const drive = parts.shift()!; // 'C:'
    const tail = parts.map((s) => encodeURIComponent(s)).join('/');
    return 'file:///' + drive + (tail ? '/' + tail : '');
  }
  const encoded = path
    .split('/')
    .map((s) => (s.length ? encodeURIComponent(s) : ''))
    .join('/');
  return 'file://' + encoded;
}

/**
 * Best-effort inverse of {@link pathToFileUri}: turn a `file://` uri back into an absolute path
 * token suitable for `platform.readTextFile`/`ensureBuffer`. Returns null for a non-`file://` uri.
 * A Windows drive uri ('file:///C:/a/b') yields 'C:/a/b'; a POSIX uri ('file:///a/b') yields '/a/b'.
 * Used only on the cold "file not yet open" navigation path — when the file is already an open
 * buffer the uri matches a `buffers` key directly and this is never reached.
 */
export function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  let rest = uri.slice('file://'.length);
  // Strip an authority/empty-host segment: 'file:///a' -> '/a' leaves a leading '/'.
  if (rest.startsWith('/')) {
    // keep the leading slash for POSIX; a Windows drive ('/C:/…') sheds it below.
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    decoded = rest;
  }
  // Windows: '/C:/a/b' -> 'C:/a/b'.
  if (/^\/[A-Za-z]:\//.test(decoded)) return decoded.slice(1);
  return decoded;
}

/**
 * Whether a relPath from an (untrusted) share link is safe to materialize to disk or key a buffer
 * by. Rejects an absolute path, a backslash separator, an empty segment (covers leading/trailing/
 * double slashes), and any `..` traversal SEGMENT — but not a substring `..` (a legitimate
 * `My..Context.koi` is fine), mirroring the buildSourceZip/buildProjectZip guard.
 */
export function isSafeShareRelPath(relPath: string): boolean {
  if (relPath === '' || relPath.includes('\\')) return false;
  return relPath.split('/').every((s) => s !== '' && s !== '..');
}

// --- context-map rendering (mirrors koine-textmate's renderContextMap) -------

export function renderContextMapHtml(res: ContextMapResult): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts: string[] = ['<h2>Contexts</h2>'];

  if (!res.contexts.length) {
    parts.push('<p class="muted">No contexts.</p>');
  } else {
    parts.push('<ul>' + res.contexts.map((c) => `<li>${esc(c)}</li>`).join('') + '</ul>');
  }

  parts.push('<h2>Relations</h2>');
  if (!res.relations.length) {
    parts.push('<p class="muted">No context map declared.</p>');
  } else {
    const rows = res.relations
      .map((r) => {
        const direction = r.bidirectional ? '&lt;-&gt;' : '-&gt;';
        const shared = r.sharedTypes.length ? esc(r.sharedTypes.join(', ')) : '—';
        const acl = r.acl.length
          ? r.acl
              .map(
                (a) =>
                  `${esc(a.upstreamContext)}.${esc(a.upstreamType)} → ${esc(a.localContext)}.${esc(a.localType)}`,
              )
              .join('<br>')
          : '—';
        return (
          '<tr>' +
          `<td>${esc(r.upstream)}</td>` +
          `<td class="dir">${direction}</td>` +
          `<td>${esc(r.downstream)}</td>` +
          `<td>${esc(r.kind)}</td>` +
          `<td>${shared}</td>` +
          `<td>${acl}</td>` +
          '</tr>'
        );
      })
      .join('');
    parts.push(
      '<table class="ctxmap"><thead><tr>' +
        '<th>Upstream</th><th>Direction</th><th>Downstream</th><th>Kind</th><th>Shared Types</th><th>ACL</th>' +
        '</tr></thead><tbody>' +
        rows +
        '</tbody></table>',
    );
  }
  return parts.join('\n');
}

// --- compatibility-check rendering (mirrors koine-textmate's renderCheck) -----

export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function renderCheckMarkdown(res: CheckResult): string {
  const out: string[] = [];
  out.push(res.hasBreakingChanges ? '# ⚠️ Breaking changes detected' : '# ✅ No breaking changes');
  out.push('');

  const breaking = res.changes.filter((c) => c.impact === 'Breaking').length;
  const nonBreaking = res.changes.length - breaking;
  out.push(`${res.changes.length} change(s): ${breaking} breaking, ${nonBreaking} non-breaking.`, '');

  if (res.changes.length === 0) {
    out.push('_No changes detected._', '');
  } else {
    out.push('| Impact | Code | Message |', '| --- | --- | --- |');
    for (const c of res.changes) {
      out.push(`| ${escapeCell(c.impact)} | ${escapeCell(c.code)} | ${escapeCell(c.message)} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

// The active file's diagnostics that intersect a 0-based request range, so a code-action request is
// scoped to the cursor/selection (otherwise the quickfix menu would offer "did you mean" fixes for
// unrelated typos elsewhere in the file, and applying one would edit an off-screen region).
export function diagnosticsInRange(diags: LspDiagnostic[], range: Range): LspDiagnostic[] {
  const lte = (a: { line: number; character: number }, b: { line: number; character: number }): boolean =>
    a.line < b.line || (a.line === b.line && a.character <= b.character);
  return diags.filter((d) => lte(d.range.start, range.end) && lte(range.start, d.range.end));
}

// Keyboard shortcuts shown in the help overlay; mirrors the global keydown handler and the
// palette command hints. 'mod' renders as a keycap as-is (Cmd on mac / Ctrl elsewhere).
export function helpRows(): ShortcutRow[] {
  return [
    { keys: 'mod+K', description: 'Command palette' },
    { keys: 'mod+S', description: 'Save / format the active model' },
    { keys: 'mod+Alt+S', description: 'Save all unsaved files' },
    { keys: 'mod+Shift+O', description: 'Open a folder of models' },
    { keys: 'mod+N', description: 'New model' },
    { keys: 'F2', description: 'Rename symbol' },
    { keys: 'Shift+F12', description: 'Find all references' },
    { keys: 'mod+.', description: 'Quick fixes & refactors' },
    { keys: 'mod+,', description: 'Settings' },
    { keys: 'mod+B', description: 'Toggle file tree' },
    { keys: 'F1', description: 'Keyboard shortcuts' },
    { keys: 'Esc', description: 'Close the open overlay' },
  ];
}
