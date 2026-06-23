# Koine Studio Web — Release-Readiness Review Kanban

> Goal: drive the web IDE through a browser, audit **every** feature (UX, behavior, design, MCP, AI, accessibility, per-view), report everything strange, finish what's unfinished, and get to a releasable v1.
>
> Driven by: `chrome-devtools` MCP against `http://localhost:1431/` (Vite `dev:web`), plus Lighthouse + performance traces + context7.
> Last updated: 2026-06-23 (in progress)

## Environment

- Studio web served at **http://localhost:1431/** (SPA — single URL; "pages" are internal views/tabs/dialogs).
- WASM language service: `public/koine-wasm/_framework/dotnet.js` (Blazor WASM, client-side compile).
- MCP panel is **degraded by design** in web mode (`mcpHostable: false`) — toggle/test disabled, recipes still render. Not a bug.

## Views / surfaces to audit (the "pages")

| # | Surface | URL/State | Status |
|---|---------|-----------|--------|
| 1 | Welcome screen (template gallery, recents) | `/` (no workspace) | ✅ |
| 2 | Main IDE shell (left rail, editor, right rail, status bar) | `/` (workspace open) | ✅ |
| 3 | CodeMirror `.koi` editor + actions | center | ✅ |
| 4 | Diagnostics strip / Problems badge | bottom | ✅ |
| 5 | Generated-code preview (C#/TS/Py/PHP) | center tab | ✅ |
| 6 | Domain diagram canvas (maxGraph) | center tab | ✅ |
| 7 | Documentation (Glossary / Decisions·ADR / Notes) | center tab | ✅ |
| 8 | Model panels: Outline, Properties, Relationships, Events | right rail | ✅ |
| 9 | Bottom tables (model index) | bottom | ✅ |
| 10 | Command palette | overlay | ✅ |
| 11 | Help overlay | overlay | ✅ |
| 12 | AI Assistant inspector tab | right rail | ✅ |
| 13 | Settings → Appearance | dialog | ✅ |
| 14 | Settings → Output (target language) | dialog | ✅ |
| 15 | Settings → MCP | dialog | ✅ |
| 16 | Settings → Assistant (provider/keys/tools) | dialog | ✅ |
| 17 | Settings → About | dialog | ✅ |
| 18 | Export / Generate project wizard | dialog | ✅ |
| 19 | Share (URL state) | action | ✅ |
| 20 | History (undo/redo) controls | toolbar | ✅ |
| 21 | Workspace open/save/persistence | action | ✅ |
| 22 | Accessibility (Lighthouse a11y per view) | audit | ✅ |
| 23 | Performance (Lighthouse perf + trace) | audit | ✅ |

## 🔍 In Review

| F19 | **medium (UX, first impression)** | Status bar connection indicator | `#sb-connection` showed **"Offline"** whenever the model had ANY diagnostic (even a warning) or any error-styled toast — because `setStatus` mirrored the transient pill `kind` into the connection label (`editorSession.tsx:184`, `updateStatus` passes `'error'` for any diagnostics). The **default model loads with a warning → first thing a new user sees is "Offline"**, implying the service is down when the in-WASM compiler is healthy. → **FIXED** (decoupled; connection now tracks the LSP lifecycle: Connecting…→Local on first push, Offline only on server exit). | ✅ fixed |

## 🐞 Findings (issues discovered)

| ID | Severity | Surface | Issue | Status |
|----|----------|---------|-------|--------|
| F1 | low (dev-only) | dev tooling | `scripts/generate-templates.mjs` rewrites `src/templates.generated.ts`, which Vite watches → spurious full page reload that wipes in-progress state during `dev:web`. Not a prod bug; consider writing only when content changed. | 🔍 open |
| F2 | medium | Welcome / workspace persistence | Opening a **template example** is ephemeral: it does not appear under RECENT, and a page reload reverts to Welcome + default Billing model, losing the opened example. (Matches known save/load gap.) | 🔍 open |
| F3 | low (a11y) | forms (likely Settings/AI inputs) | Console: "A form field element should have an id or name attribute (count: 14)". 14 inputs lack `id`/`name`. | 🔍 open |
| F4 | low (a11y/sec) | API-key input | Console: "Password field is not contained in a form" — password-type input outside a `<form>`. | 🔍 open |

| F5 | **HIGH** | Code → Compatibility tab | `view-check` panel renders **completely empty** (0 children, no text, no empty state). Tab is reachable but shows a black void. Must wire it up or show a meaningful empty/explanatory state. | 🔍 open |
| F6 | medium | Right rail → Rules tab | `rview-rules` shows literal **"Coming soon."** — unfinished feature exposed in UI. | 🔍 open |
| F7 | medium | Right rail → Notes tab | `rview-notes` shows literal **"Coming soon."** — unfinished feature exposed in UI. (Distinct from the center Documentation→Notes, which IS implemented.) Source: `index.html:229-230`, `inspectorController.tsx:1105`. | 🔍 open |
| F8 | **high** | Welcome + toolbar/palette → Open folder | On non-Chromium (Firefox/Safari) `canOpenFolders===false`, but the **"Open folder…"** button (welcome) and toolbar/palette/⌘⇧O open-folder stay enabled and look primary; clicking only sets an error status. Dead button. `welcome/welcome.ts:271-281`, `shell/ide.tsx:746-749`. | 🔍 open |
| F9 | **high** | Boot (no-OPFS browsers) | On Safari/Firefox Private (no OPFS) the IDE boots to a single caption ("needs OPFS…") and is then non-functional — no buffer, can't open/save. Needs a real fallback or an honest "unsupported browser" screen. `host/browser/fs.ts:300-303`, `shell/ide.tsx:864-869`. | 🔍 open |
| F10 | medium | Examples gallery / shared-link import (no-OPFS) | Depend on OPFS; on no-OPFS browsers they fail with a transient "could not open…" status — the marquee "Start from an example" is dead there. `shell/ide.tsx:986,1009`. | 🔍 open |
| F11 | low | Assistant settings vs README | README documents a "Settings → Assistant → *agentic tools*" toggle; the Settings→Assistant panel only has Provider/API key/Model (no tools toggle text anywhere in the dialog). Verify where tool-use is toggled / fix doc drift. | 🔍 open |
| F12 | low | Docs drift | README still mentions "scratch mode" (removed). `'scratch'` survives only as a storage-key fallback. `tooling/koine-studio/README.md:70-71`. | 🔍 open |
| F13 | low | Context picker | `inspectorController.tsx:427` `refreshContextList` swallows a glossary-model failure and silently sets context options to `[]` (empty picker, no signal). | 🔍 open |

| F11b | medium | Settings → Assistant (CONFIRMED bug, upgraded) | The **Compiler tools** opt-in row is hidden for the Anthropic provider (`prefs.ts:487` `agenticToolsRow.hidden = !isOpenai`, stale comment), yet `runAnthropic` (`ai.ts:191`) fully advertises the koine tools and the README says tool-use works on the default Anthropic path. Default `aiAgenticTools=false` + hidden toggle ⇒ Anthropic users can never enable it. Fix: show the toggle for all providers. | 🔧 fixing |
| F14 | medium (a11y) | CodeMirror editor | `aria-input-field-name`: the `.cm-content role=textbox` has no accessible name. Add `aria-label` via CodeMirror `contentAttributes`. | 🔧 fixing |
| F15 | medium (a11y) | Toolbar/Welcome buttons | `label-content-name-mismatch` on 5 buttons (`#btn-home` brand, `#palette-hint`, welcome New model / Start from an example / Open folder…): visible text not contained in the `aria-label` (WCAG 2.5.3). | 🔧 fixing |
| F16 | low (a11y) | Explorer construct rows | `target-size`: `.koi-model-leaf` rows are 230×23.5px (<24px min). Bump min-height ≥24px. | 🔧 fixing |
| F17 | low (SEO/meta) | index.html | No `<meta name="description">`; no valid `robots.txt`. Add both (robots.txt under `public/`). | 🔧 fixing |
| F18 | low (best practice) | Generate wizard | "Back" button is shown/enabled on step 1 (Language) with nowhere to go. Hide/disable on the first step. | 🔍 open |

### Lighthouse (desktop, navigation) — http://localhost:1431/
- **Accessibility: 94** · Best Practices: **100** · SEO: 82 · Agentic Browsing: 31
- A11y fails: `aria-input-field-name` (CM editor), `label-content-name-mismatch` (5 buttons), `target-size` (explorer rows). → F14/F15/F16
- SEO fails: `meta-description`, `robots-txt`. → F17
- Agentic fails: `agent-accessibility-tree` (downstream of aria fixes), `llms-txt` (docs-site nice-to-have), CLS 0.94 (minor).

### Test results
- **Frontend unit tests: 631 passed / 0 failed (58 files)** via `npm test`. Suite is green (baseline before fixes).
- All 8 README feature claims traced to real, reachable code (MCP panel, assistant tool-use in-WASM, Explain construct, persisted convos, domain-grounded answers, export wizard, share URL, diagram editing).

### Positives so far
- Welcome modal & template gallery (8 templates, Starter/Intermediate/Advanced tabs, search) are polished and functional.
- WASM language service boots cleanly; live diagnostics (KOI0109) and diagram render correctly.
- No uncaught JS errors on load or template open.

## ✅ Done — fixed & verified (this session)

All changes are frontend (TS/SCSS/HTML) — no `.koi`/compiler changes. Verified by: **`tsc --noEmit` clean**, **632 frontend tests pass**, live browser re-check, and a re-run Lighthouse.

| ID | Fix | Files | Verified |
|----|-----|-------|----------|
| F5 | Compatibility tab now shows an explanatory **"Model compatibility"** idle state with a "Check against baseline…" button (was a blank void). | `inspectorController.tsx`, `_docs.scss` | ✅ browser |
| F6 | Rules tab → intentional **"Business rules"** info panel (where invariants/guards live) instead of bare "Coming soon." | `index.html`, `_docs.scss` | ✅ browser |
| F7 | Notes tab → intentional **"Notes"** info panel (points to Description / Documentation→Notes) instead of "Coming soon." | `index.html`, `_docs.scss` | ✅ browser |
| F8 | "Open folder…" now **disabled with an honest reason** on non-Chromium (welcome action + toolbar button) instead of a dead button. | `welcome.ts`, `ide.tsx`, `_welcome.scss` | ✅ logic+tests (Chromium happy path verified) |
| F11b | **"Compiler tools" opt-in now shows for the Anthropic provider** (was hidden, so tool-use the README advertises was unreachable on the default provider). | `prefs.ts` | ✅ browser |
| F12 | README "scratch mode" doc drift corrected. | `README.md` | ✅ |
| F13 | Context-picker refresh failure now logs instead of silently emptying. | `inspectorController.tsx` | ✅ |
| F14 | CodeMirror editor + output viewer given `aria-label`s (a11y). | `editor.ts` | ✅ Lighthouse |
| F15 | `label-content-name-mismatch` fixed on brand, palette-hint (incl. runtime text in `ide.tsx`), and welcome actions. | `index.html`, `ide.tsx`, `welcome.ts` | ✅ Lighthouse |
| F16 | Explorer construct rows bumped to ≥24px (WCAG target size). | `_model.scss` | ✅ Lighthouse |
| F17 | Added `<meta name="description">`, `public/robots.txt`, `public/llms.txt`. | `index.html`, `public/` | ✅ Lighthouse |
| F19 | **Connection indicator "Offline"→"Local" bug** (default model first-impression) decoupled from diagnostics; tracks LSP lifecycle. | `editorSession.tsx` (+test) | ✅ browser |

### Lighthouse — before → after (desktop, navigation)
| Category | Before | After |
|----------|-------:|------:|
| Accessibility | 94 | **100** |
| Best Practices | 100 | **100** |
| SEO | 82 | **100** |
| Agentic Browsing | 31 | **64** |

Remaining Lighthouse fails are non-blocking: `cumulative-layout-shift` (0.93, from the WASM-boot first paint) and the experimental `llms-txt` heuristic (a valid `llms.txt` is now served).

## 🔁 Follow-up pass (after PR #224) — scoped via a parallel workflow, implemented incrementally

| ID | Item | Status |
|----|------|--------|
| F1 | `generate-templates.mjs` now writes `templates.generated.ts` only when content changed → no spurious Vite full-reload during `dev:web`. | ✅ fixed |
| F2a | **Data-loss fix:** opening a starter example is now **persistent + non-destructive** (`materializeWorkspace(…, persist=true)`: stable `example-<id>` OPFS token, seeded only first time, registered in IndexedDB). Edits survive a re-open and a reload instead of being wiped. Shared-link imports keep the fresh-each-time behavior via the default `persist=false`. Verified: 3 new vitest cases + browser (OPFS `example-ordering` dir created, friendly title). | ✅ fixed |
| F2b | Auto-restore last workspace on boot + examples in RECENT (so a reload lands back in the example without a click). Touches the boot ladder + recents display (token leaks `example-` prefix); deferred to avoid destabilizing the boot path pre-release. Plan ready. | ⏭ deferred |
| F9/F10 | No-OPFS in-memory workspace backend (Safari/Firefox-Private usable) — scoped (high feasibility, in-memory fallback recommended). Larger core FS-layer change, unverifiable in the Chromium audit env beyond vitest; F8 already removed the most visible dead button. Plan ready. | ⏭ deferred |
| Rules | **Rules tab now shows real business rules.** Wired invariants onto the diagram-node payload cross-stack: `DiagramNode.Invariants` (compiler) → both serializers (`LspServer.cs`, `CompilerInterop` WASM) → `DiagramNode.invariants` (TS) → `buildInspectorElement` → a new `renderRules` view driven by selection (`inspectorController.renderSelectedRules`). The Properties tab's existing Invariants compartment lights up too. Additive (new optional field) — Mermaid/snapshots untouched. Tests: +1 C# (`DiagramGraphTests`), +4 vitest; **1553 dotnet + 639 vitest pass**, public API updated, WASM rebuilt. State-transition **guards** + **per-element Notes** persistence remain (separate graph / new persistence) — tracked as a follow-up. | ✅ fixed (invariants) |

## 📝 Deferred / known limitations (reported, not fixed — with rationale)

- **F18 — not a bug.** The Generate-wizard "Back" button is already disabled on step 1 (`generateProjectWizard.ts:458`).
- **F3/F4 — 14 form fields lack `id`/`name`; the API-key password input isn't in a `<form>`.** Console best-practice notices only; **Lighthouse Best Practices is already 100**. Quick win for a follow-up: add `name`/`id` to the Settings inputs + wrap them in a `<form>`.
- **F9/F10 — no-OPFS browsers (Safari/Firefox Private).** The IDE boots to a single caption and examples/shared-link import fail. The F8 fix removes the most visible dead button; a proper "unsupported browser" screen + graceful fallback is recommended as a follow-up (cross-browser, unverifiable in the Chromium audit env).
- **Rules/Notes full editors** — the informative placeholders are intentional for v1; a tracked follow-up task was spawned to wire invariants/guards onto the LSP payload (Rules) and persist per-element Notes.

## 🚦 Release readiness verdict

The web IDE is **release-ready for a Chromium-first v1**: every primary surface (Welcome, template gallery, editor, generated-code preview, maxGraph diagram, glossary/ADR/notes docs, relationships/events tables, command palette, AI assistant, all 7 Settings tabs, theme, export wizard) is functional and polished; no JS console errors; 632 tests green; Lighthouse 100/100/100 on A11y/Best-Practices/SEO. The two visible "unfinished" tabs (Compatibility, Rules/Notes) and the misleading "Offline" indicator — the things that would read as broken to a first-time user — are fixed. Remaining items are cross-browser hardening and depth features, suitable for v1.x follow-ups.
