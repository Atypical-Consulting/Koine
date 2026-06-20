// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the tabbed inspector (emitted preview,
// glossary, and context map).
import { createKoineEditor, createOutputView, renderMarkdown, renderSymbolTree, setEditorDiagnostics } from './editor';
import {
  KoineLsp,
  SCRATCH_URI,
  type CheckResult,
  type ContextMapResult,
  type GlossaryEntry,
  type Location,
  type LspDiagnostic,
  type Range,
  type TextEdit,
  type WorkspaceEdit,
} from './lsp';
import { getPlatform, type FsEntry, type KoiFile } from './host';
import { createExplorer } from './explorer';
import { koineMark } from './logo';
import { currentTheme, initTheme, onThemeChange, toggleTheme } from './theme';
import { clearScratch, initSecrets, loadScratch, loadSettings, pushRecentFolder, saveScratch, type Settings } from './store';
import { createWelcome } from './welcome';
import { type Example } from './examples';
import { createCommandPalette, type Command } from './palette';
import { createPreferences } from './prefs';
import { applyAppearance } from './appearance';
import { initSplitResizer, initEdgeResizer } from './resize';
import { createHelpOverlay, type ShortcutRow } from './help';
import { createAboutDialog } from './about';
import { createGenerateProject } from './generateProjectWizard';
import { formatChord } from './platform';
import { renderDiagrams } from './diagrams';
import { renderGlossary, type GlossaryHandlers } from './glossary';
import { createAssistantPanel, type AssistantPanel } from './aiPanel';
import { buildShareUrl, clearModelHash, readModelFromHash } from './share';
import { dirtyBuffers, dirtyCount, saveAllDirtyBuffers, titleWithDirty } from './dirty';
import { createConfirmDialog } from './overlay';

// --- workspace fs contract ---------------------------------------------------
// `KoiFile` (path / name / relPath) is provided by the host platform layer (src/host), whose
// backends supply it from the native filesystem (desktop) or the File System Access API (browser).

/** A client-side open buffer keyed by its file:// uri. `path` is null in scratch mode. */
interface Buffer {
  uri: string;
  path: string | null;
  relPath: string;
  name: string;
  text: string;
  dirty: boolean;
}

/**
 * Build a file:// uri from an absolute path. Each non-empty segment is percent-encoded.
 * A Windows drive path ('C:\…') is normalised to forward slashes and gets a 'file:///'
 * prefix; POSIX absolute paths get 'file://' + the encoded path so the leading slash
 * yields the canonical triple-slash form.
 */
function pathToFileUri(path: string): string {
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

// Seed model — examples/billing.koi, inlined (the renderer has no fs access).
const SEED = `context Billing {

  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0        "a monetary amount cannot be negative"
  }

  enum Currency { EUR, USD, GBP }

  value Email {
    raw: String
    invariant raw matches /^[^@]+@[^@]+$/   "invalid email address"
  }

  entity Customer identified by CustomerId {
    name: String
    email: Email
  }

  aggregate Order root Order {

    enum OrderStatus { Draft, Placed, Shipped, Cancelled }

    value OrderLine {
      product:   ProductId
      quantity:  Int
      unitPrice: Money
      subtotal:  Money = unitPrice * quantity
    }

    entity Order identified by OrderId {
      customer: CustomerId
      lines:    List<OrderLine>
      status:   OrderStatus = Draft
      invariant status == Draft when lines.isEmpty
    }
  }
}
`;

// What "New" opens: a clean, valid, empty bounded context — NOT the Billing SEED. "New" means a
// fresh canvas; loading a full sample is the welcome screen's example gallery's job, not this one's.
// An empty-bodied context is valid Koine (the same shape `koine init` and the LSP tests use).
const BLANK = `context NewModel {

  // Describe your bounded context here — add value objects, entities, and aggregates.

}
`;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

// --- context-map rendering (mirrors koine-textmate's renderContextMap) -------

function renderContextMapHtml(res: ContextMapResult): string {
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

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderCheckMarkdown(res: CheckResult): string {
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
function diagnosticsInRange(diags: LspDiagnostic[], range: Range): LspDiagnostic[] {
  const lte = (a: { line: number; character: number }, b: { line: number; character: number }): boolean =>
    a.line < b.line || (a.line === b.line && a.character <= b.character);
  return diags.filter((d) => lte(d.range.start, range.end) && lte(range.start, d.range.end));
}

type RightView = 'preview' | 'glossary' | 'diagrams' | 'contextmap' | 'outline' | 'assistant' | 'check';

// Keyboard shortcuts shown in the help overlay; mirrors the global keydown handler and the
// palette command hints. 'mod' renders as a keycap as-is (Cmd on mac / Ctrl elsewhere).
function helpRows(): ShortcutRow[] {
  return [
    { keys: 'mod+K', description: 'Command palette' },
    { keys: 'mod+S', description: 'Save / format the active model' },
    { keys: 'mod+Shift+O', description: 'Open a folder of models' },
    { keys: 'mod+N', description: 'New scratch model' },
    { keys: 'mod+1', description: 'Preview C#' },
    { keys: 'mod+2', description: 'Preview TypeScript' },
    { keys: 'mod+3', description: 'Preview Python' },
    { keys: 'F2', description: 'Rename symbol' },
    { keys: 'Shift+F12', description: 'Find all references' },
    { keys: 'mod+.', description: 'Quick fixes & refactors' },
    { keys: 'mod+,', description: 'Settings' },
    { keys: 'mod+B', description: 'Toggle file tree (folder mode)' },
    { keys: 'F1', description: 'Keyboard shortcuts' },
    { keys: 'Esc', description: 'Close the open overlay' },
  ];
}

export function init(): void {
  // The host backend: the Tauri desktop shell, or a plain browser (compiler via WASM, files via
  // the File System Access API). Everything host-specific — the LSP transport, folder/file I/O,
  // dialogs, the app version — goes through this.
  const platform = getPlatform();

  // Decrypt the assistant API key into store.ts's in-memory cache (and migrate any legacy plaintext
  // key out of localStorage). Fire-and-forget: nothing at boot needs the key synchronously — the
  // assistant reads it lazily per request, long after this resolves.
  void initSecrets();

  // Render the header monogram from the shared template ('h' = a stable gradient id) so the welcome,
  // about, and header marks all flow from logo.ts and can't drift apart on the next tweak.
  const brandLogo = document.querySelector('.brand-logo');
  if (brandLogo) brandLogo.innerHTML = koineMark('h');

  // Apply the persisted theme + appearance (accent, reduced motion, editor metrics) before
  // CodeMirror is created so the editor picks up the right tokens / size on first paint.
  initTheme();
  let settings: Settings = loadSettings();
  applyAppearance(settings);

  // A model carried in the URL hash (a shared playground link) takes precedence over both the seed
  // and any restored scratch, so opening a link always lands on the shared model.
  const sharedModel = readModelFromHash();
  // Session restore: if the user has unsaved scratch work from a previous visit, open that instead
  // of the seed (and skip the welcome screen — see the boot section). Folder workspaces are not
  // restored; they live on disk and are re-opened explicitly.
  const restoredScratch = loadScratch();
  const initialDoc = sharedModel ?? restoredScratch ?? SEED;

  const editor = createKoineEditor({
    parent: el('editor-pane'),
    doc: initialDoc,
    lineWrap: settings.wordWrap,
    onChange: (doc) => {
      // First edit dismisses the welcome overlay (it only shows in untouched scratch mode).
      if (welcome.visible) welcome.hide();
      const buf = buffers.get(activeUri);
      let becameDirty = false;
      if (buf) {
        if (buf.path != null && !buf.dirty && buf.text !== doc) becameDirty = true;
        buf.text = doc;
        if (becameDirty) buf.dirty = true;
      }
      lsp.changeDoc(activeUri, doc);
      onDocEdited();
      // Persist the scratch buffer (debounced) so a reload restores it.
      if (!folderMode && activeUri === SCRATCH_URI) scheduleScratchSave(doc);
      // Re-render the tree only when the active file's dirty dot just appeared (cheap path).
      if (folderMode && becameDirty) renderTree();
    },
    onHover: (line, character) => lsp.hover(line, character),
    onCompletion: (line, character) => lsp.completion(line, character),
    onDefinition: (line, character) => lsp.definition(line, character),
    onNavigate: (loc) => navigateToDefinition(loc),
    // Refactors + quick fixes (F2 rename, Shift-F12 references, Mod-. code actions). The editor
    // owns the in-editor widgets; ide.ts resolves the data and applies the resulting edits.
    onPrepareRename: (line, character) => lsp.prepareRename(line, character),
    onRename: (line, character, newName) => lsp.rename(line, character, newName),
    onReferences: (line, character) => lsp.references(line, character),
    onNavigateLocation: (loc) => navigateToDefinition(loc),
    uriLabel: (uri) => buffers.get(uri)?.relPath ?? (uri.split('/').pop() ?? uri),
    onCodeActions: (range) => lsp.codeActions(range, diagnosticsInRange(diagnosticsByUri.get(activeUri) ?? [], range)),
    onApplyWorkspaceEdit: (edit) => applyWorkspaceEdit(edit),
    // Save (Cmd/Ctrl-S) is owned by ide.ts's window keydown handler below: it formats AND
    // writes the active buffer to disk. We deliberately do NOT pass onFormat here so the
    // editor's Mod-s keymap stays inert and there's exactly one save path.
  });
  const output = createOutputView(el('view-preview'), settings.wordWrap);

  // A copy affordance overlaid on the emitted-preview pane (auto-hidden with the pane when another
  // inspector tab is active). Tracks the most recent generated output; disabled until there is some.
  let lastPreview = '';
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'koi-copy';
  copyBtn.textContent = 'Copy';
  copyBtn.title = 'Copy generated code';
  copyBtn.disabled = true;
  copyBtn.addEventListener('click', () => {
    if (!lastPreview) return;
    void navigator.clipboard
      .writeText(lastPreview)
      .then(() => (copyBtn.textContent = 'Copied ✓'))
      .catch(() => (copyBtn.textContent = 'Copy failed'))
      .finally(() => {
        clearTimeout(copyResetTimer);
        copyResetTimer = setTimeout(() => (copyBtn.textContent = 'Copy'), 1600);
      });
  });
  el('view-preview').appendChild(copyBtn);

  const statusEl = el('status');
  const diagBodyEl = el('diag-body');
  const diagCountEl = el('diag-count');

  // Global unsaved-work surfacing: the document title gains a `•` and a clickable "N unsaved" pill
  // appears beside the status whenever any open buffer is dirty. baseTitle is captured once, clean.
  const baseTitle = document.title;
  const unsavedEl = el('unsaved-indicator') as HTMLButtonElement;
  unsavedEl.addEventListener('click', () => void saveAllDirty());
  function refreshDirtyIndicator(): void {
    const n = dirtyCount(buffers);
    document.title = titleWithDirty(baseTitle, n);
    if (n > 0) {
      unsavedEl.textContent = `${n} unsaved`;
      unsavedEl.setAttribute('aria-label', `Save ${n} unsaved file${n === 1 ? '' : 's'}`);
      unsavedEl.hidden = false;
    } else {
      unsavedEl.textContent = '';
      unsavedEl.hidden = true;
    }
  }

  const lsp = new KoineLsp(platform.createLspTransport());

  // --- workspace model ------------------------------------------------------
  // `buffers` holds every open document keyed by its file:// uri; `activeUri` is the one
  // shown in the editor and targeted by all lsp requests. `diagnosticsByUri` keeps the
  // latest pushed diagnostics per uri so switching files can re-render the active one and
  // the tree can badge files with errors. Scratch mode = a single buffer at SCRATCH_URI
  // with path null; folder mode = one buffer per discovered .koi file.
  const buffers = new Map<string, Buffer>();
  const diagnosticsByUri = new Map<string, LspDiagnostic[]>();
  let activeUri = SCRATCH_URI;
  let folderMode = false;
  // The opened-folder token and the last explorer tree fetched for it. The explorer is a *view*:
  // it renders this cached tree (re-reading dirty/diagnostics/active state via callbacks), while
  // the open .koi `buffers` remain the compiled workspace. Mutations refresh both.
  let folderRootToken: string | null = null;
  let entriesCache: FsEntry[] = [];

  const treeEl = el<HTMLElement>('filetree');
  const treeBodyEl = el<HTMLElement>('filetree-body');
  const treeTitleEl = el<HTMLElement>('filetree-title');
  const treeBtn = el<HTMLButtonElement>('btn-files');
  const splitEl = el<HTMLElement>('split');

  // File-tree chrome (the left rail + its toolbar toggle) only exists in folder mode. Visibility
  // is a persisted user choice; the rail track widens to 6px only when the tree is showing so no
  // stray resize handle appears in scratch mode.
  const FILETREE_VIS_KEY = 'koine.studio.filetree';
  function applyFileTreeVisibility(visible: boolean): void {
    treeEl.hidden = !visible;
    treeBtn.setAttribute('aria-pressed', String(visible));
    splitEl.style.setProperty('--koi-filetree-rail', visible ? '6px' : '0px');
  }
  function showFileTreeChrome(): void {
    treeBtn.hidden = false;
    applyFileTreeVisibility((localStorage.getItem(FILETREE_VIS_KEY) ?? '1') !== '0');
  }
  function hideFileTreeChrome(): void {
    treeBtn.hidden = true;
    treeEl.hidden = true;
    splitEl.style.setProperty('--koi-filetree-rail', '0px');
  }
  function toggleFileTree(): void {
    if (!folderMode) return;
    const visible = Boolean(treeEl.hidden); // currently hidden → reveal
    applyFileTreeVisibility(visible);
    try {
      localStorage.setItem(FILETREE_VIS_KEY, visible ? '1' : '0');
    } catch {
      // ignore — no persistence available
    }
  }

  // The workspace file explorer. It deals in opaque fs tokens; ide.ts maps token ↔ file:// uri
  // (pathToFileUri) to keep `buffers`, `activeUri` and the LSP workspace coherent on every mutation.
  const explorer = createExplorer({
    onOpenFile: (token) => void openFileToken(token),
    onNewFile: (parentDirToken, name) => void handleNewFile(parentDirToken, name),
    onNewFolder: (parentDirToken, name) => void handleNewFolder(parentDirToken, name),
    onRename: (entry, newName) => void handleRename(entry, newName),
    onDelete: (entry) => void handleDelete(entry),
    onDuplicate: (entry) => void handleDuplicate(entry),
    onMove: (entry, destDirToken) => void handleMove(entry, destDirToken),
    isActive: (token) => pathToFileUri(token) === activeUri,
    isDirty: (token) => buffers.get(pathToFileUri(token))?.dirty ?? false,
    diagCounts: (token) => diagCounts(pathToFileUri(token)),
  });
  treeBodyEl.appendChild(explorer.el);

  // Seed the scratch buffer up front so onChange/diagnostics have somewhere to land.
  buffers.set(SCRATCH_URI, {
    uri: SCRATCH_URI,
    path: null,
    relPath: 'model.koi',
    name: 'model.koi',
    text: initialDoc,
    dirty: false,
  });

  // Debounced persistence of the scratch buffer. The seed is treated as "no saved state" so the
  // welcome screen still appears on a fresh reload; any real edit is restored next time.
  let scratchSaveTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleScratchSave(text: string): void {
    clearTimeout(scratchSaveTimer);
    scratchSaveTimer = setTimeout(() => {
      if (text === SEED) clearScratch();
      else saveScratch(text);
    }, 400);
  }

  function setStatus(text: string, kind: 'connecting' | 'green' | 'error'): void {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  }

  function renderStrip(diags: LspDiagnostic[]): void {
    const errors = diags.filter((d) => d.severity === 1 || d.severity == null).length;
    const warnings = diags.filter((d) => d.severity === 2).length;
    if (!errors && !warnings) {
      diagCountEl.textContent = 'clean';
      diagCountEl.dataset.kind = 'clean';
    } else {
      const parts: string[] = [];
      if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
      diagCountEl.textContent = parts.join(' · ');
      diagCountEl.dataset.kind = errors ? 'error' : 'warn';
    }

    diagBodyEl.innerHTML = '';
    if (!diags.length) {
      const span = document.createElement('span');
      span.className = 'diag-empty';
      span.textContent = 'No diagnostics.';
      diagBodyEl.appendChild(span);
      return;
    }
    for (const d of diags) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = d.severity === 2 ? 'diag diag-warn' : 'diag diag-err';
      const line = d.range.start.line + 1;
      const col = d.range.start.character + 1;
      const code = d.code != null ? `${d.code}: ` : '';
      row.textContent = `${d.severity === 2 ? 'warn' : 'error'} ${line}:${col}  ${code}${d.message}`;
      row.addEventListener('click', () => editor.goto(line, col));
      diagBodyEl.appendChild(row);
    }
  }

  function updateStatus(diags: LspDiagnostic[]): void {
    const errors = diags.filter((d) => d.severity === 1 || d.severity == null).length;
    const warnings = diags.filter((d) => d.severity === 2).length;
    if (errors === 0 && warnings === 0) {
      setStatus('green ✓', 'green');
    } else {
      const parts: string[] = [];
      if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
      if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
      setStatus(parts.join(' / '), 'error');
    }
  }

  // Diagnostics are pushed per-uri for every file in the workspace. Store them all; only the
  // ACTIVE file's diagnostics drive the editor gutter, the strip, and the status pill. The
  // tree is re-rendered so non-active files can badge their error/warning counts.
  lsp.onPublishDiagnostics((uri, diags) => {
    diagnosticsByUri.set(uri, diags);
    if (uri === activeUri) {
      setEditorDiagnostics(editor.view, diags);
      renderStrip(diags);
      updateStatus(diags);
    }
    if (folderMode) renderTree();
  });
  lsp.onServerExit((code) => {
    setStatus(`server exited (${code})`, 'error');
  });

  // --- file tree ------------------------------------------------------------

  function diagCounts(uri: string): { errors: number; warnings: number } {
    const diags = diagnosticsByUri.get(uri) ?? [];
    let errors = 0;
    let warnings = 0;
    for (const d of diags) {
      if (d.severity === 2) warnings++;
      else errors++; // severity 1 or unset = error
    }
    return { errors, warnings };
  }

  // Re-render the explorer from the cached entry tree. Cheap to call on any state change (dirty,
  // diagnostics, active file) — the explorer reads those per row via the callbacks. A no-op outside
  // folder mode (the tree is hidden then).
  function renderTree(): void {
    // Sync the global unsaved indicator on every tree render — this is the common path for every
    // dirty transition (edit, save, save-all, cross-file rename, workspace swap), and it runs even
    // in scratch mode (where the early return below skips the file tree) so the pill always clears.
    refreshDirtyIndicator();
    if (!folderMode || folderRootToken == null) return;
    explorer.render(entriesCache, folderRootToken);
  }

  // --- workspace mutations (create / rename / delete / move) -----------------
  // The explorer surfaces user intent as opaque tokens; these handlers do the host fs op, then keep
  // `buffers` / `activeUri` / the LSP workspace coherent and refresh the tree. relPaths handed to
  // the host are always relative to the opened folder (folderRootToken).

  /** The folder-relative, forward-slashed path of a token under the opened folder ('' for the root). */
  function relOfToken(token: string): string {
    if (folderRootToken == null || token === folderRootToken) return '';
    // Require a real separator boundary after the root prefix so a sibling that merely shares the
    // root as a string prefix (e.g. root `/work/app`, token `/work/app2/x`) isn't mis-sliced. Then
    // strip the prefix + separator and normalise Windows '\' to '/'.
    if (token.startsWith(folderRootToken + '/') || token.startsWith(folderRootToken + '\\')) {
      return token.slice(folderRootToken.length + 1).replace(/\\/g, '/');
    }
    return token;
  }

  /** Re-read the folder's entry tree from the host and re-render the explorer. */
  async function refreshEntries(): Promise<void> {
    if (folderRootToken == null) return;
    try {
      entriesCache = await platform.listEntries(folderRootToken);
    } catch (e) {
      console.error('listEntries failed:', e);
    }
    renderTree();
  }

  /** Open a .koi file token as a buffer if it isn't open yet; returns its uri (or null on failure). */
  async function ensureBuffer(token: string): Promise<string | null> {
    const uri = pathToFileUri(token);
    if (buffers.has(uri)) return uri;
    let text: string;
    try {
      text = await platform.readTextFile(token);
    } catch (e) {
      console.error('readTextFile failed for', token, e);
      return null;
    }
    buffers.set(uri, { uri, path: token, relPath: relOfToken(token), name: nameOf(token), text, dirty: false });
    lsp.openDoc(uri, text);
    return uri;
  }

  // Clicking a file row: open it (if needed) and make it the active editor buffer.
  async function openFileToken(token: string): Promise<void> {
    const uri = await ensureBuffer(token);
    if (uri) activateFile(uri);
  }

  async function handleNewFile(parentDirToken: string, name: string): Promise<void> {
    if (folderRootToken == null) return;
    const parentRel = relOfToken(parentDirToken);
    // The explorer only surfaces directories and .koi files, so default an extensionless name to
    // `.koi` — otherwise the created file would be invisible (listEntries filters it out) and the
    // user would think New File silently failed.
    const fileName = name.includes('.') ? name : `${name}.koi`;
    const relPath = parentRel ? `${parentRel}/${fileName}` : fileName;
    try {
      const token = await platform.createFile(folderRootToken, relPath, '');
      await refreshEntries();
      if (token.toLowerCase().endsWith('.koi')) await openFileToken(token);
    } catch (e) {
      setStatus('could not create file', 'error');
      console.error('createFile failed:', e);
    }
  }

  async function handleNewFolder(parentDirToken: string, name: string): Promise<void> {
    if (folderRootToken == null) return;
    const parentRel = relOfToken(parentDirToken);
    const relPath = parentRel ? `${parentRel}/${name}` : name;
    try {
      await platform.createFolder(folderRootToken, relPath);
      await refreshEntries();
    } catch (e) {
      setStatus('could not create folder', 'error');
      console.error('createFolder failed:', e);
    }
  }

  async function handleDelete(entry: FsEntry): Promise<void> {
    try {
      await platform.deleteEntry(entry.token);
    } catch (e) {
      setStatus('could not delete', 'error');
      console.error('deleteEntry failed:', e);
      return;
    }
    // Close every open buffer at or under the deleted token; re-point active if it was one of them.
    let activeRemoved = false;
    for (const buf of [...buffers.values()]) {
      if (buf.path != null && isUnder(buf.path, entry.token)) {
        if (buf.uri === activeUri) activeRemoved = true;
        lsp.closeDoc(buf.uri);
        buffers.delete(buf.uri);
        diagnosticsByUri.delete(buf.uri);
      }
    }
    if (activeRemoved) activateFallback();
    await refreshEntries();
  }

  async function handleRename(entry: FsEntry, newName: string): Promise<void> {
    let newToken: string;
    try {
      newToken = await platform.renameEntry(entry.token, newName);
    } catch (e) {
      setStatus('could not rename', 'error');
      console.error('renameEntry failed:', e);
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
  }

  async function handleDuplicate(entry: FsEntry): Promise<void> {
    if (folderRootToken == null) return;
    const parentRel = relOfToken(parentTokenOf(entry.token) ?? folderRootToken);
    // Try "<base> copy", then "<base> copy 2", … until the host accepts a non-colliding name.
    for (let i = 1; i <= 50; i++) {
      const dupName = copyName(entry.name, i, entry.kind === 'file');
      const relPath = parentRel ? `${parentRel}/${dupName}` : dupName;
      try {
        const token = await platform.moveEntry(entry.token, folderRootToken, relPath, true);
        await refreshEntries();
        if (entry.kind === 'file' && token.toLowerCase().endsWith('.koi')) await openFileToken(token);
        else await syncOpenKoi(); // a duplicated folder may contain new .koi files
        return;
      } catch (e) {
        // A collision means "try the next candidate name".
        if (isAlreadyExists(e)) continue;
        setStatus('could not duplicate', 'error');
        console.error('duplicate failed:', e);
        return;
      }
    }
    // Every candidate name collided — don't fail silently.
    setStatus('could not duplicate (too many copies)', 'error');
  }

  // Drag-and-drop move: reparent `entry` into `destDirToken` (the opened folder for root), keeping its
  // name. The explorer already rejects no-op and into-own-subtree drops, so this just performs the host
  // move and re-keys the open buffers / LSP workspace, mirroring rename.
  async function handleMove(entry: FsEntry, destDirToken: string): Promise<void> {
    if (folderRootToken == null) return;
    const destRel = relOfToken(destDirToken);
    const newRelPath = destRel ? `${destRel}/${entry.name}` : entry.name;
    let newToken: string;
    try {
      newToken = await platform.moveEntry(entry.token, folderRootToken, newRelPath, false);
    } catch (e) {
      // A name clash at the destination is the common, recoverable case — surface it, don't overwrite.
      if (isAlreadyExists(e)) {
        setStatus(`“${entry.name}” already exists there`, 'error');
      } else {
        setStatus('could not move', 'error');
        console.error('moveEntry failed:', e);
      }
      return;
    }
    rekeyBuffers(entry.token, newToken);
    await refreshEntries();
    if (entry.kind === 'dir') await syncOpenKoi(); // moved folder may carry .koi files to re-key
  }

  // --- mutation helpers ------------------------------------------------------

  /** True if `path` is the token itself or lives under the `ancestor` directory token (any separator). */
  function isUnder(path: string, ancestor: string): boolean {
    return path === ancestor || path.startsWith(ancestor + '/') || path.startsWith(ancestor + '\\');
  }

  function nameOf(token: string): string {
    return token.split(/[\\/]/).filter(Boolean).pop() ?? token;
  }

  function parentTokenOf(token: string): string | null {
    const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
    return slash >= 0 ? token.slice(0, slash) : null;
  }

  /**
   * True when a host fs op failed because the destination name is taken. The desktop (Tauri) host
   * rejects with a plain string and the browser with an Error, so match the message text (not the
   * type) — shared by handleDuplicate (retry next name) and handleMove (surface the clash).
   */
  function isAlreadyExists(e: unknown): boolean {
    return String(e instanceof Error ? e.message : e).includes('already exists');
  }

  /** "order.koi" → "order copy.koi" (i=1) / "order copy 2.koi" (i=2); dirs get no extension split. */
  function copyName(name: string, i: number, isFile: boolean): string {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const dot = isFile ? name.lastIndexOf('.') : -1;
    if (dot > 0) return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
    return `${name}${suffix}`;
  }

  // Re-key every buffer at/under `oldToken` to its path under `newToken` (a file or folder rename/
  // move), preserving each buffer's unsaved text + dirty flag and keeping the LSP workspace in sync.
  function rekeyBuffers(oldToken: string, newToken: string): void {
    for (const buf of [...buffers.values()]) {
      if (buf.path == null || !isUnder(buf.path, oldToken)) continue;
      const newPath = newToken + buf.path.slice(oldToken.length);
      const newUri = pathToFileUri(newPath);
      const wasActive = buf.uri === activeUri;
      lsp.closeDoc(buf.uri);
      buffers.delete(buf.uri);
      const diags = diagnosticsByUri.get(buf.uri);
      diagnosticsByUri.delete(buf.uri);
      buf.uri = newUri;
      buf.path = newPath;
      buf.relPath = relOfToken(newPath);
      buf.name = nameOf(newPath);
      buffers.set(newUri, buf);
      if (diags) diagnosticsByUri.set(newUri, diags);
      lsp.openDoc(newUri, buf.text);
      if (wasActive) {
        activeUri = newUri;
        lsp.setActive(newUri);
      }
    }
  }

  // After the active buffer is deleted, fall back to another open file, or re-establish scratch when
  // the workspace is now empty (mirrors openFolderPath's empty-folder recovery).
  function activateFallback(): void {
    const next = Array.from(buffers.values())
      .filter((b) => b.path != null)
      .sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    if (next) {
      activeUri = next.uri;
      lsp.setActive(next.uri);
      editor.setDoc(next.text);
      const diags = diagnosticsByUri.get(next.uri) ?? [];
      setEditorDiagnostics(editor.view, diags);
      renderStrip(diags);
      updateStatus(diags);
      invalidateDocViews();
      return;
    }
    // Empty workspace: leave folder mode and reset to a fresh scratch buffer.
    newScratch();
  }

  // Open any .koi file present in the folder but not yet buffered (used after creating/duplicating
  // folders that may introduce new .koi files), so the compiled workspace stays complete.
  async function syncOpenKoi(): Promise<void> {
    if (folderRootToken == null) return;
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folderRootToken);
    } catch {
      return;
    }
    for (const f of files) {
      if (!buffers.has(pathToFileUri(f.path))) await ensureBuffer(f.path);
    }
  }

  // Switch the editor + lsp to a different open buffer. Saves the current editor text back to
  // the leaving buffer first (preserving unsaved edits), swaps the doc, points lsp at the new
  // uri, re-renders diagnostics for it, and invalidates the doc views so they re-fetch.
  function activateFile(uri: string): void {
    if (uri === activeUri) return;
    // Flush the leaving file's debounced edits to the server before switching: the shared change
    // timer is re-armed for the new file on setDoc below, which would otherwise drop them.
    lsp.flush();
    const leaving = buffers.get(activeUri);
    if (leaving) leaving.text = editor.getDoc();
    const next = buffers.get(uri);
    if (!next) return;
    activeUri = uri;
    lsp.setActive(uri);
    editor.setDoc(next.text);
    const diags = diagnosticsByUri.get(uri) ?? [];
    setEditorDiagnostics(editor.view, diags);
    renderStrip(diags);
    updateStatus(diags);
    invalidateDocViews();
    renderTree();
  }

  // Cross-file go-to-definition: if the resolved Location is a different OPEN file, activate it
  // before jumping; otherwise jump within the current file. Unknown uris are ignored.
  function navigateToDefinition(loc: Location): void {
    if (loc.uri && loc.uri !== activeUri && buffers.has(loc.uri)) {
      activateFile(loc.uri);
    }
    editor.gotoRange(loc.range.start, loc.range.end);
  }

  // Apply LSP TextEdits to a plain string (for non-active buffers in a cross-file rename). Edits
  // are applied from the end backward so earlier edits don't shift the offsets of later ones.
  function applyTextEditsToString(text: string, edits: TextEdit[]): string {
    const lines = text.split('\n');
    const offsetOf = (line: number, character: number): number => {
      const ln = Math.min(Math.max(line, 0), lines.length - 1);
      let offset = 0;
      for (let i = 0; i < ln; i++) offset += lines[i].length + 1; // + the '\n'
      return offset + Math.min(Math.max(character, 0), lines[ln].length);
    };
    const sorted = edits
      .map((e) => ({
        from: offsetOf(e.range.start.line, e.range.start.character),
        to: offsetOf(e.range.end.line, e.range.end.character),
        insert: e.newText,
      }))
      .sort((a, b) => b.from - a.from);
    let result = text;
    for (const edit of sorted) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
    return result;
  }

  // Apply a rename/code-action WorkspaceEdit across open buffers. The active file is edited through
  // the editor (so undo history + the onChange sync path fire); other OPEN files are patched in
  // their stored text and pushed to the server immediately. Edits to non-open files are ignored.
  function applyWorkspaceEdit(edit: WorkspaceEdit): void {
    if (!edit?.changes) return;
    let treeChanged = false;
    for (const [uri, edits] of Object.entries(edit.changes)) {
      if (!edits.length) continue;
      if (uri === activeUri) {
        editor.applyEdits(edits); // dispatch → onChange updates the buffer + lsp + doc views
      } else {
        const buf = buffers.get(uri);
        if (!buf) continue;
        buf.text = applyTextEditsToString(buf.text, edits);
        if (buf.path != null) buf.dirty = true;
        lsp.syncDoc(uri, buf.text);
        treeChanged = true;
      }
    }
    if (treeChanged) renderTree();
    onDocEdited();
  }

  // Replace the active document's contents (used by the AI "Apply to editor" action). Setting the
  // editor doc dispatches a change, so the editor's onChange handler runs the full sync pipeline
  // (buffer text, lsp.changeDoc, scratch persistence, doc-view refresh, tree) — don't repeat it here.
  function replaceActiveDoc(source: string): void {
    editor.setDoc(source);
  }

  // --- tabbed inspector (preview / glossary / context map) ------------------

  const glossaryView = el('view-glossary');
  const diagramsView = el('view-diagrams');
  const contextMapView = el('view-contextmap');
  const outlineView = el('view-outline');
  const assistantView = el('view-assistant');
  const checkView = el('view-check');
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#tabs .tab'));
  const viewEls: Record<RightView, HTMLElement> = {
    preview: el('view-preview'),
    glossary: glossaryView,
    diagrams: diagramsView,
    contextmap: contextMapView,
    outline: outlineView,
    assistant: assistantView,
    check: checkView,
  };
  let activeView: RightView = 'preview';
  // Track which doc-based views need a (re)fetch — invalidated on every edit so a tab
  // switch always shows data for the current model rather than a stale render. The check
  // view (on-demand via the Check button) and the assistant (interactive) are excluded.
  const docViewsLoaded: Record<'preview' | 'glossary' | 'diagrams' | 'contextmap' | 'outline', boolean> = {
    preview: false,
    glossary: false,
    diagrams: false,
    contextmap: false,
    outline: false,
  };

  function docMessage(view: HTMLElement, text: string, kind: 'muted' | 'error' = 'muted'): void {
    view.innerHTML = `<p class="${kind === 'error' ? 'doc-error' : 'muted'}">${text}</p>`;
  }

  // The glossary tab is the ubiquitous-language editor (#67): it lists every concept across
  // contexts with a documentation-coverage gauge, and lets anyone (especially non-coders) add or
  // edit a plain-prose description that is written back into the `.koi` as a `///` doc comment.
  async function loadGlossary(): Promise<void> {
    docMessage(glossaryView, 'Loading glossary…');
    try {
      const model = await lsp.glossaryModel();
      if (!model.entries.length) {
        docMessage(glossaryView, 'No concepts yet — declare some types, or fix syntax errors to populate the glossary.');
      } else {
        glossaryView.innerHTML = '';
        glossaryView.appendChild(renderGlossary(model, glossaryHandlers));
      }
      docViewsLoaded.glossary = true;
    } catch (e) {
      docMessage(glossaryView, 'Glossary request failed: ' + String(e), 'error');
    }
  }

  // Wires the pure (testable) glossary view in ./glossary to the editor + LSP: jump-to-source and
  // persist-a-description. The view builds the DOM; these handlers are the only side effects.
  const glossaryHandlers: GlossaryHandlers = {
    onGoto: (range) => editor.gotoRange(range.start, range.end),
    onSave: (entry, text) => void saveDescription(entry, text),
  };

  /**
   * Persists a description by asking the server for the doc-comment edit and applying it to the
   * buffer. The applied edit fires onChange → onDocEdited, which reloads the glossary (debounced),
   * refreshing coverage. A no-op result (e.g. an unknown id) needs no action — the inline editor
   * has already closed optimistically.
   */
  async function saveDescription(entry: GlossaryEntry, text: string): Promise<void> {
    try {
      const result = await lsp.setDoc(entry.id, text);
      if (!result.edits.length) return;
      if (result.uri && result.uri !== activeUri && buffers.has(result.uri)) activateFile(result.uri);
      editor.applyEdits(result.edits);
    } catch (e) {
      docMessage(glossaryView, 'Saving description failed: ' + String(e), 'error');
    }
  }

  async function loadContextMap(): Promise<void> {
    docMessage(contextMapView, 'Loading context map…');
    try {
      const res = await lsp.contextMap();
      contextMapView.innerHTML = `<div class="koi-md">${renderContextMapHtml(res)}</div>`;
      docViewsLoaded.contextmap = true;
    } catch (e) {
      docMessage(contextMapView, 'Context map request failed: ' + String(e), 'error');
    }
  }

  async function loadOutline(): Promise<void> {
    docMessage(outlineView, 'Loading outline…');
    try {
      const symbols = await lsp.documentSymbols();
      if (!symbols.length) {
        docMessage(outlineView, 'No symbols (the model may have syntax errors).');
      } else {
        outlineView.innerHTML = '';
        outlineView.appendChild(renderSymbolTree(symbols, (line, col) => editor.goto(line, col)));
      }
      docViewsLoaded.outline = true;
    } catch (e) {
      docMessage(outlineView, 'Outline request failed: ' + String(e), 'error');
    }
  }

  // Live domain diagrams: fetch the DocsEmitter output (Mermaid-in-Markdown) and render it.
  // Marked loaded only on success so a transient failure re-fetches on the next visit. A monotonic
  // token drops the result of a render that a newer one (edit / theme flip / refresh) superseded.
  let diagramsSeq = 0;
  async function loadDiagrams(): Promise<void> {
    const seq = ++diagramsSeq;
    docMessage(diagramsView, 'Rendering diagrams…');
    try {
      const res = await lsp.livingDocs();
      if (seq !== diagramsSeq) return;
      await renderDiagrams(diagramsView, res.files, currentTheme(), () => seq === diagramsSeq);
      if (seq === diagramsSeq) docViewsLoaded.diagrams = true;
    } catch (e) {
      if (seq === diagramsSeq) docMessage(diagramsView, 'Diagrams request failed: ' + String(e), 'error');
    }
  }

  function ensureLoaded(view: RightView): void {
    if (view === 'preview' && !docViewsLoaded.preview) void loadPreview();
    if (view === 'glossary' && !docViewsLoaded.glossary) void loadGlossary();
    if (view === 'diagrams' && !docViewsLoaded.diagrams) void loadDiagrams();
    if (view === 'contextmap' && !docViewsLoaded.contextmap) void loadContextMap();
    if (view === 'outline' && !docViewsLoaded.outline) void loadOutline();
  }

  // Mark the cached doc views stale (e.g. after an edit or a file switch).
  function invalidateDocViews(): void {
    docViewsLoaded.preview = false;
    docViewsLoaded.glossary = false;
    docViewsLoaded.diagrams = false;
    docViewsLoaded.contextmap = false;
    docViewsLoaded.outline = false;
  }

  // An edit makes any cached doc view (preview/glossary/context-map/outline) stale. Mark them
  // dirty; if one is on screen, refresh it (debounced) so it tracks the model without a manual
  // click — this is what makes the emitted preview live. Check (on-demand) and the interactive
  // assistant opt out.
  let editDebounce: ReturnType<typeof setTimeout> | undefined;
  function onDocEdited(): void {
    invalidateDocViews();
    if (activeView === 'check' || activeView === 'assistant') return;
    clearTimeout(editDebounce);
    editDebounce = setTimeout(() => ensureLoaded(activeView), 350);
  }

  function selectView(view: RightView): void {
    activeView = view;
    for (const tab of tabs) {
      const isActive = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(isActive));
    }
    for (const key of Object.keys(viewEls) as RightView[]) {
      viewEls[key].hidden = key !== view;
    }
    if (view === 'assistant') {
      ensureAssistant().focusInput();
      return;
    }
    ensureLoaded(view);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectView(tab.dataset.view as RightView));
  }

  // Refresh re-fetches the active doc view (check is driven by the Check… toolbar button, which
  // re-prompts for a baseline; the assistant is interactive).
  el<HTMLButtonElement>('btn-refresh').addEventListener('click', () => {
    if (activeView === 'preview') void loadPreview();
    else if (activeView === 'glossary') void loadGlossary();
    else if (activeView === 'diagrams') void loadDiagrams();
    else if (activeView === 'contextmap') void loadContextMap();
    else if (activeView === 'outline') void loadOutline();
  });

  // Check… — pick a baseline folder and diff the current buffer against it. Needs Stream F's
  // Rust dialog plugin + capability to function at runtime; the build does not depend on it.
  el<HTMLButtonElement>('btn-check').addEventListener('click', () => void runCheck());

  async function runCheck(): Promise<void> {
    if (!platform.canOpenFolders) {
      docMessage(checkView, 'Selecting a baseline folder needs a Chromium-based browser.', 'error');
      selectView('check');
      return;
    }
    let folder: string | null;
    try {
      folder = await platform.pickFolder('Select baseline model folder');
    } catch (e) {
      docMessage(checkView, 'Could not open the folder picker: ' + String(e), 'error');
      selectView('check');
      return;
    }
    if (!folder) return; // cancelled — abort silently
    selectView('check');
    docMessage(checkView, 'Checking against baseline…');
    try {
      // The browser has no server-side filesystem: read the baseline sources here and pass them to
      // the in-process compiler. The desktop server reads the folder path itself.
      const baselineSources = platform.kind === 'browser' ? await platform.readFolderSources(folder) : undefined;
      const res = await lsp.check(folder, baselineSources);
      if (res.error) {
        docMessage(checkView, 'Compatibility check failed: ' + res.error, 'error');
        return;
      }
      checkView.innerHTML = `<div class="koi-md">${renderMarkdown(renderCheckMarkdown(res))}</div>`;
    } catch (e) {
      docMessage(checkView, 'Check request failed: ' + String(e), 'error');
    }
  }

  // Destination-language split button: the main half previews the current target, the caret opens a
  // picker. Previewing also surfaces the preview tab and adopts that target as the new "current".
  type PreviewTarget = 'csharp' | 'typescript' | 'python' | 'php';
  const LANGS: { id: PreviewTarget; label: string; name: string; hint: string }[] = [
    { id: 'csharp', label: 'C#', name: 'C#', hint: '⌘1' },
    { id: 'typescript', label: 'TS', name: 'TypeScript', hint: '⌘2' },
    { id: 'python', label: 'Python', name: 'Python', hint: '⌘3' },
    { id: 'php', label: 'PHP', name: 'PHP', hint: '⌘4' },
  ];
  let currentTarget: PreviewTarget = 'csharp';

  const runBtn = el<HTMLButtonElement>('btn-preview-run');
  const caretBtn = el<HTMLButtonElement>('btn-lang-menu');
  const currentLabel = el<HTMLElement>('lang-current-label');
  const currentDot = runBtn.querySelector<HTMLElement>('.lang-dot')!;

  function setTarget(target: PreviewTarget): void {
    currentTarget = target;
    const meta = LANGS.find((l) => l.id === target)!;
    currentLabel.textContent = meta.label;
    currentDot.dataset.lang = target;
    runBtn.title = `Preview ${meta.name} (${meta.hint})`;
  }

  // --- language picker popover (mirrors the explorer context menu) ------------
  let langMenuEl: HTMLUListElement | null = null;

  function openLangMenu(): void {
    if (langMenuEl) {
      closeLangMenu();
      return;
    }
    const rect = (runBtn.parentElement as HTMLElement).getBoundingClientRect();
    const menu = document.createElement('ul');
    menu.className = 'lang-menu';
    menu.setAttribute('role', 'menu');
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    for (const lang of LANGS) {
      const li = document.createElement('li');
      li.setAttribute('role', 'none');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-menu-item';
      btn.setAttribute('role', 'menuitemradio');
      btn.setAttribute('aria-checked', String(lang.id === currentTarget));
      btn.innerHTML =
        `<span class="lang-dot" data-lang="${lang.id}" aria-hidden="true"></span>` +
        `<span class="lang-name">${lang.name}</span>` +
        `<span class="lang-hint">${lang.hint}</span>` +
        '<svg class="lang-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.4 6.4 12 13 4.4" /></svg>';
      btn.addEventListener('click', () => {
        closeLangMenu();
        void preview(lang.id);
      });
      li.appendChild(btn);
      menu.appendChild(li);
    }
    document.body.appendChild(menu);
    langMenuEl = menu;
    caretBtn.setAttribute('aria-expanded', 'true');
    const items = Array.from(menu.querySelectorAll<HTMLElement>('.lang-menu-item'));
    (items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    document.addEventListener('pointerdown', onLangDocPointer, true);
    document.addEventListener('keydown', onLangKeydown, true);
  }

  function closeLangMenu(): void {
    if (!langMenuEl) return;
    langMenuEl.remove();
    langMenuEl = null;
    caretBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onLangDocPointer, true);
    document.removeEventListener('keydown', onLangKeydown, true);
  }

  function onLangDocPointer(ev: PointerEvent): void {
    const t = ev.target as Node;
    if (langMenuEl && !langMenuEl.contains(t) && !caretBtn.contains(t)) closeLangMenu();
  }

  function onLangKeydown(ev: KeyboardEvent): void {
    if (!langMenuEl) return;
    const items = Array.from(langMenuEl.querySelectorAll<HTMLElement>('.lang-menu-item'));
    const active = document.activeElement as HTMLElement | null;
    const i = active ? items.indexOf(active) : -1;
    if (ev.key === 'Escape' || ev.key === 'Tab') {
      ev.preventDefault();
      closeLangMenu();
      caretBtn.focus();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      items[Math.min(items.length - 1, i + 1)]?.focus();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      items[Math.max(0, i - 1)]?.focus();
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      items[0]?.focus();
    } else if (ev.key === 'End') {
      ev.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  // Emit the current target into the preview pane. Folded into the doc-view lifecycle (like the
  // glossary/diagrams tabs) so it loads on open and tracks edits live — no button press required. A
  // monotonic token drops a stale emit that a newer edit or target switch has superseded; the prior
  // output stays on screen across a refresh (only the very first load shows a placeholder) so live
  // typing never flashes the pane empty.
  let previewSeq = 0;
  async function loadPreview(): Promise<void> {
    const seq = ++previewSeq;
    if (!lastPreview) output.setContent('// generating preview…', 'plain');
    try {
      const res = await lsp.emitPreview(currentTarget);
      if (seq !== previewSeq) return;
      let content: string;
      let lang: 'csharp' | 'typescript' | 'python' | 'php' | 'plain';
      let copyable = false;
      if (res.error) {
        content = '// emit error\n' + res.error;
        lang = 'plain';
      } else if (!res.files.length) {
        content = '// no files emitted (fix diagnostics first)';
        lang = 'plain';
      } else {
        content = res.files.map((f) => `// ==== ${f.path} ====\n${f.contents}`).join('\n\n');
        lang = currentTarget;
        copyable = true;
      }
      output.setContent(content, lang);
      lastPreview = content;
      copyBtn.disabled = !copyable;
      docViewsLoaded.preview = true;
    } catch (e) {
      if (seq !== previewSeq) return;
      output.setContent('// preview request failed\n' + String(e), 'plain');
      lastPreview = '';
      copyBtn.disabled = true;
    }
  }

  // Explicit preview action (run button, language menu, ⌘1/2/3, palette): adopt the target, surface
  // the preview tab, and force a re-emit even when it was already shown (e.g. for another target).
  function preview(target: PreviewTarget): void {
    setTarget(target);
    docViewsLoaded.preview = false;
    selectView('preview');
  }

  runBtn.addEventListener('click', () => void preview(currentTarget));
  caretBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openLangMenu();
  });
  setTarget(currentTarget);

  // --- open folder (directory-mode workspace) -------------------------------

  el<HTMLButtonElement>('btn-open-folder').addEventListener('click', () => void openFolder());

  async function openFolder(): Promise<void> {
    if (!platform.canOpenFolders) {
      setStatus('opening a folder needs a Chromium-based browser', 'error');
      return;
    }
    let folder: string | null;
    try {
      folder = await platform.pickFolder('Open a folder of .koi models');
    } catch (e) {
      setStatus('could not open folder picker', 'error');
      console.error('Open folder dialog failed:', e);
      return;
    }
    if (!folder) return; // cancelled
    await openFolderPath(folder);
  }

  // Load + open every .koi file under `folder` as one workspace. Shared by the toolbar
  // button (which picks a folder first) and the welcome screen's recent-folder items
  // (which pass a known path directly).
  async function openFolderPath(folder: string): Promise<void> {
    welcome.hide();
    let files: KoiFile[];
    try {
      files = await platform.listKoiFiles(folder);
    } catch (e) {
      setStatus('could not read folder', 'error');
      console.error('listKoiFiles failed:', e);
      return;
    }
    if (!files.length) {
      setStatus('no .koi files in folder', 'error');
      return;
    }

    // Leaving scratch mode: close the scratch doc so the server drops it from the workspace.
    if (!folderMode) {
      lsp.closeDoc(SCRATCH_URI);
      buffers.delete(SCRATCH_URI);
      diagnosticsByUri.delete(SCRATCH_URI);
    } else {
      // Re-opening a folder: close every previously open file first.
      for (const uri of Array.from(buffers.keys())) {
        lsp.closeDoc(uri);
      }
      buffers.clear();
      diagnosticsByUri.clear();
    }

    // Read + open every file as one workspace (cross-file refs resolve via didOpen).
    for (const f of files) {
      let text: string;
      try {
        text = await platform.readTextFile(f.path);
      } catch (e) {
        console.error('readTextFile failed for', f.path, e);
        continue;
      }
      const uri = pathToFileUri(f.path);
      buffers.set(uri, { uri, path: f.path, relPath: f.relPath, name: f.name, text, dirty: false });
      lsp.openDoc(uri, text);
    }

    // Every read failed after a non-empty listing (files deleted / permissions revoked
    // between list and read). The scratch doc was already closed above, so don't leave the
    // app with no active buffer — re-establish scratch from the current editor contents.
    if (buffers.size === 0) {
      setStatus('could not read any files in folder', 'error');
      const text = editor.getDoc();
      buffers.set(SCRATCH_URI, { uri: SCRATCH_URI, path: null, relPath: 'model.koi', name: 'model.koi', text, dirty: false });
      lsp.openDoc(SCRATCH_URI, text);
      activeUri = SCRATCH_URI;
      lsp.setActive(SCRATCH_URI);
      folderMode = false;
      folderRootToken = null;
      entriesCache = [];
      hideFileTreeChrome();
      return;
    }

    folderMode = true;
    folderRootToken = folder;
    // Activate the first file (sorted by relPath) and show the tree.
    const first = Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    activeUri = first.uri;
    lsp.setActive(first.uri);
    editor.setDoc(first.text);
    treeTitleEl.textContent = platform.folderName(folder);
    showFileTreeChrome();
    pushRecentFolder(folder);
    invalidateDocViews();
    // Fetch the full explorer tree (dirs + .koi) and render it; falls back silently on failure.
    await refreshEntries();
    ensureLoaded(activeView);
  }

  // True when the command palette or a modal dialog (prefs/help/about) is open, so global
  // shortcuts don't fire 'through' an overlay at the editor underneath. The welcome screen is
  // deliberately excluded — its own actions own that surface.
  function overlayOpen(): boolean {
    return document.querySelector('.koi-palette-backdrop:not([hidden]), .koi-modal-backdrop:not([hidden])') !== null;
  }

  // --- save (format + write to disk) ----------------------------------------
  // The editor intercepts Cmd/Ctrl-S and calls onFormat; we additionally write the formatted
  // active buffer to disk. To run AFTER the format edits land, save is also wired here on the
  // window so it can read the post-format editor text. The editor's own format keymap already
  // ran preventDefault, so this listener only persists.
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (overlayOpen()) return; // don't act on the editor under an open overlay
    // Mod+Alt+S → Save all. Match on e.code (the physical S key): on macOS, Option composes e.key
    // into another glyph (e.g. 'ß'), so `e.key === 's'` would miss the chord.
    if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      void saveAllDirty();
    } else if (!e.altKey && (e.key === 's' || e.key === 'S')) {
      // Mod+S → save / format the active buffer (unchanged single-file behaviour).
      e.preventDefault();
      void saveActive();
    }
  });

  let saveQueued = false;
  async function saveActive(): Promise<void> {
    if (saveQueued) return;
    saveQueued = true;
    try {
      // Format first (mirrors the editor's Mod-S) when format-on-save is enabled, then persist.
      if (settings.formatOnSave) {
        try {
          const edits = await lsp.format();
          editor.applyEdits(edits);
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const buf = buffers.get(activeUri);
      if (!buf) return;
      buf.text = editor.getDoc();
      lsp.changeDoc(activeUri, buf.text);
      if (!buf.path) {
        // Scratch mode with no backing file: prompt for a target path (save-as), then write.
        await saveScratchAs(buf);
        return;
      }
      try {
        await platform.writeTextFile(buf.path, buf.text);
        buf.dirty = false;
        lsp.didSave();
        renderTree();
      } catch (e) {
        setStatus('save failed', 'error');
        console.error('writeTextFile failed:', e);
      }
    } finally {
      saveQueued = false;
    }
  }

  // Save-as for an unsaved scratch buffer: pick a destination, write it, then promote the
  // buffer to a real file (path/name/relPath set, clean) and surface it in the tree.
  async function saveScratchAs(buf: Buffer): Promise<void> {
    let target: string | null;
    try {
      target = await platform.pickSavePath('model.koi');
    } catch (e) {
      setStatus('could not open save dialog', 'error');
      console.error('save dialog failed:', e);
      return;
    }
    if (!target) return; // cancelled
    try {
      await platform.writeTextFile(target, buf.text);
    } catch (e) {
      setStatus('save failed', 'error');
      console.error('writeTextFile failed:', e);
      return;
    }
    // Re-key the buffer + LSP doc from the scratch uri to the real file uri so the
    // "non-null path ⇒ keyed by pathToFileUri(path)" invariant holds. On the desktop the token is
    // an absolute path, so this matches openFolderPath and a later folder-open of the same file
    // reuses this buffer. In the browser the token is only the file's base name (the File System
    // Access API exposes no path), so a folder-opened copy of the same file is keyed differently
    // and is a distinct buffer — acceptable, just not de-duplicated.
    const name = target.split(/[\\/]/).filter(Boolean).pop() ?? target;
    const newUri = pathToFileUri(target);
    lsp.closeDoc(buf.uri);
    buffers.delete(buf.uri);
    diagnosticsByUri.delete(buf.uri);
    buf.uri = newUri;
    buf.path = target;
    buf.name = name;
    buf.relPath = name;
    buf.dirty = false;
    buffers.set(newUri, buf);
    activeUri = newUri;
    lsp.openDoc(newUri, buf.text);
    lsp.setActive(newUri);
    clearScratch(); // the scratch is now a real file — don't also restore it as scratch on reload
  }

  // Save EVERY dirty buffer (Mod+Alt+S / "Save all"), so editing several files and then closing
  // can't silently drop the ones you didn't individually Mod-S. Mirrors saveActive's format+write
  // but across the whole workspace: the active buffer is formatted + synced from the editor first
  // (the others already hold their edited text in memory), then each dirty buffer is written. A
  // per-file write failure leaves that buffer dirty and reports it; the rest still save. The
  // single-file Mod-S path (saveActive) is unchanged.
  let saveAllQueued = false;
  async function saveAllDirty(): Promise<void> {
    if (saveAllQueued) return;
    saveAllQueued = true;
    try {
      if (settings.formatOnSave) {
        try {
          editor.applyEdits(await lsp.format());
        } catch (e) {
          console.error('format on save failed:', e);
        }
      }
      const active = buffers.get(activeUri);
      if (active) {
        active.text = editor.getDoc();
        lsp.changeDoc(activeUri, active.text);
      }

      if (dirtyBuffers(buffers).length === 0) {
        // Nothing flagged dirty. In scratch mode the single buffer is path-less and never marked
        // dirty (it auto-persists to localStorage), so fall back to the normal save-as when it
        // holds real content; in folder mode with nothing dirty this is a neutral no-op.
        if (active && active.path == null && hasUnsavedWork()) await saveScratchAs(active);
        else setStatus('No unsaved changes', 'green');
        return;
      }

      let failures = 0;
      const saved = await saveAllDirtyBuffers(buffers, {
        write: (buf) => platform.writeTextFile(buf.path as string, buf.text),
        saveScratch: (buf) => saveScratchAs(buf),
        onError: (buf, err) => {
          failures++;
          console.error('writeTextFile failed for', buf.path, err);
        },
      });
      if (saved > 0) {
        lsp.didSave();
        renderTree();
      }
      if (failures > 0) {
        setStatus(`Save failed for ${failures} file${failures === 1 ? '' : 's'}`, 'error');
      } else {
        setStatus(`Saved ${saved} file${saved === 1 ? '' : 's'}`, 'green');
      }
    } finally {
      saveAllQueued = false;
    }
  }

  // --- new scratch model ----------------------------------------------------
  // Reset to a single untouched scratch buffer holding the BLANK stub (an empty context — NOT the
  // Billing SEED). In folder mode this tears the folder workspace down (closes every open doc) and
  // re-establishes scratch. This is the raw reset with no confirmation; user-initiated New goes
  // through requestNewScratch() (below), which guards unsaved work first.
  function newScratch(): void {
    clearScratch(); // forget any restored scratch; New starts from the blank stub
    if (folderMode) {
      for (const uri of Array.from(buffers.keys())) lsp.closeDoc(uri);
      buffers.clear();
      diagnosticsByUri.clear();
      folderMode = false;
      folderRootToken = null;
      entriesCache = [];
      explorer.render([], '');
      hideFileTreeChrome();
      treeTitleEl.textContent = 'Scratch';
    } else {
      // Reuse the existing scratch buffer; drop any stale diagnostics.
      diagnosticsByUri.delete(SCRATCH_URI);
    }
    buffers.set(SCRATCH_URI, {
      uri: SCRATCH_URI,
      path: null,
      relPath: 'model.koi',
      name: 'model.koi',
      text: BLANK,
      dirty: false,
    });
    activeUri = SCRATCH_URI;
    lsp.setActive(SCRATCH_URI);
    // Ensure the server has a fresh scratch doc, then load the blank stub into the editor.
    lsp.openDoc(SCRATCH_URI, BLANK);
    editor.setDoc(BLANK);
    // Clear the editor gutter / strip / status pill so a previously-active file's diagnostics don't
    // linger until the server publishes fresh scratch diagnostics (mirrors activateFile/Fallback).
    setEditorDiagnostics(editor.view, []);
    renderStrip([]);
    updateStatus([]);
    invalidateDocViews();
    renderTree();
    ensureLoaded(activeView);
    welcome.hide();
  }

  // Does the workspace hold unsaved work that New would destroy? In scratch mode, anything other
  // than an empty buffer / the seed backdrop / the blank stub counts (mirrors scheduleScratchSave's
  // "is this the untouched seed?" test). In folder mode, files live on disk, so only a dirty open
  // buffer is at risk.
  function hasUnsavedWork(): boolean {
    if (folderMode) return Array.from(buffers.values()).some((b) => b.dirty);
    const text = editor.getDoc();
    return text.trim() !== '' && text !== SEED && text !== BLANK;
  }

  // Confirm before an action that would replace the current model and lose unsaved work. Resolves
  // true to proceed (nothing to lose, or the user confirmed), false to abort. Shared by New and the
  // start-screen actions that swap the workspace (open folder / recent / example).
  async function confirmReplaceWork(title: string, confirmLabel: string): Promise<boolean> {
    if (!hasUnsavedWork()) return true;
    const save = formatChord('mod+S');
    return confirmDialog.ask({
      title,
      message: folderMode
        ? `Files with unsaved changes will lose them. Save with ${save} first to keep them.`
        : `Your current model has unsaved changes that will be lost. Save it with ${save} first to keep it.`,
      confirmLabel,
      danger: true,
    });
  }

  // User-initiated New (button, ⌘N, palette, welcome). Confirms before discarding unsaved work;
  // proceeds straight to a fresh stub when there's nothing to lose.
  async function requestNewScratch(): Promise<void> {
    if (await confirmReplaceWork('Start a new model?', 'Discard & start new')) newScratch();
  }

  // Open `source` as a fresh scratch model (used by the example gallery and shared links). Tears
  // down a folder workspace if one is open, then seeds a single scratch buffer with the source.
  function openScratchWith(source: string): void {
    if (folderMode) {
      for (const uri of Array.from(buffers.keys())) lsp.closeDoc(uri);
      buffers.clear();
      diagnosticsByUri.clear();
      folderMode = false;
      hideFileTreeChrome();
      treeTitleEl.textContent = 'Scratch';
    } else {
      diagnosticsByUri.delete(SCRATCH_URI);
    }
    buffers.set(SCRATCH_URI, {
      uri: SCRATCH_URI,
      path: null,
      relPath: 'model.koi',
      name: 'model.koi',
      text: source,
      dirty: false,
    });
    activeUri = SCRATCH_URI;
    lsp.setActive(SCRATCH_URI);
    lsp.openDoc(SCRATCH_URI, source);
    editor.setDoc(source);
    invalidateDocViews();
    renderTree();
    ensureLoaded(activeView);
    welcome.hide();
    if (source === SEED) clearScratch();
    else scheduleScratchSave(source);
  }

  // --- overlays + polish surfaces -------------------------------------------

  // Open a starter example: a multi-file example materializes a real workspace (folder mode → the
  // explorer); a single-file one — or any host that can't back a synthetic workspace — opens as a
  // scratch buffer.
  async function openExample(example: Example): Promise<void> {
    if (example.files?.length && platform.materializeWorkspace) {
      try {
        const token = await platform.materializeWorkspace(example.id, example.files);
        if (token) {
          await openFolderPath(token);
          return;
        }
      } catch (e) {
        console.error('Opening example workspace failed; falling back to scratch:', e);
      }
    }
    openScratchWith(example.source);
  }

  // Reopen the start screen ("home"). Non-destructive: it's an overlay over the current model, so
  // showing it loses nothing — only its actions navigate. Wired to the brand logo and the palette.
  function goHome(): void {
    welcome.show();
  }

  // A start-screen action that swaps the workspace. Confirms unsaved work first. On cancel we do
  // nothing: the welcome already hid itself when the action was clicked, so the user lands back in
  // the editor with their unsaved work intact — Cancel means "keep what I have", not "back to home".
  async function leaveHomeFor(title: string, action: () => void | Promise<void>): Promise<void> {
    if (await confirmReplaceWork(title, 'Discard & open')) await action();
  }

  const welcome = createWelcome({
    onNewScratch: () => void requestNewScratch(),
    onOpenFolder: () => void leaveHomeFor('Open a folder?', () => openFolder()),
    onOpenRecent: (path) => void leaveHomeFor('Open this folder?', () => openFolderPath(path)),
    onOpenExample: (example) => void leaveHomeFor('Open this example?', () => openExample(example)),
  });

  const palette = createCommandPalette(() => getCommands());
  const prefs = createPreferences({
    onChange: (s) => {
      settings = s;
      // onChange is the single re-skin path: apply the document-level appearance, then sync the
      // pieces prefs can't reach — soft-wrap on both the source editor and the output preview.
      applyAppearance(s);
      editor.setLineWrap(s.wordWrap);
      output.setLineWrap(s.wordWrap);
    },
    // Desktop hosts launch a `koine mcp --http` sidecar and return its loopback URL; the browser
    // returns null, so Settings hides the MCP affordance there.
    mcpEndpoint: () => platform.mcpEndpoint(),
    mcpStop: () => platform.mcpStop(),
    // Only the desktop shell can host the sidecar; the web build shows recipes but disables the toggle.
    mcpHostable: platform.kind === 'tauri',
  });
  const help = createHelpOverlay(helpRows());
  const about = createAboutDialog();
  // Guards the user-initiated New command against silently discarding unsaved work.
  const confirmDialog = createConfirmDialog();
  // Generate Project wizard: compiles the active model, then bundles the emitted files into a
  // downloadable archive. I/O is injected so the wizard stays decoupled from the LSP/host wiring.
  const generateProject = createGenerateProject({
    emitPreview: (target) => lsp.emitPreview(target),
    glossary: () => lsp.glossary(),
    saveZip: (name, data) => platform.saveZip(name, data),
  });

  // The AI assistant panel is created lazily the first time its tab is shown (the Anthropic SDK
  // is dynamically imported inside ai.ts, so creating the panel does not load it — only sending).
  let assistant: AssistantPanel | null = null;
  function ensureAssistant(): AssistantPanel {
    if (assistant) return assistant;
    assistant = createAssistantPanel({
      container: assistantView,
      getProvider: () => loadSettings().aiProvider,
      getBaseUrl: () => loadSettings().aiBaseUrl,
      getApiKey: () => loadSettings().aiApiKey,
      getModel: () => {
        const s = loadSettings();
        return s.aiProvider === 'openai' ? s.aiModelOpenai : s.aiModel;
      },
      getContext: () => {
        const diagnostics = (diagnosticsByUri.get(activeUri) ?? []).map((d) => ({
          line: d.range.start.line + 1,
          col: d.range.start.character + 1,
          severity: (d.severity === 2 ? 'warning' : 'error') as 'warning' | 'error',
          message: d.message,
        }));
        return { fileName: buffers.get(activeUri)?.name ?? 'model.koi', source: editor.getDoc(), diagnostics };
      },
      onApplyModel: (source) => replaceActiveDoc(source),
      onOpenPrefs: () => prefs.open(),
      // Let the assistant call koine tools (validate/compile/format), executed by the host: in-WASM in
      // the browser, via the `koine mcp --http` sidecar on the desktop.
      runCompilerTool: platform.runCompilerTool
        ? (name, argsJson) => platform.runCompilerTool!(name, argsJson)
        : undefined,
    });
    return assistant;
  }

  // Diagrams are rendered with a theme-matched Mermaid palette; re-render on a theme flip (covers
  // the toolbar toggle, the command palette, and Preferences — all route through setTheme).
  onThemeChange(() => {
    docViewsLoaded.diagrams = false;
    if (activeView === 'diagrams') void loadDiagrams();
  });

  // Copy a shareable playground link (the current model encoded in the URL hash) to the clipboard,
  // flashing a transient confirmation in the status pill. After the flash, re-derive the pill from
  // the CURRENT diagnostics rather than restoring a snapshot (which could clobber a fresh push).
  async function copyShareLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(buildShareUrl(editor.getDoc()));
      setStatus('link copied ✓', 'green');
      setTimeout(() => updateStatus(diagnosticsByUri.get(activeUri) ?? []), 1500);
    } catch (e) {
      console.error('copy share link failed:', e);
    }
  }

  initSplitResizer({ split: el('split'), handle: el('split-resizer') });

  // File-tree width (left rail) — only draggable when the rail track is shown (folder mode).
  initEdgeResizer({
    target: splitEl,
    handle: el('filetree-resizer'),
    cssVar: '--koi-filetree-w',
    anchor: 'left',
    storageKey: 'koine.studio.filetreeWidth',
    min: 150,
    max: (w) => w * 0.5,
  });
  treeBtn.addEventListener('click', () => toggleFileTree());

  // Diagnostics strip — draggable height (anchored to the app's bottom edge) + collapse toggle.
  const diagEl = el('diagnostics');
  const diagHeader = el('diag-header');
  initEdgeResizer({
    target: diagEl,
    handle: el('diag-resizer'),
    container: el('app'),
    cssVar: '--koi-diag-h',
    anchor: 'bottom',
    storageKey: 'koine.studio.diagHeight',
    min: 80,
    max: (h) => h * 0.5,
  });
  const DIAG_COLLAPSED_KEY = 'koine.studio.diagCollapsed';
  function applyDiagCollapsed(collapsed: boolean): void {
    diagEl.classList.toggle('collapsed', collapsed);
    diagHeader.setAttribute('aria-expanded', String(!collapsed));
  }
  applyDiagCollapsed((localStorage.getItem(DIAG_COLLAPSED_KEY) ?? '0') === '1');
  diagHeader.addEventListener('click', () => {
    const collapsed = !diagEl.classList.contains('collapsed');
    applyDiagCollapsed(collapsed);
    try {
      localStorage.setItem(DIAG_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // ignore — no persistence available
    }
  });

  // Toolbar buttons unique to this phase.
  const hintEl = document.querySelector('.palette-hint');
  if (hintEl) {
    hintEl.textContent = formatChord('mod+K'); // ⌘+K / Ctrl+K per platform
    hintEl.addEventListener('click', () => palette.toggle());
  }
  el<HTMLButtonElement>('btn-home').addEventListener('click', () => goHome());
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => void requestNewScratch());
  el<HTMLButtonElement>('btn-generate-project').addEventListener('click', () => generateProject.open());
  el<HTMLButtonElement>('btn-theme').addEventListener('click', () => toggleTheme());
  el<HTMLButtonElement>('btn-prefs').addEventListener('click', () => prefs.open());
  el<HTMLButtonElement>('btn-about').addEventListener('click', () => about.open());

  // Format the active document via the LSP and apply the edits (shared by the palette command
  // and format-on-save). Degrades silently if the request fails.
  async function formatActive(): Promise<void> {
    try {
      const edits = await lsp.format();
      editor.applyEdits(edits);
    } catch (e) {
      console.error('format failed:', e);
    }
  }

  // --- command palette command set ------------------------------------------
  // Hints are authored with a literal 'mod' and formatted to ⌘ / Ctrl per platform so the
  // palette, help overlay, and toolbar hint all show the same key.
  function getCommands(): Command[] {
    const cmds: Command[] = [
      { id: 'preview-cs', title: 'Preview C#', hint: 'mod+1', group: 'Preview', run: () => void preview('csharp') },
      { id: 'preview-ts', title: 'Preview TypeScript', hint: 'mod+2', group: 'Preview', run: () => void preview('typescript') },
      { id: 'preview-py', title: 'Preview Python', hint: 'mod+3', group: 'Preview', run: () => void preview('python') },
      { id: 'format', title: 'Format document', hint: 'mod+S', group: 'Edit', run: () => void formatActive() },
      { id: 'home', title: 'Go to start screen', group: 'File', run: () => goHome() },
      { id: 'open-folder', title: 'Open folder…', hint: 'mod+Shift+O', group: 'File', run: () => void openFolder() },
      { id: 'new-scratch', title: 'New scratch model', hint: 'mod+N', group: 'File', run: () => void requestNewScratch() },
      { id: 'save-all', title: 'Save all', hint: 'mod+Alt+S', group: 'File', run: () => void saveAllDirty() },
      { id: 'share', title: 'Copy shareable link', group: 'File', run: () => void copyShareLink() },
      { id: 'check', title: 'Check against baseline…', group: 'File', run: () => void runCheck() },
      { id: 'generate-project', title: 'Generate project…', group: 'File', run: () => generateProject.open() },
      { id: 'toggle-theme', title: 'Toggle theme', group: 'View', run: () => toggleTheme() },
      { id: 'prefs', title: 'Settings…', hint: 'mod+,', group: 'View', run: () => prefs.open() },
      { id: 'help', title: 'Keyboard shortcuts', hint: 'F1', group: 'Help', run: () => help.open() },
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => about.open() },
      { id: 'view-preview', title: 'Show Emitted Preview', group: 'Inspector', run: () => selectView('preview') },
      { id: 'view-glossary', title: 'Show Glossary', group: 'Inspector', run: () => selectView('glossary') },
      { id: 'view-diagrams', title: 'Show Diagrams', group: 'Inspector', run: () => selectView('diagrams') },
      { id: 'view-contextmap', title: 'Show Context Map', group: 'Inspector', run: () => selectView('contextmap') },
      { id: 'view-outline', title: 'Show Outline', group: 'Inspector', run: () => selectView('outline') },
      { id: 'view-assistant', title: 'Show Assistant', group: 'Inspector', run: () => selectView('assistant') },
    ];

    // In folder mode, surface every open file as a "Go to File" entry so the palette doubles as a
    // fuzzy quick-open (type part of a path to jump). The palette re-reads this on each open.
    if (folderMode) {
      for (const buf of Array.from(buffers.values())
        .filter((b) => b.path != null)
        .sort((a, b) => a.relPath.localeCompare(b.relPath))) {
        cmds.push({ id: 'goto:' + buf.uri, title: buf.relPath, group: 'Go to File', run: () => activateFile(buf.uri) });
      }
    }

    return cmds.map((c) => (c.hint ? { ...c, hint: formatChord(c.hint) } : c));
  }

  // --- global keyboard shortcuts --------------------------------------------
  // The existing Cmd/Ctrl-S save listener lives below this. This handler owns the rest of
  // the global chords; each overlay binds its own Esc, so Esc is intentionally not handled here.
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod && e.key !== 'F1') return;

    // mod+K always toggles the palette (so it can also dismiss itself); every other global
    // shortcut is suppressed while an overlay is open so it doesn't act on the editor beneath.
    if (mod && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      palette.toggle();
      return;
    }
    if (overlayOpen()) return;

    if (mod && e.shiftKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      void openFolder();
    } else if (mod && !e.shiftKey && (e.key === 'n' || e.key === 'N')) {
      e.preventDefault();
      void requestNewScratch();
    } else if (mod && e.key === '1') {
      e.preventDefault();
      void preview('csharp');
    } else if (mod && e.key === '2') {
      e.preventDefault();
      void preview('typescript');
    } else if (mod && e.key === '3') {
      e.preventDefault();
      void preview('python');
    } else if (mod && e.key === '4') {
      e.preventDefault();
      void preview('php');
    } else if (mod && e.key === ',') {
      e.preventDefault();
      prefs.open();
    } else if (e.key === 'F1') {
      e.preventDefault();
      help.toggle();
    } else if (mod && (e.key === 'b' || e.key === 'B')) {
      // Toggle the file tree — only meaningful in folder mode.
      if (folderMode) {
        e.preventDefault();
        toggleFileTree();
      }
    }
  });

  // Welcome screen on boot: shown only on a fresh start (no restored scratch, no shared link).
  // A shared-link model is persisted as the scratch buffer and the hash is cleared so a reload
  // resumes into it cleanly. Otherwise, unsaved work from a previous visit resumes straight in.
  // The first edit, New scratch, Open folder, or opening a recent folder all hide the welcome.
  if (sharedModel !== null) {
    saveScratch(sharedModel);
    clearModelHash();
  } else if (restoredScratch === null) {
    welcome.show();
  }

  // Boot: attach listeners (inside start) before messages flow, then open the doc.
  setStatus('connecting…', 'connecting');
  lsp.onServerRestart(() => {
    // Fresh sidecar is back in sync; refresh whatever doc view is showing.
    invalidateDocViews();
    ensureLoaded(activeView);
  });
  lsp
    .start()
    .then(() => {
      // Scratch mode on startup: open the single seed doc at SCRATCH_URI.
      lsp.openDoc(SCRATCH_URI, editor.getDoc());
    })
    .catch((e) => {
      setStatus('connection failed', 'error');
      output.setContent('// failed to start language server\n' + String(e), 'plain');
    });
}
