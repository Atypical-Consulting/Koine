# Koine.Wasm

The browser-wasm build of the Koine compiler. It exposes the compiler + language service to JavaScript
through the `[JSExport]` surface in [`CompilerInterop.cs`](CompilerInterop.cs) and
[`CompilerInterop.LanguageService.cs`](CompilerInterop.LanguageService.cs) — the module Koine Studio's
browser backend and the docs-site Playground load (`getAssemblyExports(...).Koine.Wasm.CompilerInterop.*`).

It publishes with `PublishTrimmed=true` / `TrimMode=full` and **roots `Koine.Compiler` and
`Antlr4.Runtime.Standard` whole** (see the `TrimmerRootAssembly` block in
[`Koine.Wasm.csproj`](Koine.Wasm.csproj)) because `Ast/NodeWalker` reflects over the compiler's own
nodes and ANTLR deserializes its ATN — reflection paths a trim change can silently break.

## Real-wasm smoke test (`smoke-test.mjs`)

[`smoke-test.mjs`](smoke-test.mjs) boots the **published** AppBundle under Node and drives the whole
`[JSExport]` surface against the real wasm runtime, asserting each export doesn't crash and returns
JSON of a plausible shape. A `Capabilities()`-driven coverage guard fails the run if the bundle ships
an export no check exercises, so the surface can't silently drift out of coverage.

This is the gate the desktop **wire-parity** suite (`tests/Koine.Wasm.Tests/*WireParityTests.cs`)
cannot be: those tests pin the JSON *shape* against the stdio LSP, but they run on **desktop .NET**, so
by construction they can't catch a **trim/runtime** failure in the published wasm module — exactly the
fragile, reflection-rooted paths above. The smoke test is the only thing in CI that exercises the
published bundle past `Compile`/`Diagnose`.

Run it locally (needs the `wasm-tools wasm-experimental` workloads):

```bash
dotnet publish src/Koine.Wasm -c Release      # produce bin/Release/net10.0/browser-wasm/AppBundle
node src/Koine.Wasm/smoke-test.mjs            # full-surface checks + pizzeria compile benchmark
```

A non-zero exit means a check (or the benchmark threshold) failed. CI runs exactly this on every push
(`.github/workflows/ci.yml`, the "Smoke-test the published wasm bundle" step).

### Scheduled AOT-bundle smoke run

The per-push CI gate publishes the **default (interpreter)** bundle, but the deployed Playground/Studio
ships the **AOT** bundle (`-p:KoineWasmAot=true`, set by `deploy-docs.yml`). `PublishTrimmed`/
`TrimMode=full` are identical in both modes, so the trim/reflection breakage the smoke test guards is
mode-independent and already caught by the per-push gate; the AOT bundle's *boot* is covered by the
Studio browser smoke. The one residual gap is an **AOT-codegen-only regression on a non-boot path** — a
method the AOT compiler drops or mis-compiles but the interpreter keeps.
[`.github/workflows/wasm-aot-smoke.yml`](../../.github/workflows/wasm-aot-smoke.yml) closes it: a
**scheduled** (nightly `cron` + `workflow_dispatch`) job that runs the *same, unchanged* smoke test
against an AOT publish. It lives off the PR path so the ~24–32 s AOT publish cost never taxes the
per-push loop, and a red run signals an AOT-specific regression the interpreter gate can't see.

Run it on demand — from the Actions UI, or:

```bash
gh workflow run wasm-aot-smoke.yml            # trigger the scheduled job manually

# …or reproduce it locally (needs the wasm workloads):
dotnet publish src/Koine.Wasm -c Release -p:KoineWasmAot=true   # AOT publish
node src/Koine.Wasm/smoke-test.mjs                              # same full-surface checks + benchmark
```

## Pizzeria compile benchmark

The same run compiles the 6-context [`templates/pizzeria`](../../templates/pizzeria) model in wasm — the
workspace `EmitPreview` path Koine Studio runs on every keystroke — and prints a grep-friendly
`pizzeria compile: elapsed=NNNms` perf number (the in-browser measurement issue #219 wants), failing
on a **generous soft threshold** so a gross regression reddens the build while normal slow-runner jitter
does not.

- **`KOINE_WASM_BENCH_MAX_MS`** overrides the soft threshold (default `10000` ms); the precise
  per-device budget is deferred to #219.
- **`--bench`** (or `KOINE_WASM_BENCH=1`) adds the best/median breakdown + the published `_framework/`
  bundle size — the repeatable harness for the interpreter-vs-AOT trade-off (issue #327): run it against
  an interpreter publish and again against a `-p:KoineWasmAot=true` publish to compare.

```bash
node src/Koine.Wasm/smoke-test.mjs --bench               # detailed timing + bundle size
KOINE_WASM_BENCH_MAX_MS=2000 node src/Koine.Wasm/smoke-test.mjs   # tighter regression gate
```
