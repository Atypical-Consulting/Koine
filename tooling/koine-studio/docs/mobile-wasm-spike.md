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
