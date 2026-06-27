// Client controller for the Playground IDE. Wires the CodeMirror editor to the wasm compiler
// and drives the landing-page taste: live diagnostics, compile-on-change + ⌘⏎ run, target
// switching across whatever targets the compiler reports (derived from its ListEmitTargets export,
// #438) with syntax-highlighted output, a grouped file tree, copy + download-as-zip, a mobile
// editor/output toggle, and the "Open in Studio" handoff.
import { createKoineEditor, createOutputView, highlightModeForTarget, type KoineEditor, type OutputView } from './editor';
import { capabilities, compile, getBootMode, listEmitTargets, preloadCompiler, semanticTokens, terminateAndRespawn, type CompileResult, type EmitTarget, type Target } from './koine';
import { createSuperseder } from './supersede';
import { registerPlaygroundServiceWorker } from './sw-register';
import { DEFAULT_SAMPLE } from './samples';
import { makeZip, downloadBlob } from './zip';
import { encodeCode } from './encode';
import { basePath } from '../lib/base';

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
  const versionEl = $('.koi-version');
  const diagEl = $('.koi-diagnostics')!;
  const filePick = $<HTMLSelectElement>('.koi-filepick');
  const copyBtn = $<HTMLButtonElement>('.koi-copy');
  const downloadBtn = $<HTMLButtonElement>('.koi-download');
  const stopBtn = $<HTMLButtonElement>('.koi-stop');
  const studioLink = $<HTMLAnchorElement>('.koi-studio');
  const targetsHost = $('.koi-targets')!; // the tablist is populated at runtime from the live target list (#438)
  const mobileBtns = Array.from(root.querySelectorAll<HTMLButtonElement>('.koi-mobile-tabs button'));

  let target: Target = 'csharp';
  const cache = new Map<Target, CompileResult>();
  let activeFile = 0;
  let editor: KoineEditor;
  const output: OutputView = createOutputView(viewHost);

  // Per-operation superseders (#353): a newer edit aborts the prior in-flight call's signal — the
  // worker client then drops that call's pending id — so a stale compile/lint never lands. One each so
  // the two independent operations never cancel each other.
  const compileSup = createSuperseder();
  const lintSup = createSuperseder();

  const setStatus = (text: string, kind: 'idle' | 'busy' | 'ok' | 'err' = 'idle') => {
    statusEl.textContent = text;
    statusEl.dataset.kind = kind;
  };

  // The Stop affordance is shown only while a compile is in flight (a runaway compile to abandon).
  const setBusy = (busy: boolean) => {
    if (stopBtn) stopBtn.hidden = !busy;
  };
  setBusy(false);

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
    output.setContent(file ? file.contents : '// no output — fix the errors on the left', highlightModeForTarget(target));
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
    setBusy(true);
    const signal = compileSup.next();
    // Capture the target this compile is FOR: `target` is mutable (the tab buttons reassign it), so a
    // tab switch mid-compile must not make us cache/paint this result under the wrong target.
    const compiledTarget = target;
    const source = editor.getDoc();
    const started = performance.now();
    try {
      const result = await compile(source, compiledTarget, { signal });
      cache.set(compiledTarget, result);
      // The user switched tabs while this was compiling: the result is valid for its target (now
      // cached) but the view shows a different one — don't paint over it.
      if (compiledTarget !== target) return;
      if (pickDefault) activeFile = defaultFileIndex(result);
      else if (result.files.length) activeFile = Math.min(activeFile, result.files.length - 1);
      paint(result, performance.now() - started);
    } catch (e) {
      // Superseded by a newer edit (or stopped): drop quietly — a fresh compile owns the UI now.
      if (signal.aborted) return;
      setStatus('compiler failed to load', 'err');
      output.setContent(String(e), 'plain');
    } finally {
      // Leave the busy/Stop state to the newer compile if this one was superseded.
      if (!signal.aborted) setBusy(false);
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
      const signal = lintSup.next();
      try {
        const r = await compile(src, target, { signal });
        cache.set(target, r);
        return r.diagnostics;
      } catch {
        // Superseded by a newer edit (or failed): no squiggles to publish for this stale source.
        return [];
      }
    },
    // Semantic highlighting (#367): the extension fetches tokens for the live document (debounced on
    // change). `editor` isn't assigned yet during the editor's own construction (the plugin's first
    // fetch runs synchronously inside `new EditorView`), so fall back to `initialDoc` for that first
    // paint; every later fetch reads the current buffer. Token fetches degrade silently (the extension
    // swallows a rejected/terminated call), so no superseder is needed here.
    onSemanticTokens: () => semanticTokens(editor ? editor.getDoc() : initialDoc),
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

  // --- target tabs: rendered from the compiler's reported emit targets (#438) ---
  // The `ListEmitTargets` export is the single source of truth (the same list Koine Studio derives
  // from, #282/#293), so a newly-shipped backend target surfaces here with no website edit. Falls back
  // to a built-in set offline. The button label is the target's displayName; the highlight mode comes
  // from a presentation-only id→mode map (editor.ts), defaulting to plain text for unknown ids.
  function renderTargetTabs(targets: EmitTarget[]) {
    // Preserve the current selection if the list still offers it; otherwise pick the first target.
    if (!targets.some((t) => t.id === target)) target = targets[0]?.id ?? target;
    targetsHost.innerHTML = '';
    for (const t of targets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.dataset.target = t.id;
      btn.textContent = t.displayName;
      btn.onclick = () => {
        target = t.id;
        activeFile = 0;
        for (const b of targetsHost.querySelectorAll<HTMLButtonElement>('button')) {
          const on = b === btn;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', String(on));
        }
        run(true);
      };
      const on = t.id === target;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-selected', String(on));
      targetsHost.appendChild(btn);
    }
  }

  // --- Stop: abandon a runaway compile and re-boot a fresh worker (#353) ---
  if (stopBtn) {
    stopBtn.onclick = () => {
      // Drop the in-flight compile/lint, then terminate the worker and boot a fresh generation.
      // terminateAndRespawn() already re-points the singleton at the booting fresh worker, so no
      // separate preload is needed — the next edit's compile awaits it.
      compileSup.abort();
      lintSup.abort();
      terminateAndRespawn();
      setBusy(false);
      setStatus('stopped — edit to recompile', 'idle');
    };
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
    const base = basePath();
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

  // Cache-first the multi-MB wasm runtime so repeat visits boot instantly + offline (issue #328).
  registerPlaygroundServiceWorker();

  // Kick off the runtime download, build the target tabs from the compiler's reported targets (#438),
  // then run the first compile (landing on a meaningful file). listEmitTargets() awaits the same worker
  // boot the first compile does, so finalising the target before compiling adds no extra latency and
  // avoids a default-target race. It always resolves (falls back to the built-in set on failure).
  setStatus('loading compiler…', 'busy');
  preloadCompiler();
  void listEmitTargets().then((targets) => {
    renderTargetTabs(targets);
    void run(true);
    // Surface a degraded (main-thread) boot so the page and a maintainer can see the fallback won
    // (#510) — the worker boot failed but the compiler still came up on the UI thread. listEmitTargets()
    // awaits the same boot, so getBootMode() is settled here.
    if (getBootMode() === 'main-thread') {
      root.dataset.bootMode = 'main-thread';
      if (versionEl) {
        versionEl.title =
          'Compiler running on the main thread (the worker boot failed) — a large compile may briefly freeze the page.';
      }
    }
  });

  // Show the compiler version from the bundle's self-description (#330) — never a hard-coded string.
  // Persistent (its own element), so the transient compile status in `.koi-status` doesn't clobber it.
  if (versionEl) {
    void capabilities()
      .then((caps) => {
        // Only render a real version string — never "Koine undefined"/"Koine null" from a malformed payload.
        if (typeof caps.version === 'string' && caps.version.length > 0) {
          versionEl.textContent = `Koine ${caps.version}`;
        }
      })
      .catch(() => {
        /* leave the version label blank if the bundle can't report it */
      });
  }
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
