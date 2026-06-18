// Client controller for the Playground IDE. Wires the CodeMirror editor to the wasm compiler
// and drives the full ergonomic surface: live diagnostics, compile-on-change + ⌘⏎ run, target
// switching (C#/TS/Python/glossary) with syntax-highlighted output, a grouped file tree, copy +
// download-as-zip, a resizable split, a mobile editor/output toggle, localStorage persistence,
// and ?example=/?code= deep-linking + Share.
import { createKoineEditor, createOutputView, type KoineEditor, type OutputView, type OutputLang } from './editor';
import { compile, preloadCompiler, type CompileResult, type Target } from './koine';
import { SAMPLES, DEFAULT_SAMPLE, sampleById } from './samples';
import { makeZip, downloadBlob } from './zip';

const TARGET_LANG: Record<Target, OutputLang> = {
  csharp: 'csharp',
  typescript: 'typescript',
  python: 'python',
  glossary: 'plain',
};
const LS ={ buffer: 'koine-pg-buffer', target: 'koine-pg-target', split: 'koine-pg-split' };

function encodeCode(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCode(param: string): string {
  const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function readLS(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

function initialSource(embedded: boolean): { code: string; sampleId: string } {
  if (embedded) return { code: DEFAULT_SAMPLE.code, sampleId: DEFAULT_SAMPLE.id };

  const params = new URLSearchParams(location.search);
  const codeParam = params.get('code');
  if (codeParam) {
    try {
      return { code: decodeCode(codeParam), sampleId: '' };
    } catch {
      /* fall through */
    }
  }
  const sample = sampleById(params.get('example'));
  if (sample) return { code: sample.code, sampleId: sample.id };

  const saved = readLS(LS.buffer);
  if (saved) return { code: saved, sampleId: '' };

  return { code: DEFAULT_SAMPLE.code, sampleId: DEFAULT_SAMPLE.id };
}

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
  const embedded = root.dataset.embedded === 'true';
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T | null;

  const editorHost = $('.koi-editor')!;
  const viewHost = $('.koi-view')!;
  const statusEl = $('.koi-status')!;
  const diagEl = $('.koi-diagnostics')!;
  const filePick = $<HTMLSelectElement>('.koi-filepick');
  const sampleSel = $<HTMLSelectElement>('.koi-sample');
  const shareBtn = $<HTMLButtonElement>('.koi-share');
  const copyBtn = $<HTMLButtonElement>('.koi-copy');
  const downloadBtn = $<HTMLButtonElement>('.koi-download');
  const resetBtn = $<HTMLButtonElement>('.koi-reset');
  const openLink = $<HTMLAnchorElement>('.koi-open');
  const resizer = $('.koi-resizer');
  const targetBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-targets button'));
  const mobileBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-mobile-tabs button'));

  let target: Target = 'csharp';
  if (!embedded) {
    const savedTarget = readLS(LS.target) as Target | null;
    if (savedTarget && savedTarget in TARGET_LANG) target = savedTarget;
  }
  const cache = new Map<Target, CompileResult>();
  let activeFile = 0;
  let currentSampleId = '';
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

  function onDocChanged(doc: string) {
    cache.clear();
    currentSampleId = '';
    if (sampleSel) sampleSel.value = '';
    if (!embedded) writeLS(LS.buffer, doc);
    run();
  }

  // --- build editor ---
  const init = initialSource(embedded);
  currentSampleId = init.sampleId;
  editor = createKoineEditor({
    parent: editorHost,
    doc: init.code,
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

  // --- samples dropdown (full page only) ---
  if (sampleSel && !embedded) {
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = init.sampleId ? '— samples —' : '(custom)';
    sampleSel.appendChild(blank);
    for (const s of SAMPLES) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      sampleSel.appendChild(opt);
    }
    sampleSel.value = init.sampleId;
    sampleSel.onchange = () => {
      const s = sampleById(sampleSel.value);
      if (!s) return;
      cache.clear();
      currentSampleId = s.id;
      activeFile = 0;
      editor.setDoc(s.code);
      writeLS(LS.buffer, s.code);
      run(true);
    };
  }

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
      if (!embedded) writeLS(LS.target, target);
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

  // --- reset to the current sample ---
  if (resetBtn) {
    resetBtn.onclick = () => {
      const s = sampleById(currentSampleId) ?? DEFAULT_SAMPLE;
      cache.clear();
      activeFile = 0;
      currentSampleId = s.id;
      editor.setDoc(s.code);
      if (sampleSel) sampleSel.value = s.id;
      writeLS(LS.buffer, s.code);
      run(true);
    };
  }

  // --- share ---
  if (shareBtn && !embedded) {
    shareBtn.onclick = async () => {
      const url = new URL(location.href);
      url.searchParams.delete('example');
      url.searchParams.set('code', encodeCode(editor.getDoc()));
      history.replaceState(null, '', url.toString());
      try {
        await navigator.clipboard.writeText(url.toString());
        flash(shareBtn, 'link copied!');
      } catch {
        /* URL still updated */
      }
    };
  }

  // --- embedded "open full playground" carries the current code ---
  if (openLink && embedded) {
    const base = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
    const update = () => {
      openLink.href = `${base}/playground/?code=${encodeCode(editor.getDoc())}`;
    };
    update();
    editorHost.addEventListener('keyup', update);
  }

  // --- mobile editor/output toggle ---
  for (const btn of mobileBtns) {
    btn.onclick = () => {
      const v = btn.dataset.mobile ?? 'editor';
      root.dataset.view = v;
      mobileBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
    };
  }

  // --- resizable split (full page, desktop) ---
  if (resizer && !embedded) {
    const savedSplit = readLS(LS.split);
    if (savedSplit) root.style.setProperty('--koi-editor-w', savedSplit);
    let dragging = false;
    const body = $('.koi-ide__body')!;
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const rect = body.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(80, Math.max(20, pct));
      const val = `${clamped.toFixed(1)}%`;
      root.style.setProperty('--koi-editor-w', val);
      writeLS(LS.split, val);
    };
    resizer.addEventListener('pointerdown', (e) => {
      dragging = true;
      (e.target as HTMLElement).setPointerCapture((e as PointerEvent).pointerId);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    resizer.addEventListener('pointermove', onMove as EventListener);
    resizer.addEventListener('pointerup', (e) => {
      dragging = false;
      (e.target as HTMLElement).releasePointerCapture((e as PointerEvent).pointerId);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
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
