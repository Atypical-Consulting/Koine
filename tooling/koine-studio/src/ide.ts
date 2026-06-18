// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the tabbed inspector (emitted preview,
// glossary, and context map).
import { createKoineEditor, createOutputView, renderMarkdown, renderSymbolTree, setEditorDiagnostics } from './editor';
import { KoineLsp, SCRATCH_URI, type CheckResult, type ContextMapResult, type Location, type LspDiagnostic } from './lsp';
import { getPlatform, type KoiFile } from './host';
import { initTheme, toggleTheme } from './theme';
import { clearScratch, loadScratch, loadSettings, pushRecentFolder, saveScratch, type Settings } from './store';
import { createWelcome } from './welcome';
import { createCommandPalette, type Command } from './palette';
import { createPreferences } from './prefs';
import { initSplitResizer } from './resize';
import { createHelpOverlay, type ShortcutRow } from './help';
import { createAboutDialog } from './about';
import { formatChord } from './platform';

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

type RightView = 'preview' | 'glossary' | 'contextmap' | 'outline' | 'check';

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
    { keys: 'mod+,', description: 'Preferences' },
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

  // Apply the persisted theme + editor font size before CodeMirror is created so the
  // editor picks up the right tokens / size on first paint.
  initTheme();
  let settings: Settings = loadSettings();
  function applyFontSize(): void {
    document.documentElement.style.setProperty('--koi-editor-font-size', settings.fontSize + 'px');
  }
  applyFontSize();

  // Session restore: if the user has unsaved scratch work from a previous visit, open that instead
  // of the seed (and skip the welcome screen — see the boot section). Folder workspaces are not
  // restored; they live on disk and are re-opened explicitly.
  const restoredScratch = loadScratch();
  const initialDoc = restoredScratch ?? SEED;

  const editor = createKoineEditor({
    parent: el('editor-pane'),
    doc: initialDoc,
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
    onDefinition: (line, character) => lsp.definition(line, character),
    onNavigate: (loc) => navigateToDefinition(loc),
    // Save (Cmd/Ctrl-S) is owned by ide.ts's window keydown handler below: it formats AND
    // writes the active buffer to disk. We deliberately do NOT pass onFormat here so the
    // editor's Mod-s keymap stays inert and there's exactly one save path.
  });
  const output = createOutputView(el('view-preview'));

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
  const stripEl = el('diagnostics');

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

  const treeEl = el<HTMLElement>('filetree');
  const treeListEl = el<HTMLUListElement>('filetree-list');
  const treeTitleEl = el<HTMLElement>('filetree-title');

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
    stripEl.innerHTML = '';
    if (!diags.length) {
      const span = document.createElement('span');
      span.className = 'diag-empty';
      span.textContent = 'No diagnostics.';
      stripEl.appendChild(span);
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
      stripEl.appendChild(row);
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

  // Render the open-buffer list into the left rail, sorted by relPath. Each row shows the
  // file name (with a dirty dot), the parent folder as muted context, and an error/warning
  // badge when the file currently has diagnostics. Clicking a row activates that file.
  function renderTree(): void {
    treeListEl.innerHTML = '';
    const rows = Array.from(buffers.values())
      .filter((b) => b.path != null) // scratch buffer is not listed in folder mode
      .sort((a, b) => a.relPath.localeCompare(b.relPath));
    for (const buf of rows) {
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-row';
      if (buf.uri === activeUri) row.setAttribute('aria-current', 'true');

      const slash = buf.relPath.lastIndexOf('/');
      const dir = slash >= 0 ? buf.relPath.slice(0, slash + 1) : '';
      const label = document.createElement('span');
      label.className = 'tree-name';
      label.textContent = buf.name;
      if (buf.dirty) {
        const dot = document.createElement('span');
        dot.className = 'tree-dirty';
        dot.title = 'Unsaved changes';
        dot.textContent = '•';
        label.appendChild(dot);
      }
      row.appendChild(label);

      if (dir) {
        const dirEl = document.createElement('span');
        dirEl.className = 'tree-dir';
        dirEl.textContent = dir;
        row.appendChild(dirEl);
      }

      const { errors, warnings } = diagCounts(buf.uri);
      if (errors || warnings) {
        const badge = document.createElement('span');
        badge.className = errors ? 'tree-badge tree-badge-err' : 'tree-badge tree-badge-warn';
        badge.textContent = String(errors || warnings);
        badge.title = `${errors} error(s), ${warnings} warning(s)`;
        row.appendChild(badge);
      }

      row.addEventListener('click', () => activateFile(buf.uri));
      li.appendChild(row);
      treeListEl.appendChild(li);
    }
  }

  // Switch the editor + lsp to a different open buffer. Saves the current editor text back to
  // the leaving buffer first (preserving unsaved edits), swaps the doc, points lsp at the new
  // uri, re-renders diagnostics for it, and invalidates the doc views so they re-fetch.
  function activateFile(uri: string): void {
    if (uri === activeUri) return;
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

  // --- tabbed inspector (preview / glossary / context map) ------------------

  const glossaryView = el('view-glossary');
  const contextMapView = el('view-contextmap');
  const outlineView = el('view-outline');
  const checkView = el('view-check');
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#tabs .tab'));
  const viewEls: Record<RightView, HTMLElement> = {
    preview: el('view-preview'),
    glossary: glossaryView,
    contextmap: contextMapView,
    outline: outlineView,
    check: checkView,
  };
  let activeView: RightView = 'preview';
  // Track which doc-based views need a (re)fetch — invalidated on every edit so a tab
  // switch always shows data for the current model rather than a stale render. The check
  // view is excluded: it is only (re)run on demand via the Check button.
  const docViewsLoaded: Record<'glossary' | 'contextmap' | 'outline', boolean> = {
    glossary: false,
    contextmap: false,
    outline: false,
  };

  function docMessage(view: HTMLElement, text: string, kind: 'muted' | 'error' = 'muted'): void {
    view.innerHTML = `<p class="${kind === 'error' ? 'doc-error' : 'muted'}">${text}</p>`;
  }

  async function loadGlossary(): Promise<void> {
    docMessage(glossaryView, 'Loading glossary…');
    try {
      const res = await lsp.glossary();
      if (!res.markdown || !res.markdown.trim()) {
        docMessage(glossaryView, 'Glossary is empty (the model may have syntax errors).');
      } else {
        glossaryView.innerHTML = `<div class="koi-md">${renderMarkdown(res.markdown)}</div>`;
      }
      docViewsLoaded.glossary = true;
    } catch (e) {
      docMessage(glossaryView, 'Glossary request failed: ' + String(e), 'error');
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

  function ensureLoaded(view: RightView): void {
    if (view === 'glossary' && !docViewsLoaded.glossary) void loadGlossary();
    if (view === 'contextmap' && !docViewsLoaded.contextmap) void loadContextMap();
    if (view === 'outline' && !docViewsLoaded.outline) void loadOutline();
  }

  // Mark the cached glossary/context-map/outline stale (e.g. after an edit or a file switch).
  function invalidateDocViews(): void {
    docViewsLoaded.glossary = false;
    docViewsLoaded.contextmap = false;
    docViewsLoaded.outline = false;
  }

  // An edit makes any cached glossary/context-map/outline stale. Mark them dirty; if a doc
  // view is on screen, refresh it (debounced) so it tracks the model without a manual click.
  let editDebounce: ReturnType<typeof setTimeout> | undefined;
  function onDocEdited(): void {
    invalidateDocViews();
    if (activeView === 'preview' || activeView === 'check') return;
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
    ensureLoaded(view);
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectView(tab.dataset.view as RightView));
  }

  // Refresh re-fetches the active doc view (preview is driven by its own buttons; check by
  // the Check… toolbar button which re-prompts for a baseline).
  el<HTMLButtonElement>('btn-refresh').addEventListener('click', () => {
    if (activeView === 'glossary') void loadGlossary();
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

  // Preview buttons. Previewing also surfaces the preview tab.
  const btnCs = el<HTMLButtonElement>('btn-preview-cs');
  const btnTs = el<HTMLButtonElement>('btn-preview-ts');

  function setPreviewBusy(busy: boolean): void {
    btnCs.disabled = busy;
    btnTs.disabled = busy;
  }

  async function preview(target: 'csharp' | 'typescript'): Promise<void> {
    selectView('preview');
    setPreviewBusy(true);
    try {
      const res = await lsp.emitPreview(target);
      let content: string;
      let lang: 'csharp' | 'typescript' | 'plain';
      let copyable = false;
      if (res.error) {
        content = '// emit error\n' + res.error;
        lang = 'plain';
      } else if (!res.files.length) {
        content = '// no files emitted (fix diagnostics first)';
        lang = 'plain';
      } else {
        content = res.files.map((f) => `// ==== ${f.path} ====\n${f.contents}`).join('\n\n');
        lang = target === 'csharp' ? 'csharp' : 'typescript';
        copyable = true;
      }
      output.setContent(content, lang);
      lastPreview = content;
      copyBtn.disabled = !copyable;
    } catch (e) {
      output.setContent('// preview request failed\n' + String(e), 'plain');
      lastPreview = '';
      copyBtn.disabled = true;
    } finally {
      setPreviewBusy(false);
    }
  }

  btnCs.addEventListener('click', () => void preview('csharp'));
  btnTs.addEventListener('click', () => void preview('typescript'));

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
      treeEl.hidden = true;
      return;
    }

    folderMode = true;
    // Activate the first file (sorted by relPath) and show the tree.
    const first = Array.from(buffers.values()).sort((a, b) => a.relPath.localeCompare(b.relPath))[0];
    activeUri = first.uri;
    lsp.setActive(first.uri);
    editor.setDoc(first.text);
    treeTitleEl.textContent = platform.folderName(folder);
    treeEl.hidden = false;
    pushRecentFolder(folder);
    invalidateDocViews();
    renderTree();
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
    if (mod && (e.key === 's' || e.key === 'S')) {
      if (overlayOpen()) return; // don't save the editor under an open overlay
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

  // --- new scratch model ----------------------------------------------------
  // Reset to a single untouched scratch buffer holding the SEED. In folder mode this
  // tears the folder workspace down (closes every open doc) and re-establishes scratch.
  function newScratch(): void {
    clearScratch(); // reset to the seed baseline; forget any restored scratch
    if (folderMode) {
      for (const uri of Array.from(buffers.keys())) lsp.closeDoc(uri);
      buffers.clear();
      diagnosticsByUri.clear();
      folderMode = false;
      treeEl.hidden = true;
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
      text: SEED,
      dirty: false,
    });
    activeUri = SCRATCH_URI;
    lsp.setActive(SCRATCH_URI);
    // Ensure the server has a fresh scratch doc, then load the SEED into the editor.
    lsp.openDoc(SCRATCH_URI, SEED);
    editor.setDoc(SEED);
    invalidateDocViews();
    renderTree();
    ensureLoaded(activeView);
    welcome.hide();
  }

  // --- overlays + polish surfaces -------------------------------------------

  const welcome = createWelcome({
    onNewScratch: () => newScratch(),
    onOpenFolder: () => void openFolder(),
    onOpenRecent: (path) => void openFolderPath(path),
  });

  const palette = createCommandPalette(() => getCommands());
  const prefs = createPreferences({
    onChange: (s) => {
      settings = s;
      applyFontSize(); // theme already applied live by prefs via setTheme
    },
  });
  const help = createHelpOverlay(helpRows());
  const about = createAboutDialog();

  initSplitResizer({ split: el('split'), handle: el('split-resizer') });

  // Toolbar buttons unique to this phase.
  const hintEl = document.querySelector('.palette-hint');
  if (hintEl) hintEl.textContent = formatChord('mod+K'); // ⌘+K / Ctrl+K per platform
  el<HTMLButtonElement>('btn-new').addEventListener('click', () => newScratch());
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
      { id: 'format', title: 'Format document', hint: 'mod+S', group: 'Edit', run: () => void formatActive() },
      { id: 'open-folder', title: 'Open folder…', hint: 'mod+Shift+O', group: 'File', run: () => void openFolder() },
      { id: 'new-scratch', title: 'New scratch model', hint: 'mod+N', group: 'File', run: () => newScratch() },
      { id: 'check', title: 'Check against baseline…', group: 'File', run: () => void runCheck() },
      { id: 'toggle-theme', title: 'Toggle theme', group: 'View', run: () => toggleTheme() },
      { id: 'prefs', title: 'Preferences…', hint: 'mod+,', group: 'View', run: () => prefs.open() },
      { id: 'help', title: 'Keyboard shortcuts', hint: 'F1', group: 'Help', run: () => help.open() },
      { id: 'about', title: 'About Koine Studio', group: 'Help', run: () => about.open() },
      { id: 'view-preview', title: 'Show Emitted Preview', group: 'Inspector', run: () => selectView('preview') },
      { id: 'view-glossary', title: 'Show Glossary', group: 'Inspector', run: () => selectView('glossary') },
      { id: 'view-contextmap', title: 'Show Context Map', group: 'Inspector', run: () => selectView('contextmap') },
      { id: 'view-outline', title: 'Show Outline', group: 'Inspector', run: () => selectView('outline') },
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
      newScratch();
    } else if (mod && e.key === '1') {
      e.preventDefault();
      void preview('csharp');
    } else if (mod && e.key === '2') {
      e.preventDefault();
      void preview('typescript');
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
        treeEl.hidden = !treeEl.hidden;
      }
    }
  });

  // Welcome screen on boot: shown only on a fresh start (no restored scratch). When the user has
  // unsaved work from a previous visit we resume straight into it. The first edit, New scratch,
  // Open folder, or opening a recent folder all hide it.
  if (restoredScratch === null) welcome.show();

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
