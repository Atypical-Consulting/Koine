// Headless smoke test: boots the published wasm AppBundle under Node and calls the
// compiler's [JSExport] surface, so we can verify the wasm module actually works (and that
// trimming, if enabled, didn't break reflection) without opening a browser.
//
//   node src/Koine.Wasm/smoke-test.mjs            # default: correctness asserts (always green)
//   node src/Koine.Wasm/smoke-test.mjs --bench    # adds a timing/size benchmark (KOINE_WASM_BENCH=1 also works)
//
// The --bench mode compiles the multi-file pizzeria template end-to-end (the same workspace
// EmitPreview path Koine Studio runs on every keystroke), times it over warm iterations, and
// prints pizzeria compile `ms` (best/median) plus the published _framework/ bundle size. It's
// the repeatable harness for the interpreter-vs-AOT trade-off measurement (issue #327): run it
// against an interpreter publish and again against a `-p:KoineWasmAot=true` publish to compare.
import { dotnet } from './bin/Release/net10.0/browser-wasm/AppBundle/_framework/dotnet.js';
import { performance } from 'node:perf_hooks';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BENCH = process.argv.includes('--bench') || process.env.KOINE_WASM_BENCH === '1';

const SOURCE = `context Billing {
  enum Currency { EUR, USD, GBP }
  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0 "a monetary amount cannot be negative"
  }
}`;

const runtime = await dotnet.create();
const config = runtime.getConfig();
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
const api = exports.Koine.Wasm.CompilerInterop;

// 1. Diagnose a clean source → expect zero diagnostics.
const diags = JSON.parse(api.Diagnose(SOURCE));
console.log('diagnostics (clean):', JSON.stringify(diags));

// 2. Compile to C# → expect ok + at least one file.
const csharp = JSON.parse(api.Compile(SOURCE, 'csharp'));
console.log('csharp ok:', csharp.ok, 'files:', csharp.files.length, csharp.files.map((f) => f.path));

// 3. Compile to TypeScript and glossary.
const ts = JSON.parse(api.Compile(SOURCE, 'typescript'));
console.log('typescript ok:', ts.ok, 'files:', ts.files.length);
const glossary = JSON.parse(api.Compile(SOURCE, 'glossary'));
console.log('glossary ok:', glossary.ok, 'files:', glossary.files.length);

// 4. Diagnose a broken source → expect an error with a code + position.
const bad = JSON.parse(api.Diagnose('context X { value M { amount: Decimal invariant amount >= 0 } }'));
console.log('diagnostics (broken):', JSON.stringify(bad));

// 5. Semantic tokens for a parsing source → expect a non-empty delta-encoded int stream (issue #329).
// Five ints per classified identifier; the same stream the stdio LSP emits (wire-parity tested).
const semtok = JSON.parse(api.SemanticTokens(SOURCE));
console.log('semantic tokens: data length', semtok.data.length, '(', semtok.data.length / 5, 'tokens )');

// 6. Capabilities() → the module's self-description: version + [JSExport] names + emit targets (issue #330).
// This is the single source of truth Koine Studio verifies its surface against at boot, so the smoke test
// guards that a trimmed bundle actually ships it with a real version, the export list (incl. Capabilities
// itself), and the registry's targets carrying full metadata.
const caps = JSON.parse(api.Capabilities());
console.log(
  'capabilities: version', caps.version,
  '| exports', caps.exports.length,
  '| targets', caps.targets.map((t) => t.id).join(','),
);
const capsOk =
  typeof caps.version === 'string' &&
  caps.version.length > 0 &&
  Array.isArray(caps.exports) &&
  caps.exports.includes('Capabilities') &&
  caps.exports.includes('Compile') &&
  Array.isArray(caps.targets) &&
  caps.targets.length > 0 &&
  caps.targets.every((t) => t.id && t.displayName && t.fileExtension);

// Assert the happy path.
const ok =
  diags.length === 0 &&
  csharp.ok &&
  csharp.files.length > 0 &&
  ts.ok &&
  glossary.ok &&
  Array.isArray(semtok.data) &&
  semtok.data.length > 0 &&
  semtok.data.length % 5 === 0 &&
  capsOk;
console.log(ok ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');

// 7. Optional benchmark: time compiling the pizzeria template and report bundle size (issue #327).
let benchOk = true;
if (BENCH) {
  benchOk = runBenchmark();
}

process.exit(ok && benchOk ? 0 : 1);

// ---------------------------------------------------------------------------------------------

function runBenchmark() {
  console.log('\n--- benchmark (KOINE_WASM_BENCH / --bench) ---');

  // Compile the whole pizzeria template the way Studio does: every .koi as a SourceFile in one
  // workspace, so the cross-context imports and the context map resolve (single-source Compile
  // can't represent a 7-file model). EmitPreview is the workspace emit path the editor calls.
  const pizzeriaDir = join(here, '..', '..', 'templates', 'pizzeria');
  const files = readdirSync(pizzeriaDir)
    .filter((f) => f.endsWith('.koi'))
    .sort()
    .map((f) => ({ uri: `file:///${f}`, text: readFileSync(join(pizzeriaDir, f), 'utf8') }));
  const filesJson = JSON.stringify(files);
  const totalKoiBytes = files.reduce((n, f) => n + Buffer.byteLength(f.text, 'utf8'), 0);
  console.log(`pizzeria: ${files.length} .koi files, ${totalKoiBytes} bytes of source`);

  // Verify the compile is clean before timing it — a benchmark of a failing compile is noise.
  const first = JSON.parse(api.EmitPreview(filesJson, 'csharp'));
  const errors = (first.diagnostics ?? []).filter((d) => d.severity === 1); // 1 = Error (LSP)
  const compileOk = !first.error && first.files.length > 0 && errors.length === 0;
  console.log(`pizzeria compile ok: ${compileOk}, emitted files: ${first.files.length}`);
  if (!compileOk) {
    console.log('BENCHMARK FAILED — pizzeria did not compile cleanly:', first.error ?? JSON.stringify(errors));
    return false;
  }

  // Warm the JIT/interpreter, then time a handful of runs. Report best + median: best is the
  // least-noisy floor, median resists the occasional GC/scheduler spike.
  const WARMUP = 3;
  const RUNS = 10;
  for (let i = 0; i < WARMUP; i++) api.EmitPreview(filesJson, 'csharp');
  const samples = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    api.EmitPreview(filesJson, 'csharp');
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const best = samples[0];
  const median = samples[Math.floor(samples.length / 2)];
  const ms = (n) => n.toFixed(1);

  // Sum the published _framework/ as shipped to the browser: this is what AOT grows.
  const framework = join(here, 'bin', 'Release', 'net10.0', 'browser-wasm', 'AppBundle', '_framework');
  const frameworkBytes = dirBytes(framework);
  const frameworkMB = (frameworkBytes / (1024 * 1024)).toFixed(2);

  console.log(
    `\npizzeria compile: best ${ms(best)} ms, median ${ms(median)} ms (over ${RUNS} runs, ${WARMUP} warmup)`,
  );
  console.log(`bundle (_framework total): ${frameworkBytes} bytes (${frameworkMB} MB)`);
  console.log(`BENCH RESULT  pizzeria_ms_best=${ms(best)}  pizzeria_ms_median=${ms(median)}  framework_mb=${frameworkMB}`);
  return true;
}

// Recursive sum of every regular file's byte length under `dir`.
function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += dirBytes(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}
