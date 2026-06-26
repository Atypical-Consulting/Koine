// Headless smoke test: boots the published wasm AppBundle under Node and calls the compiler's
// whole [JSExport] surface, so we can verify the wasm module actually works — and, critically,
// that trimming (PublishTrimmed=true / TrimMode=full, with Koine.Compiler + Antlr4.Runtime.Standard
// rooted whole because Ast/NodeWalker reflects and ANTLR deserializes its ATN) didn't break the
// reflection-heavy paths — without opening a browser (issue #333).
//
//   node src/Koine.Wasm/smoke-test.mjs            # correctness asserts + pizzeria compile benchmark
//   node src/Koine.Wasm/smoke-test.mjs --bench    # adds the detailed timing/size breakdown (KOINE_WASM_BENCH=1 too)
//
// Every export family in CompilerInterop / CompilerInterop.LanguageService.cs is called once against
// the REAL published bundle off a small shared fixture, asserting the call doesn't crash and returns
// JSON of a plausible shape (object vs array, the documented top-level keys, JSON `null` where the
// export returns it) — NOT deep correctness, which stays the desktop wire-parity suite's job
// (tests/Koine.Wasm.Tests/*WireParityTests.cs, which run on desktop .NET and so cannot catch a
// trim/runtime failure here). A Capabilities()-driven coverage guard fails the run if the bundle
// ships a [JSExport] no check exercises, so the surface can't silently drift out of coverage.
//
// The benchmark compiles the multi-file pizzeria template end-to-end (the same workspace EmitPreview
// path Koine Studio runs on every keystroke), times it, prints `pizzeria compile: elapsed=NNNms`, and
// fails on a generous soft threshold (KOINE_WASM_BENCH_MAX_MS overrides). `--bench` adds the best/median
// breakdown + published _framework/ bundle size — the repeatable harness for the interpreter-vs-AOT
// trade-off measurement (issue #327): run it against an interpreter publish and again against a
// `-p:KoineWasmAot=true` publish to compare.
import { dotnet } from './bin/Release/net10.0/browser-wasm/AppBundle/_framework/dotnet.js';
import { performance } from 'node:perf_hooks';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BENCH = process.argv.includes('--bench') || process.env.KOINE_WASM_BENCH === '1';

// A simple single-file source for the `source`-only exports (parse/compile/format/outline).
const BILLING = `context Billing {
  enum Currency { EUR, USD, GBP }
  value Money {
    amount: Decimal
    currency: Currency
    invariant amount >= 0 "a monetary amount cannot be negative"
  }
}`;

// A rich workspace source for the LSP / model / scenario / hierarchy exports: a top-level value, an
// enum, and an aggregate whose entity carries a command, an emitted event, a state machine and an
// invariant — so the reflection-heavy paths (scenario runner, model round-trip, call/type hierarchy)
// run real, populated work, not just their empty-model fallback. Verbatim from the wire-parity
// fixtures (proven to compile + run) plus a top-level `value Money` for the model-edit target.
const ORDERING = `context Ordering {
  value Money { amount: Decimal }
  enum OrderStatus { Draft, Placed, Shipped }
  aggregate Sales root Order {
    event OrderPlaced { orderId: OrderId  lineCount: Int }
    value OrderLine { product: ProductId  quantity: Int }
    entity Order identified by OrderId {
      lines:  List<OrderLine>
      status: OrderStatus = Draft
      invariant status == Draft when lines.isEmpty
      states status { Draft -> Placed  Placed -> Shipped }
      command place {
        requires status == Draft   "only a draft order can be placed"
        requires !lines.isEmpty    "cannot place an empty order"
        status -> Placed
        emit OrderPlaced(orderId: id, lineCount: lines.count)
      }
    }
  }
}`;

const ORDERING_URI = 'file:///ordering.koi';
const ORDERING_FILES = JSON.stringify([{ uri: ORDERING_URI, text: ORDERING }]);

const runtime = await dotnet.create();
const config = runtime.getConfig();
const exports = await runtime.getAssemblyExports(config.mainAssemblyName);
const api = exports.Koine.Wasm.CompilerInterop;

// ---------------------------------------------------------------------------------------------
// shape-assertion helpers — "plausible shape", tolerant of additive DTO fields (the W* DTOs grow)

const kindOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// A string IN, parsed as JSON. A non-string return (or non-JSON text) is itself a failure.
function parse(raw) {
  if (typeof raw !== 'string') {
    throw new Error(`expected a JSON string return, got ${kindOf(raw)}`);
  }
  return JSON.parse(raw);
}

function expectObject(v, ...keys) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`expected an object, got ${kindOf(v)}`);
  }
  for (const k of keys) {
    if (!(k in v)) {
      throw new Error(`object is missing key '${k}'`);
    }
  }
  return v;
}

// LSP nullables (Hover, Definition, SignatureHelp, PrepareRename, Rename) return the JSON literal null.
function expectObjectOrNull(v, ...keys) {
  return v === null ? v : expectObject(v, ...keys);
}

function expectArray(v) {
  if (!Array.isArray(v)) {
    throw new Error(`expected an array, got ${kindOf(v)}`);
  }
  return v;
}

function expectTrue(cond, message) {
  if (!cond) {
    throw new Error(message);
  }
}

// 0-based (line, character) one column into `needle` found at/after `after` — a cursor INSIDE the
// identifier (TokenLocator selects on a strictly-interior hit), mirroring the wire-parity tests.
function posOf(text, needle, after) {
  const anchor = text.indexOf(after);
  const index = text.indexOf(needle, anchor < 0 ? 0 : anchor) + 1;
  const before = text.slice(0, index);
  const line = (before.match(/\n/g) ?? []).length;
  const lineStart = before.lastIndexOf('\n') + 1;
  return { line, character: index - lineStart };
}

const pOrder = posOf(ORDERING, 'Order', 'entity Order'); // the entity name
const pPlace = posOf(ORDERING, 'place', 'command place'); // the command name

// ---------------------------------------------------------------------------------------------
// the per-family check runner: one throw never aborts the rest, and every touched export name is
// recorded so the Capabilities() coverage guard can flag an export the smoke test forgot to exercise.

const results = [];
const covered = new Set();

function check(exportNames, fn) {
  const names = Array.isArray(exportNames) ? exportNames : [exportNames];
  const label = names.join('+');
  try {
    fn();
    results.push({ label, ok: true, note: '' });
  } catch (e) {
    results.push({ label, ok: false, note: String(e?.message ?? e) });
  }
  for (const n of names) {
    covered.add(n);
  }
}

// ---- core compile/diagnose surface (CompilerInterop.cs) --------------------------------------

check('Diagnose', () => {
  const clean = expectArray(parse(api.Diagnose(BILLING)));
  expectTrue(clean.length === 0, `clean source should have 0 diagnostics, got ${clean.length}`);
  const broken = expectArray(parse(api.Diagnose('context X { value M { amount: Nope } }')));
  expectTrue(broken.length > 0, 'broken source (unknown type) should report at least one diagnostic');
  expectObject(broken[0], 'severity', 'code', 'message', 'line', 'col');
});

check('Compile', () => {
  for (const target of ['csharp', 'typescript', 'glossary']) {
    const r = expectObject(parse(api.Compile(BILLING, target)), 'ok', 'target', 'diagnostics', 'files');
    expectTrue(r.ok === true, `Compile(${target}) should succeed`);
    expectTrue(Array.isArray(r.files) && r.files.length > 0, `Compile(${target}) should emit at least one file`);
    expectObject(r.files[0], 'path', 'contents');
  }
});

check('Capabilities', () => {
  const c = expectObject(parse(api.Capabilities()), 'version', 'exports', 'targets');
  expectTrue(typeof c.version === 'string' && c.version.length > 0, 'version should be a non-empty string');
  expectArray(c.exports);
  expectTrue(c.exports.includes('Capabilities') && c.exports.includes('Compile'), 'exports should list itself and Compile');
  expectArray(c.targets);
  expectTrue(c.targets.length > 0 && c.targets.every((t) => t.id && t.displayName && t.fileExtension), 'every target needs id/displayName/fileExtension');
});

check('SemanticTokens', () => {
  const t = expectObject(parse(api.SemanticTokens(BILLING)), 'data');
  expectArray(t.data);
  expectTrue(t.data.length > 0 && t.data.length % 5 === 0, `semantic-token stream should be a non-empty multiple of 5, got ${t.data.length}`);
});

check('GbnfGrammar', () => {
  // The ONE export that returns plain text, not JSON — the llama.cpp GBNF grammar string verbatim.
  const g = api.GbnfGrammar();
  expectTrue(typeof g === 'string' && g.length > 0, 'GbnfGrammar should return a non-empty grammar string');
  expectTrue(g.includes('::='), 'GBNF grammar should contain at least one `::=` rule');
});

// ---- workspace + projection surface (CompilerInterop.LanguageService.cs) ---------------------

check('DiagnoseWorkspace', () => {
  const r = expectArray(parse(api.DiagnoseWorkspace(ORDERING_FILES)));
  expectTrue(r.length > 0, 'a one-file workspace should produce one per-file bucket');
  expectObject(r[0], 'uri', 'diagnostics');
  expectArray(r[0].diagnostics);
});

check('EmitPreview', () => {
  const r = expectObject(parse(api.EmitPreview(ORDERING_FILES, 'csharp')), 'target', 'files', 'diagnostics', 'error');
  expectTrue(r.error === null, `EmitPreview should not error: ${r.error}`);
  expectTrue(Array.isArray(r.files) && r.files.length > 0, 'EmitPreview should emit files for a clean model');
});

check('ListEmitTargets', () => {
  const r = expectObject(parse(api.ListEmitTargets()), 'targets');
  expectArray(r.targets);
  expectTrue(r.targets.length > 0 && r.targets.every((t) => t.id && t.displayName && t.fileExtension), 'every target needs id/displayName/fileExtension');
});

check('Glossary', () => {
  const r = expectObject(parse(api.Glossary(ORDERING_FILES)), 'markdown');
  expectTrue(typeof r.markdown === 'string', 'glossary markdown should be a string');
});

check('ContextMap', () => {
  const r = expectObject(parse(api.ContextMap(ORDERING_FILES)), 'contexts', 'relations', 'contextSpans');
  expectArray(r.contexts);
  expectArray(r.relations);
});

check('GlossaryModel', () => {
  const r = expectObject(parse(api.GlossaryModel(ORDERING_FILES)), 'entries');
  expectArray(r.entries);
});

check('SetDoc', () => {
  // Address a real declaration: take an id from the structured glossary, then set its doc comment.
  const gm = parse(api.GlossaryModel(ORDERING_FILES));
  const id = gm.entries?.[0]?.id ?? 'Ordering';
  const r = expectObject(parse(api.SetDoc(ORDERING_FILES, id, 'a documented declaration')), 'uri', 'edits');
  expectArray(r.edits);
});

// ---- structured model round-trip (#91) -------------------------------------------------------

const ADD_FIELD_EDIT = JSON.stringify({ kind: 'addField', target: 'Ordering.Money', name: 'tax', type: 'Decimal' });

check('Model', () => {
  const r = expectObject(parse(api.Model(ORDERING_FILES, null)), 'kind', 'qualifiedName', 'title', 'members', 'children');
  expectTrue(r.kind === 'model', `root node kind should be 'model', got '${r.kind}'`);
  expectArray(r.children);
});

check('ModelMembers', () => {
  const r = expectObject(parse(api.ModelMembers(ORDERING_FILES, 'Ordering.OrderStatus')), 'members');
  expectArray(r.members);
  expectTrue(r.members.length > 0, 'the enum OrderStatus should expose its members');
});

check('EmitKoine', () => {
  const r = expectObject(parse(api.EmitKoine(ORDERING_FILES, ADD_FIELD_EDIT)), 'koine', 'diagnostics');
  expectArray(r.diagnostics);
  expectTrue(typeof r.koine === 'string' && r.koine.length > 0, 'a legal edit should yield canonical .koi');
});

check('ApplyModelEdit', () => {
  const r = expectObject(parse(api.ApplyModelEdit(ORDERING_FILES, ADD_FIELD_EDIT)), 'uri', 'edits', 'diagnostics');
  expectArray(r.edits);
  expectArray(r.diagnostics);
});

// ---- positional LSP surface (0-based cursor in the active document) --------------------------

check('Hover', () => {
  const r = expectObjectOrNull(parse(api.Hover(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character)), 'contents');
  if (r) {
    expectObject(r.contents, 'kind', 'value');
  }
});

check('Completions', () => {
  const r = expectObject(parse(api.Completions(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character)), 'isIncomplete', 'items');
  expectArray(r.items);
});

check('SignatureHelp', () => {
  const r = expectObjectOrNull(parse(api.SignatureHelp(ORDERING_FILES, ORDERING_URI, pPlace.line, pPlace.character)), 'signatures');
  if (r) {
    expectArray(r.signatures);
  }
});

check('Definition', () => {
  expectObjectOrNull(parse(api.Definition(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character)), 'uri', 'range');
});

check('References', () => {
  expectArray(parse(api.References(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character)));
});

check('DocumentHighlightsAt', () => {
  const r = expectArray(parse(api.DocumentHighlightsAt(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character)));
  if (r.length) {
    expectObject(r[0], 'range', 'kind');
  }
});

check('PrepareRename', () => {
  expectObjectOrNull(parse(api.PrepareRename(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character)), 'range');
});

check('Rename', () => {
  const r = expectObjectOrNull(parse(api.Rename(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character, 'PurchaseOrder')), 'changes');
  if (r) {
    expectObject(r.changes);
  }
});

check('InlayHints', () => {
  expectArray(parse(api.InlayHints(ORDERING_FILES, ORDERING_URI, 0, 0, 100, 0)));
});

check('CodeActions', () => {
  expectArray(parse(api.CodeActions(ORDERING_FILES, ORDERING_URI, pOrder.line, 0, pOrder.line, 80, '[]')));
});

// ---- document-scoped LSP surface (single `source`) -------------------------------------------

check('DocumentSymbols', () => {
  const r = expectArray(parse(api.DocumentSymbols(ORDERING)));
  expectTrue(r.length > 0, 'a non-trivial document should expose an outline');
  expectObject(r[0], 'name', 'kind', 'range');
});

check('WorkspaceSymbols', () => {
  expectArray(parse(api.WorkspaceSymbols(ORDERING_FILES, 'Order')));
});

check('FoldingRanges', () => {
  const r = expectArray(parse(api.FoldingRanges(ORDERING)));
  if (r.length) {
    expectObject(r[0], 'startLine', 'endLine');
  }
});

check('SelectionRanges', () => {
  const positions = JSON.stringify([{ line: pOrder.line, character: pOrder.character }]);
  const r = expectArray(parse(api.SelectionRanges(ORDERING, positions)));
  expectTrue(r.length === 1, 'the result array stays parallel to the requested positions');
  expectObject(r[0], 'range');
});

check('CodeLenses', () => {
  expectArray(parse(api.CodeLenses(ORDERING_FILES, ORDERING_URI)));
});

check('Format', () => {
  // Formatting a deliberately un-canonical source yields a single full-document edit.
  const r = expectArray(parse(api.Format('context  X{value M{amount:Decimal}}')));
  if (r.length) {
    expectObject(r[0], 'range', 'newText');
  }
});

check('FormatRange', () => {
  expectArray(parse(api.FormatRange('context  X{value M{amount:Decimal}}', 0, 0, 0, 40)));
});

// ---- compatibility check ---------------------------------------------------------------------

check('Check', () => {
  // Compare the model against itself: no breaking changes, no error.
  const r = expectObject(parse(api.Check(ORDERING_FILES, ORDERING_FILES)), 'error', 'hasBreakingChanges', 'changes');
  expectArray(r.changes);
  expectTrue(r.error === null, `an identical baseline should not error: ${r.error}`);
});

// ---- call hierarchy (prepare → incoming/outgoing) --------------------------------------------

check(['PrepareCallHierarchy', 'IncomingCalls', 'OutgoingCalls'], () => {
  const prepared = expectArray(parse(api.PrepareCallHierarchy(ORDERING_FILES, ORDERING_URI, pPlace.line, pPlace.character)));
  expectTrue(prepared.length > 0, 'the cursor on `command place` should prepare a call-hierarchy item');
  expectObject(prepared[0], 'name', 'kind', 'data');
  // Echo the prepared item back through the incoming/outgoing walks (the path that reflects over nodes).
  const item = JSON.stringify(prepared[0]);
  expectArray(parse(api.IncomingCalls(ORDERING_FILES, item)));
  expectArray(parse(api.OutgoingCalls(ORDERING_FILES, item)));
});

// ---- type hierarchy (prepare → supertypes/subtypes) ------------------------------------------

check(['PrepareTypeHierarchy', 'Supertypes', 'Subtypes'], () => {
  const prepared = expectArray(parse(api.PrepareTypeHierarchy(ORDERING_FILES, ORDERING_URI, pOrder.line, pOrder.character)));
  expectTrue(prepared.length > 0, 'the cursor on `entity Order` should prepare a type-hierarchy item');
  expectObject(prepared[0], 'name', 'kind', 'data');
  const item = JSON.stringify(prepared[0]);
  expectArray(parse(api.Supertypes(ORDERING_FILES, item)));
  expectArray(parse(api.Subtypes(ORDERING_FILES, item)));
});

// ---- living docs + scenario runner (#93, #149) -----------------------------------------------

check('Docs', () => {
  const r = expectObject(parse(api.Docs(ORDERING_FILES)), 'files');
  expectArray(r.files);
  if (r.files.length) {
    expectObject(r.files[0], 'path', 'contents', 'diagrams');
  }
});

check('ScenarioCatalog', () => {
  const r = expectObject(parse(api.ScenarioCatalog(ORDERING_FILES)), 'targets');
  expectArray(r.targets);
  expectTrue(r.targets.length > 0, 'the aggregate should surface a runnable target');
});

check('RunScenario', () => {
  const given = JSON.stringify({ status: 'Draft', lines: [{ product: 'P1', quantity: 2 }] });
  const r = expectObject(parse(api.RunScenario(ORDERING_FILES, 'Order', 'place', given, '{}')), 'ok', 'steps');
  expectTrue(r.ok === true, 'placing a draft order should succeed');
  expectArray(r.steps);
});

// ---- coverage guard: every shipped [JSExport] must be exercised -------------------------------

check('coverage', () => {
  const shipped = parse(api.Capabilities()).exports;
  const missing = shipped.filter((name) => !covered.has(name));
  expectTrue(
    missing.length === 0,
    `the bundle ships ${missing.length} [JSExport](s) no smoke check exercises: ${missing.join(', ')} — add a check`,
  );
});

// ---------------------------------------------------------------------------------------------
// report

const passed = results.filter((r) => r.ok).length;
console.log(`\n[JSExport] surface smoke test — ${passed}/${results.length} families passed\n`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.note ? `  — ${r.note}` : ''}`);
}

const checksOk = passed === results.length;
console.log(checksOk ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');

// Benchmark: time the pizzeria compile and guard a soft regression threshold (issues #327, #333).
// Runs on every invocation so CI gets a perf number + regression gate on every push; `--bench` adds
// the best/median + bundle-size breakdown (the interpreter-vs-AOT comparison harness, #327).
const benchOk = runBenchmark();

process.exit(checksOk && benchOk ? 0 : 1);

// ---------------------------------------------------------------------------------------------

function runBenchmark() {
  console.log('\n--- pizzeria compile benchmark (issues #327, #333) ---');

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

  // The headline number CI logs on every push (grep-friendly `elapsed=`), guarded by a generous soft
  // threshold so a gross regression — e.g. a trim change forcing an interpreter fallback — reddens the
  // build while normal slow-runner jitter does not. Tunable via KOINE_WASM_BENCH_MAX_MS; the precise
  // per-device budget is #219's job.
  const DEFAULT_MAX_MS = 10000;
  const rawMax = Number(process.env.KOINE_WASM_BENCH_MAX_MS);
  const maxMs = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_MS;
  console.log(
    `pizzeria compile: elapsed=${ms(median)}ms (best ${ms(best)} ms, over ${RUNS} runs, ${WARMUP} warmup; threshold ${maxMs} ms)`,
  );

  // `--bench` adds the published _framework/ bundle size + the AOT-comparison BENCH RESULT line (#327).
  if (BENCH) {
    const framework = join(here, 'bin', 'Release', 'net10.0', 'browser-wasm', 'AppBundle', '_framework');
    const frameworkBytes = dirBytes(framework);
    const frameworkMB = (frameworkBytes / (1024 * 1024)).toFixed(2);
    console.log(`bundle (_framework total): ${frameworkBytes} bytes (${frameworkMB} MB)`);
    console.log(`BENCH RESULT  pizzeria_ms_best=${ms(best)}  pizzeria_ms_median=${ms(median)}  framework_mb=${frameworkMB}`);
  }

  if (median > maxMs) {
    console.log(
      `BENCHMARK FAILED — pizzeria compile median ${ms(median)}ms exceeded the ${maxMs}ms soft threshold (set KOINE_WASM_BENCH_MAX_MS to retune).`,
    );
    return false;
  }
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
