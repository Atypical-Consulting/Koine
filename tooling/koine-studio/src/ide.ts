// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the tabbed inspector (emitted preview,
// glossary, and context map).
import { createKoineEditor, createOutputView, renderMarkdown, setEditorDiagnostics } from './editor';
import { KoineLsp, type ContextMapResult, type LspDiagnostic } from './lsp';

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

type RightView = 'preview' | 'glossary' | 'contextmap';

export function init(): void {
  const editor = createKoineEditor({
    parent: el('editor-pane'),
    doc: SEED,
    onChange: (doc) => {
      lsp.didChange(doc);
      onDocEdited();
    },
    onHover: (line, character) => lsp.hover(line, character),
  });
  const output = createOutputView(el('view-preview'));

  const statusEl = el('status');
  const stripEl = el('diagnostics');

  const lsp = new KoineLsp();

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

  lsp.onPublishDiagnostics((_uri, diags) => {
    setEditorDiagnostics(editor.view, diags);
    renderStrip(diags);
    updateStatus(diags);
  });
  lsp.onServerExit((code) => {
    setStatus(`server exited (${code})`, 'error');
  });

  // --- tabbed inspector (preview / glossary / context map) ------------------

  const glossaryView = el('view-glossary');
  const contextMapView = el('view-contextmap');
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('#tabs .tab'));
  const viewEls: Record<RightView, HTMLElement> = {
    preview: el('view-preview'),
    glossary: glossaryView,
    contextmap: contextMapView,
  };
  let activeView: RightView = 'preview';
  // Track which doc-based views need a (re)fetch — invalidated on every edit so a tab
  // switch always shows data for the current model rather than a stale render.
  const docViewsLoaded: Record<'glossary' | 'contextmap', boolean> = {
    glossary: false,
    contextmap: false,
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

  function ensureLoaded(view: RightView): void {
    if (view === 'glossary' && !docViewsLoaded.glossary) void loadGlossary();
    if (view === 'contextmap' && !docViewsLoaded.contextmap) void loadContextMap();
  }

  // An edit makes any cached glossary/context-map stale. Mark them dirty; if a doc view is
  // on screen, refresh it (debounced) so it tracks the model without a manual click.
  let editDebounce: ReturnType<typeof setTimeout> | undefined;
  function onDocEdited(): void {
    docViewsLoaded.glossary = false;
    docViewsLoaded.contextmap = false;
    if (activeView === 'preview') return;
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

  // Refresh re-fetches the active doc view (preview is driven by its own buttons).
  el<HTMLButtonElement>('btn-refresh').addEventListener('click', () => {
    if (activeView === 'glossary') void loadGlossary();
    else if (activeView === 'contextmap') void loadContextMap();
  });

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
      if (res.error) {
        output.setContent('// emit error\n' + res.error, 'plain');
        return;
      }
      if (!res.files.length) {
        output.setContent('// no files emitted (fix diagnostics first)', 'plain');
        return;
      }
      const body = res.files.map((f) => `// ==== ${f.path} ====\n${f.contents}`).join('\n\n');
      output.setContent(body, target === 'csharp' ? 'csharp' : 'typescript');
    } catch (e) {
      output.setContent('// preview request failed\n' + String(e), 'plain');
    } finally {
      setPreviewBusy(false);
    }
  }

  btnCs.addEventListener('click', () => void preview('csharp'));
  btnTs.addEventListener('click', () => void preview('typescript'));

  // Boot: attach listeners (inside start) before messages flow, then open the doc.
  setStatus('connecting…', 'connecting');
  lsp.onServerRestart(() => {
    // Fresh sidecar is back in sync; refresh whatever doc view is showing.
    docViewsLoaded.glossary = false;
    docViewsLoaded.contextmap = false;
    ensureLoaded(activeView);
  });
  lsp
    .start()
    .then(() => {
      lsp.didOpen(editor.getDoc());
    })
    .catch((e) => {
      setStatus('connection failed', 'error');
      output.setContent('// failed to start language server\n' + String(e), 'plain');
    });
}
