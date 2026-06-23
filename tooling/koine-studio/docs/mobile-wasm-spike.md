# Mobile WASM compiler spike (#219)

> **Status: IN PROGRESS — verdict PENDING real-device data.**
> This is a measurement spike, not a shipped feature. The decisive question — does iOS WebKit's
> per-tab memory ceiling terminate the page during a compile? — can only be answered on physical
> devices (rows **D1**/**D2** below). Those rows are a **runbook** for a maintainer with the
> hardware; an automated environment cannot fill them. The final **(a)/(b)/(c)** recommendation is
> deliberately left open until they are filled in — no fabricated verdict.

**Issue:** [#219](https://github.com/Atypical-Consulting/Koine/issues/219) ·
**Siblings gated by this:** [#220](https://github.com/Atypical-Consulting/Koine/issues/220) (responsive shell),
[#221](https://github.com/Atypical-Consulting/Koine/issues/221) (touch editing).

## Goal

Decide whether Koine Studio's in-browser Blazor/.NET WASM compiler can run on a phone, choosing one of:

- **(a)** client-side WASM viable as-is on mobile,
- **(b)** viable only if lazy-loaded / gated behind an explicit "compile" action,
- **(c)** mobile needs a server-side compile endpoint.

## Reproducing the build under test

The bundle measured below is the **existing** `build:web` output — no source changes. From
`tooling/koine-studio/`:

```bash
dotnet workload install wasm-tools wasm-experimental   # one-time
npm ci
npm run build:web        # prebuild:web → generate-templates + build-wasm.mjs
                         #   (dotnet publish src/Koine.Wasm -c Release) → tsc && vite build --mode web
```

- `build-wasm.mjs` publishes `src/Koine.Wasm` (browser-wasm) and copies its AppBundle into
  `public/koine-wasm/_framework/`; Vite then serves it as a static asset. The browser host loads
  `${BASE_URL}koine-wasm/_framework/dotnet.js`.
- Built here with **base = `/`** (no `KOINE_STUDIO_BASE`), so the output serves at the host root —
  the simplest target for local emulated measurement. A real deploy under a sub-path sets
  `KOINE_STUDIO_BASE=/your/subpath/`.
- Output: `tooling/koine-studio/dist/` (the static site, including `dist/koine-wasm/_framework/`).

## Payload measurement (real — captured on this build)

Byte-accurate sums over `dist/koine-wasm/_framework` (27 files: 20 `.wasm`, 4 `.js`, 2 `.map`,
1 `.symbols`). `gzip` = `gzip -9`; `brotli` = `brotli -q 11` (approximates a CDN/host serving
compressed assets).

| Slice | Files | Raw | gzip | brotli |
|---|---:|---:|---:|---:|
| **Cold-load runtime transfer** (excludes `.map` + `.symbols` — not fetched by normal users) | 24 | **5.81 MB** | **2.10 MB** | **1.70 MB** |
| `.wasm` assemblies + runtime only | 20 | 5.38 MB | 1.98 MB | 1.61 MB |
| Everything in `_framework` (incl. maps/symbols) | 27 | 6.30 MB | 2.25 MB | 1.83 MB |

**Largest `_framework` files (raw):**

| File | Raw |
|---|---:|
| `dotnet.native.wasm` | 1456 KB |
| `Koine.Compiler.wasm` | 1391 KB |
| `System.Private.CoreLib.wasm` | 1358 KB |
| `Koine.Wasm.wasm` | 311 KB |
| `System.Text.RegularExpressions.wasm` | 252 KB |
| `System.Text.Json.wasm` | 220 KB |
| `Antlr4.Runtime.Standard.wasm` | 186 KB |

**Vite JS app shell** (separate from `_framework`, gzip as reported by the build): `index` 387 KB +
`esm` 171 KB + `sdk` 39 KB + `openai` 31 KB + `index.css` 23 KB ≈ **~0.65 MB gzip** for the main
chunks.

### What the payload alone already tells us

- A first-time mobile **cold-load** is roughly **~2.4 MB compressed** (WASM brotli ~1.7 MB + JS app
  shell gzip ~0.65 MB) — meaningful on a cellular connection but not, by itself, disqualifying.
- ⚠️ **No precompressed `.br`/`.gz` variants ship in the AppBundle.** If the static host does **not**
  compress on the fly, a phone downloads the full **~5.8 MB raw** `_framework` (plus ~2.9 MB raw JS).
  **Any mobile deploy MUST enable gzip/brotli** — this is the single cheapest win and belongs in the
  deploy checklist regardless of the (a)/(b)/(c) verdict.
- The `dotnet.native.wasm` + CoreLib + `Koine.Compiler.wasm` trio (~4.2 MB raw / ~1.4 MB brotli) is
  irreducible without trimming/relinking work — a lever the verdict may recommend, not assume.

> Transfer size is necessary but **not sufficient**: the open risk is **peak memory during a compile**
> on iOS, which the size says nothing about. That is what D1/D2 measure.

## Device matrix

| ID | Device / browser | Role | Why |
|----|------------------|------|-----|
| **D1** | iPhone, Safari (recent iOS) | **Primary** | The decisive case — iOS WebKit enforces a per-tab memory ceiling that can terminate the page. |
| **D2** | Mid-range Android, Chrome | **Primary** | More headroom than iOS but representative of real low/mid devices; remote-debuggable. |
| **D3** | Desktop Chrome, **Slow 4G + 4× CPU** throttling | Reproducible baseline | Repeatable, environment-independent proxy for a constrained device. **Captured here.** |
| **D4** | Desktop Chrome, no throttling | Reference baseline | Upper bound; isolates pure compute/transfer from device constraints. **Captured here.** |

> D3/D4 emulation does **not** reproduce iOS's memory-kill behaviour — DevTools CPU/network throttling
> does not cap heap the way WebKit does. D3/D4 bound latency and transfer; only **D1/D2 settle the
> memory question**, and hence the verdict.

## Metrics

Workloads: **small = `billing` starter**, **medium = `pizzeria` template** (both already green in the
test suite). Latency is **N=5** runs, reported as **median / max** (ms). Cold-load = navigation start →
editor interactive (first `loadWasmApi()` resolved). Survival ∈ {survived | reloaded | crashed}.

Peak memory is reported as **WASM linear memory** (the .NET runtime heap, read via
`getDotnetRuntime(0).Module.HEAPU8.length`), **not** `performance.memory.usedJSHeapSize` — the latter
reported only ~11 MB and **excludes** the WASM heap, which is the dominant footprint and the actual
iOS-ceiling risk.

| ID | Transfer (raw / brotli) | Cold-load | Peak WASM heap (MB) | Small compile (med/max ms) | Medium compile (med/max ms) | Survival |
|----|------------------------|-----------|---------------------|----------------------------|-----------------------------|----------|
| **D1 (iPhone/Safari)**  | 5.81 / 1.70 MB · _host-dep._ | **— runbook** | **— runbook** | **— runbook** | **— runbook** | **— runbook** |
| **D2 (Android/Chrome)** | 5.81 / 1.70 MB · _host-dep._ | **— runbook** | **— runbook** | **— runbook** | **— runbook** | **— runbook** |
| D3 (Chrome 4×CPU / 4G)  | 5.68 MB transferred (server **uncompressed**) | 7.3 s¹ (Fast 4G) | **66.5** | 17.1 / 17.8 | 229.8 / 284.9 | survived² |
| D4 (Chrome no-throttle) | 5.68 MB transferred (localhost) | ~0.2 s (localhost)³ | **55.4** | 3.9 / 7.1 | 58.6 / 63.5 | survived² |

¹ Fresh isolated context (empty cache), Fast 4G + 4× CPU, **uncompressed** preview server: all 25
`_framework` files (5.68 MB) arrive by **7.3 s**, all resources by 9.2 s, then WASM boots + first
compile. On **Slow 4G** (measured ~300 Kbps effective) the same uncompressed payload is **~150 s** —
impractical; this is the cost of shipping uncompressed (see below).
² Desktop has no memory pressure, so "survived" here is **not diagnostic** — only D1/D2 exercise the
memory-kill path.
³ Localhost transfer time is not representative of a network; the D4 cold-load figure isolates
parse/boot/compute, not download.

### Emulated baseline results (D3/D4 — captured here)

- **Compile latency is a non-issue.** Even at 4× CPU slowdown, the 6-context **pizzeria** (7 files,
  → 91 emitted C# files) compiles in **~230 ms median**; the **billing** starter (→ 15 files) in
  **~17 ms**. Unthrottled: 59 ms / 4 ms. Repeat compiles (N=5) were stable.
- **Peak WASM heap is modest: ~55–67 MB** after warm-up and five compiles of each workload (idle after
  cold boot is **38.4 MB**). Whether that survives **iOS**'s per-tab ceiling on a real/older device is
  exactly what D1 must confirm — but ~67 MB is well within what modern iPhones allow, so the signal is
  cautiously favourable (not a verdict).
- **The cold-load problem is compression, not the app.** The bundle is **uncompressed** as served here
  (no `.br`/`.gz`; `content-encoding` absent), so a phone downloads the full **5.68 MB**. Brotli
  (1.70 MB, 3.4×) would cut Fast-4G cold-load from ~9 s toward ~3 s and make Slow-4G go from ~150 s to
  ~45 s. **Enabling brotli/gzip on the deploy host is mandatory** and independent of the (a)/(b)/(c)
  call.

> Measured via the Chrome DevTools MCP against `vite preview --mode web` on localhost. Compiles called
> the real `exports.Koine.Wasm.CompilerInterop.EmitPreview(filesJson, 'csharp')` export (the same entry
> the app uses), and each result was validated to contain emitted files (15 / 91) — not an error
> envelope. Fixtures: `billing.koi`; the seven `pizzeria/*.koi`.

### D1 / D2 runbook (real devices — to be filled by a maintainer)

These rows decide the verdict and require physical hardware; an automated environment cannot produce
them. To fill them:

1. **Deploy** `dist/` to a phone-reachable host (`KOINE_STUDIO_BASE=/subpath/ npm run build:web`, then
   push `dist/` to GitHub Pages / Netlify / a static bucket). **Enable brotli/gzip** on the host, and
   verify `content-encoding: br|gzip` on `_framework/*` in the Network tab — otherwise you are timing
   the 5.8 MB raw path.
2. **D1 — iPhone/Safari:** cable the iPhone to a Mac, Safari → Develop → _device_ → Web Inspector.
   - *Cold-load:* Network/Timelines from navigation to editor-interactive.
   - *Peak heap:* Timelines → Allocations during a `pizzeria` compile. (No `getDotnetRuntime` console
     access needed; or paste `getDotnetRuntime(0).Module.HEAPU8.length/1048576` to read WASM heap MB.)
   - *Latency:* the same `EmitPreview` call, or just time the **Code** tab switch.
   - *Survival:* load → compile → background the tab ~60 s → foreground → compile again. **Blank tab or
     forced reload = a WebKit memory kill** (the (c)-triggering signal).
3. **D2 — Android/Chrome:** `chrome://inspect` remote debug; repeat cold-load + compile + peak heap +
   the same background/foreground survival test.
4. Drop the numbers into the matrix above; the decision criteria below then resolve the verdict.

## Capture procedure

**Instrumentation (both wrap points are in the browser host, `src/host/browser/wasm.ts`):**

- Cold-load / runtime boot: wrap `loadWasmApi()` (wasm.ts:186) — `const t0 = performance.now()` before
  the call, log `performance.now() - t0` when its promise resolves.
- Compile latency: wrap the `EmitPreview(filesJson, 'csharp')` call (the guarded API surface,
  wasm.ts:12) — time each of N=5 invocations on the same workspace; report median + max.
- A throwaway way to inject both without shipping code: paste a timing snippet into the DevTools
  console via `performance.mark`/`measure`, or temporarily wrap the two calls locally (do **not** commit
  the instrumentation — it's a spike, not a feature).

**Per metric:**

- **Transfer size** — Chrome DevTools **Network** tab (disable cache, reload): read "transferred" vs
  "size" for `_framework/*`. Confirm the host is serving compressed (`content-encoding: br|gzip`); if
  not, you're measuring the 5.8 MB raw path.
- **Cold-load** — Network/Performance trace from navigation start to editor interactive.
- **Peak JS heap** — Chrome **Memory**/Performance heap timeline (Android via `chrome://inspect`);
  Safari **Web Inspector → Timelines → Allocations** (iPhone cabled to a Mac, Develop → _device_).
- **Compile latency** — the `EmitPreview` wrap above, N=5.
- **Survival** — load → compile → background the tab ~60 s → foreground → compile again. A blank tab or
  forced reload on return = a WebKit memory kill.

**Throttling profiles (D3 primary):** Network **Slow 4G**, CPU **4× slowdown**. Secondary sensitivity
run: **Fast 4G**.

## Decision criteria (pre-committed — evaluate first-match-wins, *before* looking at the numbers)

Locked in now so the analysis can't rationalise after the fact. Evaluated top-to-bottom; the first rule
that matches on a **primary** device (D1 or D2) wins.

1. **→ (c) server-side compile endpoint** if **any** of: the tab is **terminated/reloaded** during or
   after a compile (the survival test fails on iOS); **or** a 2nd consecutive compile reliably crashes;
   **or** medium-model (`pizzeria`) compile latency is **unusable** (median ≳ 10 s) on a primary device.
2. **→ (b) lazy / explicit-opt-in compile** if it loads and compiles **but**: cold-load is heavy
   (served transfer ≳ 3 MB or cold-load ≳ 10 s on Slow-4G-class), **or** peak heap is **high but
   survivable** (no crash, yet close enough to limits that eager compile is risky).
3. **→ (a) client-side viable as-is** if, on **both** primary devices: the survival test passes, peak
   heap sits comfortably below the device ceiling, and small/medium compile latency is interactive
   (≲ ~2 s / ≲ ~5 s) with acceptable cold-load.

> These thresholds are deliberately conservative defaults; if a real measurement sits on a boundary,
> record the number and the call made, don't silently round toward a nicer verdict.
