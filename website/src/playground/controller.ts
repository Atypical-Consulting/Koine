// Client controller for the Playground IDE. Wires the CodeMirror editor to the wasm compiler:
// live diagnostics, compile-on-change, target switching (C#/TS/glossary), a file browser,
// a clickable diagnostics panel, sample loading, and ?example=/?code= deep-linking + Share.
import { createKoineEditor, type KoineEditor } from './editor';
import { compile, preloadCompiler, type CompileResult, type Target } from './koine';
import { SAMPLES, DEFAULT_SAMPLE, sampleById } from './samples';

const TARGETS: Target[] = ['csharp', 'typescript', 'glossary'];

function encodeCode(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCode(param: string): string {
  const b64 = param.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function initialSource(embedded: boolean): { code: string; sampleId: string } {
  if (!embedded) {
    const params = new URLSearchParams(location.search);
    const codeParam = params.get('code');
    if (codeParam) {
      try {
        return { code: decodeCode(codeParam), sampleId: '' };
      } catch {
        /* fall through to sample */
      }
    }
    const sample = sampleById(params.get('example'));
    if (sample) return { code: sample.code, sampleId: sample.id };
  }
  return { code: DEFAULT_SAMPLE.code, sampleId: DEFAULT_SAMPLE.id };
}

export function mountPlayground(root: HTMLElement): void {
  const embedded = root.dataset.embedded === 'true';
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T | null;

  const editorHost = $('.koi-editor')!;
  const statusEl = $('.koi-status')!;
  const filesEl = $('.koi-files')!;
  const codeEl = $('.koi-code code')!;
  const diagEl = $('.koi-diagnostics')!;
  const sampleSel = $<HTMLSelectElement>('.koi-sample');
  const shareBtn = $<HTMLButtonElement>('.koi-share');
  const openLink = $<HTMLAnchorElement>('.koi-open');
  const targetBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-targets button'));

  let target: Target = 'csharp';
  let cache = new Map<Target, CompileResult>();
  let activeFile = 0;
  let editor: KoineEditor;

  const setStatus = (text: string, kind: 'idle' | 'busy' | 'ok' | 'err' = 'idle') => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  };

  function renderFiles(result: CompileResult) {
    if (embedded || result.files.length <= 1) {
      filesEl.hidden = true;
    } else {
      filesEl.hidden = false;
      filesEl.innerHTML = '';
      result.files.forEach((f, i) => {
        const b = document.createElement('button');
        b.className = 'koi-file' + (i === activeFile ? ' is-active' : '');
        b.textContent = f.path;
        b.onclick = () => {
          activeFile = i;
          renderFiles(result);
          renderCode(result);
        };
        filesEl.appendChild(b);
      });
    }
  }

  function renderCode(result: CompileResult) {
    const file = result.files[activeFile] ?? result.files[0];
    codeEl.textContent = file ? file.contents : '// no output — fix the errors on the left';
  }

  function renderDiagnostics(result: CompileResult) {
    const errs = result.diagnostics;
    if (errs.length === 0) {
      diagEl.hidden = true;
      diagEl.innerHTML = '';
      return;
    }
    diagEl.hidden = false;
    diagEl.innerHTML = '';
    for (const d of errs) {
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

  function paint(result: CompileResult) {
    if (result.files.length && activeFile >= result.files.length) activeFile = 0;
    renderFiles(result);
    renderCode(result);
    renderDiagnostics(result);
    const errCount = result.diagnostics.filter((d) => d.severity === 'error').length;
    if (errCount > 0) {
      setStatus(`✗ ${errCount} error${errCount > 1 ? 's' : ''}`, 'err');
    } else {
      setStatus(`✓ green build · ${result.files.length} file${result.files.length > 1 ? 's' : ''}`, 'ok');
    }
  }

  async function run() {
    if (cache.has(target)) {
      paint(cache.get(target)!);
      return;
    }
    setStatus('compiling…', 'busy');
    const source = editor.getDoc();
    try {
      const result = await compile(source, target);
      cache.set(target, result);
      paint(result);
    } catch (e) {
      setStatus('compiler failed to load', 'err');
      codeEl.textContent = String(e);
    }
  }

  function onDocChanged() {
    cache.clear();
    if (sampleSel) sampleSel.value = ''; // edited away from a named sample
    run();
  }

  // --- build editor ---
  const { code, sampleId } = initialSource(embedded);
  editor = createKoineEditor({
    parent: editorHost,
    doc: code,
    onChange: onDocChanged,
    // Lint via a full compile's diagnostics (cached and reused by run()).
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
    for (const s of SAMPLES) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label;
      sampleSel.appendChild(opt);
    }
    sampleSel.value = sampleId;
    sampleSel.onchange = () => {
      const s = sampleById(sampleSel.value);
      if (!s) return;
      cache.clear();
      activeFile = 0;
      editor.setDoc(s.code);
      run();
    };
  }

  // --- target tabs ---
  for (const btn of targetBtns) {
    btn.onclick = () => {
      target = (btn.dataset.target as Target) ?? 'csharp';
      activeFile = 0;
      targetBtns.forEach((b) => b.classList.toggle('is-active', b === btn));
      run();
    };
  }

  // --- share (full page only) ---
  if (shareBtn && !embedded) {
    shareBtn.onclick = async () => {
      const url = new URL(location.href);
      url.searchParams.delete('example');
      url.searchParams.set('code', encodeCode(editor.getDoc()));
      history.replaceState(null, '', url.toString());
      try {
        await navigator.clipboard.writeText(url.toString());
        const prev = shareBtn.textContent;
        shareBtn.textContent = 'link copied!';
        setTimeout(() => (shareBtn.textContent = prev), 1500);
      } catch {
        /* clipboard blocked — URL is still updated */
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

  // Kick off the runtime download and first compile.
  setStatus('loading compiler…', 'busy');
  preloadCompiler();
  run();
}
