// Source-guard for the Playground wasm worker's message-loop installation (issue #492 / #357 / #358).
//
// The whole bug: the worker must install its message loop via `self.addEventListener('message', …)`
// AFTER `dotnet.create()` has resolved — NEVER as a top-level `self.onmessage = …`. Assigning
// `self.onmessage` synchronously at worker startup clobbers the `message` channel the .NET WebAssembly
// runtime installs while `dotnet.create()` boots inside a Worker, so the boot deadlocks: the runtime
// downloads but `create()` never settles (no `ready`, no `boot-failure`), and the host waits out its
// 30s timer ("Koine worker timed out after 30s"). This is the exact #357/#358 Studio hang,
// re-introduced on the website copy as #492.
//
// Why a SOURCE guard (not an import-and-drive test like Studio's): koine.worker.ts has top-level boot
// side effects — importing it kicks off `bootRuntime()` (a worker-side `import(dotnet.js)`), which has
// no meaning in a Node test env. So this guard reads the worker SOURCE as text and asserts the rule
// structurally, failing the build the instant the clobber pattern returns. Comments are stripped first
// so the file's own CRITICAL comment — which intentionally NAMES the forbidden pattern — can't trip it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const workerSrc = readFileSync(fileURLToPath(new URL('./koine.worker.ts', import.meta.url)), 'utf8');

// Strip comments so the guard inspects executable CODE only. The worker DOCUMENTS the forbidden
// `self.onmessage =` pattern in a CRITICAL comment (#357), and that prose must not fail the guard.
const workerCode = workerSrc
  .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
  .replace(/^\s*\/\/.*$/gm, ''); // whole-line // comments

describe('koine.worker.ts message-loop installation (#492 / #357 / #358)', () => {
  it('installs the message loop via addEventListener("message", …)', () => {
    expect(workerCode).toMatch(/addEventListener\(\s*['"]message['"]/);
  });

  it('never assigns a top-level self.onmessage = (it clobbers the runtime channel during boot)', () => {
    expect(workerCode).not.toMatch(/self\.onmessage\s*=/);
  });
});
