// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import { createGenerateProject, type GenerateProjectDeps, type GenerateProjectHandle } from '@/export/generateProjectWizard';
import type { EmitPreviewResult } from '@/lsp/lsp';

// Flush queued microtasks + timers so the wizard's async steps (emitPreview, zip build) settle.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await flush();
}

function previewOk(target = 'csharp', ext = 'cs'): EmitPreviewResult {
  return {
    target,
    files: [
      { path: `Billing/Orders/Order.${ext}`, contents: '// order' },
      { path: `Billing/Money.${ext}`, contents: '// money' },
    ],
    diagnostics: [],
    error: null,
  };
}

function primary(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.koi-wizard-btn.primary')!;
}
function backButton(): HTMLButtonElement {
  // The footer is [Back, Primary]; select Back by position (happy-dom mis-handles :not(.primary)).
  return document.querySelector('.koi-wizard-footer')!.children[0] as HTMLButtonElement;
}
function announcer(): HTMLElement {
  return document.querySelector<HTMLElement>('.koi-sr-only[aria-live]')!;
}
async function clickNext(): Promise<void> {
  primary().click();
  await settle();
}
function saveZipCalls(deps: GenerateProjectDeps): unknown[][] {
  return (deps.saveZip as ReturnType<typeof vi.fn>).mock.calls;
}
// Poll a real condition across flushes instead of guessing a fixed tick count.
async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await flush();
  }
  throw new Error('waitFor: condition was not met within the flush budget');
}
// Click Generate and wait until the flow actually reaches saveZip. The generate path builds a real
// archive (JSZip.generateAsync schedules its work across several macrotasks) and, with the glossary
// option, awaits an extra fetch first — a fixed flush count races that, so poll for the real signal.
async function clickGenerate(deps: GenerateProjectDeps): Promise<void> {
  primary().click();
  await waitFor(() => saveZipCalls(deps).length > 0);
  await settle();
}
function checkRowByText(re: RegExp): HTMLInputElement {
  const row = Array.from(document.querySelectorAll('.koi-wizard-check')).find((r) => re.test(r.textContent ?? ''));
  return row!.querySelector<HTMLInputElement>('input')!;
}

function makeDeps(over: Partial<GenerateProjectDeps> = {}): GenerateProjectDeps {
  return {
    emitPreview: vi.fn(async () => previewOk()),
    glossary: vi.fn(async () => ({ markdown: '# Glossary' })),
    saveZip: vi.fn(async () => true),
    ...over,
  };
}

// Track opened wizards so each test cleans up its modal (unregistering from overlay.ts's shared Esc
// stack) rather than leaking a stale close-fn into the next test.
const openHandles: GenerateProjectHandle[] = [];
function openWizard(deps: GenerateProjectDeps): GenerateProjectHandle {
  const h = createGenerateProject(deps);
  h.open();
  openHandles.push(h);
  return h;
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  for (const h of openHandles) h.close();
  openHandles.length = 0;
});

describe('generate-project wizard', () => {
  it('walks the steps and saves a zip rooted at the project name, with a .csproj', async () => {
    const deps = makeDeps();
    openWizard(deps);

    // Step 0 (Language) → compiles, then Step 1 (Artifacts).
    expect(document.querySelector('.koi-wizard-option')).not.toBeNull();
    await clickNext();
    expect(deps.emitPreview).toHaveBeenCalledWith('csharp');

    // Step 1 (Artifacts) → Step 2 (Name); default name derived from the first namespaced path.
    await clickNext();
    const nameInput = document.querySelector<HTMLInputElement>('#koi-gen-name')!;
    expect(nameInput.value).toBe('Billing'); // first namespaced segment
    // Rename the project (the emitted namespace folders sit unchanged under this root).
    nameInput.value = 'Shop';
    nameInput.dispatchEvent(new Event('input'));

    // Step 2 (Name) → Step 3 (Generate) → generate.
    await clickNext();
    await clickGenerate(deps);

    expect(deps.saveZip).toHaveBeenCalledTimes(1);
    const [name, bytes] = saveZipCalls(deps)[0];
    expect(name).toBe('Shop.zip');

    const zip = await JSZip.loadAsync(bytes as Uint8Array);
    expect(zip.file('Shop/Billing/Orders/Order.cs')).not.toBeNull();
    expect(zip.file('Shop/Billing/Money.cs')).not.toBeNull();
    expect(zip.file('Shop/Shop.csproj')).not.toBeNull(); // included by default for C#
    expect(zip.file('Shop/glossary.md')).toBeNull(); // glossary unchecked
  });

  it('includes glossary.md when the glossary artifact is checked', async () => {
    const deps = makeDeps();
    openWizard(deps);
    await clickNext(); // → Artifacts

    const glossaryCheck = checkRowByText(/glossary/i);
    glossaryCheck.checked = true;
    glossaryCheck.dispatchEvent(new Event('change'));

    await clickNext(); // → Name
    await clickNext(); // → Generate
    await clickGenerate(deps); // generate

    expect(deps.glossary).toHaveBeenCalledTimes(1);
    const [, bytes] = saveZipCalls(deps)[0];
    const zip = await JSZip.loadAsync(bytes as Uint8Array);
    expect(await zip.file('Billing/glossary.md')!.async('string')).toBe('# Glossary');
  });

  it('still downloads when the glossary fetch fails', async () => {
    const deps = makeDeps({
      glossary: vi.fn(async () => {
        throw new Error('no glossary');
      }),
    });
    openWizard(deps);
    await clickNext(); // → Artifacts
    const glossaryCheck = checkRowByText(/glossary/i);
    glossaryCheck.checked = true;
    glossaryCheck.dispatchEvent(new Event('change'));
    await clickNext(); // → Name
    await clickNext(); // → Generate
    await clickGenerate(deps); // generate

    expect(deps.saveZip).toHaveBeenCalledTimes(1);
    const [, bytes] = saveZipCalls(deps)[0];
    const zip = await JSZip.loadAsync(bytes as Uint8Array);
    expect(zip.file('Billing/glossary.md')).toBeNull(); // glossary failure omitted it
    expect(zip.file('Billing/Billing/Orders/Order.cs')).not.toBeNull(); // source still bundled
  });

  it('switches to TypeScript, recompiles, and omits the csproj', async () => {
    const deps = makeDeps({
      emitPreview: vi.fn(async (t: 'csharp' | 'typescript') => previewOk(t, t === 'csharp' ? 'cs' : 'ts')),
    });
    openWizard(deps);
    await clickNext(); // compile C# → Artifacts
    expect(deps.emitPreview).toHaveBeenCalledWith('csharp');

    backButton().click(); // → Language
    await settle();
    const ts = document.querySelector<HTMLInputElement>('input[name="koi-gen-target"][value="typescript"]')!;
    ts.checked = true;
    ts.dispatchEvent(new Event('change'));

    await clickNext(); // recompile TS → Artifacts
    expect(deps.emitPreview).toHaveBeenCalledWith('typescript');
    expect(deps.emitPreview).toHaveBeenCalledTimes(2);
    // The csproj artifact is C#-only and must not appear for TypeScript.
    const csprojRow = Array.from(document.querySelectorAll('.koi-wizard-check')).some((r) => /\.csproj/.test(r.textContent ?? ''));
    expect(csprojRow).toBe(false);

    await clickNext(); // → Name
    await clickNext(); // → Generate
    await clickGenerate(deps); // generate

    const [, bytes] = saveZipCalls(deps)[0];
    const zip = await JSZip.loadAsync(bytes as Uint8Array);
    expect(zip.file('Billing/Billing.csproj')).toBeNull(); // no csproj for TS
    expect(zip.file('Billing/Billing/Orders/Order.ts')).not.toBeNull();
  });

  it('switches to Rust, recompiles, and bundles the .rs files (no csproj)', async () => {
    const deps = makeDeps({
      emitPreview: vi.fn(async (t: 'csharp' | 'rust') => previewOk(t, t === 'csharp' ? 'cs' : 'rs')),
    });
    openWizard(deps);
    await clickNext(); // compile C# → Artifacts
    expect(deps.emitPreview).toHaveBeenCalledWith('csharp');

    backButton().click(); // → Language
    await settle();
    const rs = document.querySelector<HTMLInputElement>('input[name="koi-gen-target"][value="rust"]')!;
    rs.checked = true;
    rs.dispatchEvent(new Event('change'));

    await clickNext(); // recompile Rust → Artifacts
    expect(deps.emitPreview).toHaveBeenCalledWith('rust');
    expect(deps.emitPreview).toHaveBeenCalledTimes(2);
    // The csproj artifact is C#-only and must not appear for Rust.
    const csprojRow = Array.from(document.querySelectorAll('.koi-wizard-check')).some((r) => /\.csproj/.test(r.textContent ?? ''));
    expect(csprojRow).toBe(false);

    await clickNext(); // → Name
    await clickNext(); // → Generate
    await clickGenerate(deps); // generate

    const [, bytes] = saveZipCalls(deps)[0];
    const zip = await JSZip.loadAsync(bytes as Uint8Array);
    expect(zip.file('Billing/Billing.csproj')).toBeNull(); // no csproj for Rust
    expect(zip.file('Billing/Billing/Orders/Order.rs')).not.toBeNull();
  });

  it('Back returns to the previous step and is disabled on the first step', async () => {
    const deps = makeDeps();
    openWizard(deps);
    await clickNext(); // → Artifacts
    await clickNext(); // → Name
    expect(document.querySelector('#koi-gen-name')).not.toBeNull();

    backButton().click(); // → Artifacts
    await settle();
    expect(document.querySelector('#koi-gen-name')).toBeNull();
    expect(document.querySelector('.koi-wizard-check')).not.toBeNull();

    backButton().click(); // → Language
    await settle();
    expect(document.querySelector('.koi-wizard-option')).not.toBeNull();
    expect(backButton().disabled).toBe(true);
  });

  it('holds on the Language step and announces an error when emit fails', async () => {
    const deps = makeDeps({
      emitPreview: vi.fn(async () => ({ target: 'csharp', files: [], diagnostics: [], error: 'boom' })),
    });
    openWizard(deps);
    await clickNext(); // compile fails → does NOT advance past Language

    expect(document.querySelector('.koi-wizard-option')).not.toBeNull(); // still on Language
    const banner = document.querySelector('.koi-wizard-banner.error')!;
    expect(banner.textContent).toMatch(/boom/);
    expect(announcer().textContent).toMatch(/boom/); // announced via the live region
    expect(primary().textContent).toBe('Next');
    expect(deps.saveZip).not.toHaveBeenCalled();
  });

  it('disables Next on the Name step for an invalid project name', async () => {
    const deps = makeDeps();
    openWizard(deps);
    await clickNext(); // → Artifacts
    await clickNext(); // → Name

    const nameInput = document.querySelector<HTMLInputElement>('#koi-gen-name')!;
    nameInput.value = '1 bad name';
    nameInput.dispatchEvent(new Event('input'));
    expect(primary().disabled).toBe(true);
    expect(nameInput.getAttribute('aria-invalid')).toBe('true');
    expect(nameInput.getAttribute('aria-describedby')).toBe('koi-gen-name-err');

    nameInput.value = 'Acme.Billing';
    nameInput.dispatchEvent(new Event('input'));
    expect(primary().disabled).toBe(false);
    expect(nameInput.getAttribute('aria-invalid')).toBe('false');
    expect(nameInput.getAttribute('aria-describedby')).toBeNull(); // not described by a hidden error
  });

  it('does not report success when the save is cancelled', async () => {
    const deps = makeDeps({ saveZip: vi.fn(async () => false) });
    openWizard(deps);
    await clickNext();
    await clickNext();
    await clickNext();
    await clickGenerate(deps); // generate → save cancelled

    expect(deps.saveZip).toHaveBeenCalledTimes(1);
    expect(primary().textContent).toBe('Generate'); // not relabelled to 'Close'
    expect(document.querySelector('.koi-wizard-banner.success')).toBeNull();
    expect(document.querySelector('.koi-wizard-banner')!.textContent).toMatch(/cancel/i);
  });

  it('surfaces an error and does not complete when saving throws', async () => {
    const deps = makeDeps({
      saveZip: vi.fn(async () => {
        throw new Error('disk full');
      }),
    });
    openWizard(deps);
    await clickNext();
    await clickNext();
    await clickNext();
    await clickGenerate(deps); // generate → save throws

    expect(deps.saveZip).toHaveBeenCalledTimes(1);
    expect(primary().textContent).toBe('Generate');
    const banner = document.querySelector('.koi-wizard-banner.error')!;
    expect(banner.textContent).toMatch(/disk full/);
  });

  it('the Close button after success closes the modal without re-downloading', async () => {
    const deps = makeDeps();
    openWizard(deps);
    await clickNext();
    await clickNext();
    await clickNext();
    await clickGenerate(deps); // generate succeeds

    expect(deps.saveZip).toHaveBeenCalledTimes(1);
    expect(primary().textContent).toBe('Close');
    expect(document.querySelector('.koi-wizard-banner.success')).not.toBeNull();

    primary().click(); // Close
    await settle();
    expect(deps.saveZip).toHaveBeenCalledTimes(1); // did NOT re-download
    expect(document.querySelector('.koi-modal-backdrop')!.hasAttribute('hidden')).toBe(true);
  });

  it('reopening after a generation discards the in-flight save of the previous session', async () => {
    // A deferred saveZip lets us close + reopen while the first session's save is still pending.
    let resolveSave: (v: boolean) => void = () => {};
    const deps = makeDeps({
      saveZip: vi.fn(
        () =>
          new Promise<boolean>((r) => {
            resolveSave = r;
          }),
      ),
    });
    const handle = openWizard(deps);
    await clickNext();
    await clickNext();
    await clickNext();
    primary().click(); // start generate → saveZip pending
    await settle();

    handle.close(); // user dismisses mid-save
    handle.open(); // fresh session
    await settle();
    expect(document.querySelector('.koi-wizard-option')).not.toBeNull(); // back at Language

    resolveSave(true); // the stale save now resolves
    await settle();
    // The stale completion must NOT mark the fresh session done / show success.
    expect(document.querySelector('.koi-wizard-banner.success')).toBeNull();
    expect(primary().textContent).toBe('Next');
  });
});
