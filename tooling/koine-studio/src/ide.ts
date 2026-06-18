// Koine Studio app composition: wires the .koi editor, the live LSP diagnostics,
// the status line, the diagnostics strip, and the emit-preview output pane.
import { createKoineEditor, createOutputView, setEditorDiagnostics } from './editor';
import { KoineLsp, type LspDiagnostic } from './lsp';

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

export function init(): void {
  const editor = createKoineEditor({
    parent: el('editor-pane'),
    doc: SEED,
    onChange: (doc) => lsp.didChange(doc),
  });
  const output = createOutputView(el('output-pane'));

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

  // Preview buttons.
  const btnCs = el<HTMLButtonElement>('btn-preview-cs');
  const btnTs = el<HTMLButtonElement>('btn-preview-ts');

  function setPreviewBusy(busy: boolean): void {
    btnCs.disabled = busy;
    btnTs.disabled = busy;
  }

  async function preview(target: 'csharp' | 'typescript'): Promise<void> {
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
