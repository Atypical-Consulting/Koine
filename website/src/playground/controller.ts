// Client controller for the Playground IDE. Wires the CodeMirror editor to the wasm compiler
// and drives the landing-page taste: live diagnostics, compile-on-change + ⌘⏎ run, target
// switching (C#/TS/Python/PHP/glossary/AsyncAPI/OpenAPI) with syntax-highlighted output, a grouped file tree, copy +
// download-as-zip, a mobile editor/output toggle, and the "Open in Studio" handoff.
import { createKoineEditor, createOutputView, type KoineEditor, type OutputView, type OutputLang } from './editor';
import { compile, preloadCompiler, type CompileResult, type Target } from './koine';
import { DEFAULT_SAMPLE } from './samples';
import { makeZip, downloadBlob } from './zip';
import { encodeCode } from './encode';

const TARGET_LANG: Record<Target, OutputLang> = {
  csharp: 'csharp',
  typescript: 'typescript',
  python: 'python',
  php: 'plain',
  glossary: 'plain',
  asyncapi: 'plain',
  openapi: 'plain',
};
/** Pick the most interesting file to show first: skip runtime + config boilerplate. */
function defaultFileIndex(result: CompileResult): number {
  const isBoilerplate = (p: string) =>
    p.startsWith('Koine/Runtime') ||
    p.startsWith('runtime') ||
    p.endsWith('.json') ||
    p.endsWith('runtime.ts');
  const i = result.files.findIndex((f) => !isBoilerplate(f.path));
  return i >= 0 ? i : 0;
}

export function mountPlayground(root: HTMLElement): void {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T | null;

  const editorHost = $('.koi-editor')!;
  const viewHost = $('.koi-view')!;
  const statusEl = $('.koi-status')!;
  const diagEl = $('.koi-diagnostics')!;
  const filePick = $<HTMLSelectElement>('.koi-filepick');
  const copyBtn = $<HTMLButtonElement>('.koi-copy');
  const downloadBtn = $<HTMLButtonElement>('.koi-download');
  const studioLink = $<HTMLAnchorElement>('.koi-studio');
  const targetBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-targets button'));
  const mobileBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-mobile-tabs button'));

  let target: Target = 'csharp';
  const cache = new Map<Target, CompileResult>();
  let activeFile = 0;
  let editor: KoineEditor;
  const output: OutputView = createOutputView(viewHost);

  const setStatus = (text: string, kind: 'idle' | 'busy' | 'ok' | 'err' = 'idle') => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  };

  const currentResult = () => cache.get(target);
  const currentFile = () => currentResult()?.files[activeFile] ?? currentResult()?.files[0];

  // Populate the file picker: grouped by directory (optgroups), everything sorted A→Z.
  function renderFilePicker(result: CompileResult) {
    if (!filePick) return;
    filePick.innerHTML = '';
    if (result.files.length === 0) {
      filePick.hidden = true;
      return;
    }
    filePick.hidden = false;

    const entries = result.files.map((f, idx) => {
      const slash = f.path.lastIndexOf('/');
      return {
        idx,
        dir: slash >= 0 ? f.path.slice(0, slash) : '',
        name: slash >= 0 ? f.path.slice(slash + 1) : f.path,
      };
    });
    const dirs = [...new Set(entries.map((e) => e.dir))].sort((a, b) => a.localeCompare(b));

    for (const dir of dirs) {
      const items = entries.filter((e) => e.dir === dir).sort((a, b) => a.name.localeCompare(b.name));
      const parent = dir ? document.createElement('optgroup') : null;
      if (parent) parent.label = dir;
      for (const it of items) {
        const opt = document.createElement('option');
        opt.value = String(it.idx);
        opt.textContent = it.name;
        (parent ?? filePick).appendChild(opt);
      }
      if (parent) filePick.appendChild(parent);
    }
    filePick.value = String(activeFile);
  }

  function renderCode(result: CompileResult) {
    const file = result.files[activeFile] ?? result.files[0];
    output.setContent(file ? file.contents : '// no output — fix the errors on the left', TARGET_LANG[target]);
    if (filePick && result.files.length) filePick.value = String(activeFile);
    if (copyBtn) copyBtn.disabled = !file;
    if (downloadBtn) downloadBtn.disabled = result.files.length === 0;
  }

  function renderDiagnostics(result: CompileResult) {
    diagEl.innerHTML = '';
    if (result.diagnostics.length === 0) {
      diagEl.hidden = true;
      return;
    }
    diagEl.hidden = false;
    for (const d of result.diagnostics) {
      const row = document.createElement('button');
      row.className = `koi-diag koi-diag--${d.severity}`;
      row.innerHTML =
        `<span class="koi-diag__pos">${d.line}:${d.col}</span>` +
        `<span class="koi-diag__code">${d.code}</span>` +
        `<span class="koi-diag__msg"></span>`;
      row.querySelector('.koi-diag__msg')!.textContent = d.message;
      row.onclick = () => editor.goto(d.line, d.col);
      diagEl.appendChild(row);
    }
  }

  function paint(result: CompileResult, ms?: number) {
    if (result.files.length && activeFile >= result.files.length) activeFile = 0;
    renderFilePicker(result);
    renderCode(result);
    renderDiagnostics(result);
    const errs = result.diagnostics.filter((d) => d.severity === 'error').length;
    const warns = result.diagnostics.filter((d) => d.severity === 'warning').length;
    const timing = ms != null ? ` · ${Math.round(ms)}ms` : '';
    if (errs > 0) {
      setStatus(`✗ ${errs} error${errs > 1 ? 's' : ''}${warns ? `, ${warns} warning${warns > 1 ? 's' : ''}` : ''}`, 'err');
    } else {
      setStatus(`✓ green build · ${result.files.length} file${result.files.length > 1 ? 's' : ''}${timing}`, 'ok');
    }
  }

  async function run(pickDefault = false) {
    if (cache.has(target)) {
      const r = cache.get(target)!;
      if (pickDefault) activeFile = defaultFileIndex(r);
      paint(r);
      return;
    }
    setStatus('compiling…', 'busy');
    const source = editor.getDoc();
    const started = performance.now();
    try {
      const result = await compile(source, target);
      cache.set(target, result);
      if (pickDefault) activeFile = defaultFileIndex(result);
      else if (result.files.length) activeFile = Math.min(activeFile, result.files.length - 1);
      paint(result, performance.now() - started);
    } catch (e) {
      setStatus('compiler failed to load', 'err');
      output.setContent(String(e), 'plain');
    }
  }

  function onDocChanged() {
    cache.clear();
    run();
  }

  // --- build editor ---
  const initialDoc = DEFAULT_SAMPLE.code;
  editor = createKoineEditor({
    parent: editorHost,
    doc: initialDoc,
    onChange: onDocChanged,
    lintSource: async (src) => {
      try {
        const r = await compile(src, target);
        cache.set(target, r);
        return r.diagnostics;
      } catch {
        return [];
      }
    },
  });

  // --- file picker ---
  if (filePick) {
    filePick.onchange = () => {
      const r = currentResult();
      if (!r) return;
      activeFile = Number(filePick.value);
      renderCode(r);
    };
  }

  // --- target tabs ---
  for (const btn of targetBtns) {
    btn.onclick = () => {
      target = (btn.dataset.target as Target) ?? 'csharp';
      activeFile = 0;
      targetBtns.forEach((b) => {
        const on = b === btn;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-selected', String(on));
      });
      run(true);
    };
    btn.setAttribute('aria-selected', String(btn.dataset.target === target));
    btn.classList.toggle('is-active', btn.dataset.target === target);
  }

  // --- copy current file ---
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const f = currentFile();
      if (!f) return;
      try {
        await navigator.clipboard.writeText(f.contents);
        flash(copyBtn, 'copied!');
      } catch {
        /* clipboard blocked */
      }
    };
  }

  // --- download all generated files as a .zip ---
  if (downloadBtn) {
    downloadBtn.onclick = () => {
      const r = currentResult();
      if (!r || !r.files.length) return;
      downloadBlob(makeZip(r.files), `koine-${target}.zip`);
      flash(downloadBtn, 'saved');
    };
  }

  // --- "open in Studio" carries the current model into the full web IDE ---
  // Studio reads `#model=<urlsafe-base64-utf8>` on boot (tooling/koine-studio/src/share.ts), which is
  // exactly what encodeCode produces — so the user's model opens in Studio, not a blank seed. Refresh
  // the href just before either activation path fires (pointerdown for mouse, focus for keyboard
  // tab-in before Enter) so it reflects the latest doc no matter how it changed — without
  // re-encoding the whole document on every keystroke.
  if (studioLink) {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    const update = () => {
      studioLink.href = `${base}/studio/#model=${encodeCode(editor.getDoc())}`;
    };
    update();
    studioLink.addEventListener('pointerdown', update);
    studioLink.addEventListener('focus', update);
  }

  // --- mobile editor/output toggle ---
  for (const btn of mobileBtns) {
    btn.onclick = () => {
      const v = btn.dataset.mobile ?? 'editor';
      root.dataset.view = v;
      mobileBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
    };
  }

  // Kick off the runtime download and first compile (landing on a meaningful file).
  setStatus('loading compiler…', 'busy');
  preloadCompiler();
  void run(true);
}

function flash(btn: HTMLButtonElement, text: string) {
  const prev = btn.textContent;
  btn.textContent = text;
  btn.classList.add('is-flash');
  setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove('is-flash');
  }, 1300);
}
