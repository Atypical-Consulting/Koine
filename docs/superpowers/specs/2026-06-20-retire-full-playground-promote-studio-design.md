# Retire the full Playground, promote Koine Studio

**Date:** 2026-06-20
**Status:** Approved (brainstorming → spec)
**Area:** `website/` (Astro Starlight docs/marketing site)

## Problem

On the marketing site the surface hierarchy is inverted. The **full Playground**
(`/playground/`) is promoted everywhere — the top-nav link, the hero's primary CTA
("Try the Playground ▸"), the footer, and the multi-target teaser all point at it.
**Koine Studio** — the flagship browser IDE, bundled into the site at `/studio/` — gets
exactly one inline text link, buried under the embedded playground on the home page.

The full Playground is also a redundant "middle child": more than the inline mini
playground taste, strictly less than Studio. Studio is a **superset** of it:

| Job | Full Playground | Studio |
| --- | --- | --- |
| Multi-target (C#/TS/Python/PHP/Glossary) | yes | yes |
| Examples / starter models | `?example=` deep links | template gallery (richer) |
| Share a model by URL | `#model=` | same `#model=` scheme |
| Glossary, context map, hover docs, go-to-def | no | yes |

## Goal

Build the funnel **mini playground (inline taste) → Studio (the flagship)** and remove the
redundant middle. Nothing the full Playground did is lost; Studio covers it all.

Non-goals: no change to Studio itself, the WASM bundle, the compiler, or
`website/scripts/build-studio.mjs`. No new `?example=` boot support added to Studio.

## Decisions (from brainstorming)

1. **Delete `/playground/`** and redirect its deep links to Studio so nothing 404s.
2. **Studio-forward hero**: hero primary CTA becomes "Open Koine Studio ▸"; the mini
   playground stays as the live-proof band below, and its onward link carries the edited
   model into Studio. Nav gains "Studio".
3. **Approach B — collapse the component**: simplify `Playground.astro` / `controller.ts`
   to a single embedded-only mode, dropping the now-unreachable full-only controls. "Cut
   the feature" means removing the machinery, not just hiding the door.
4. The multi-target teaser's "ordering" link lands in Studio **with the ordering model
   preloaded** (`/studio/#model=<encoded ordering sample>`), not a blank Studio.

## Current state (facts established)

- `website/src/pages/playground.astro` — the full-page IDE wrapper. **Deleted/replaced.**
- `website/src/components/Playground.astro` — dual-mode component (`embedded?: boolean`).
  Renders all controls and toggles full-vs-embedded via `[data-embedded]` CSS.
- `website/src/playground/controller.ts` — `mountPlayground(el)`. Full-only branches gated
  on `!embedded`: sample dropdown, Reset, Share (URL + localStorage), resizer drag, target
  persistence, and `initialSource()` reading `?code=` / `?example=` / localStorage. Embedded
  always boots `DEFAULT_SAMPLE`. Embedded currently wires `.koi-open` ("Open full
  Playground", `?code=`); the full page wires `.koi-studio` ("Open in Studio", `#model=`).
- `website/src/playground/samples/index.ts` — `SAMPLES`, `DEFAULT_SAMPLE`, `sampleById`.
  Lightweight data; the `?example=` ids resolve here (`billing`, `values`, `ordering`, …).
- Studio boot contract (`tooling/koine-studio/src/share.ts`): reads `#model=<base64>` from
  the URL hash only. Does **not** read `?example=`. `encodeCode` in the website controller
  produces exactly the base64-utf8 Studio expects.
- Inbound links to `/playground/` to re-point:
  - `src/layouts/BlueprintLayout.astro` — header nav (line ~76) and mobile nav (line ~90).
  - `src/pages/index.astro` — hero primary CTA (line ~54), multi-target teaser (line ~152).
    The live-proof band's "Open Koine Studio ▸" prose (line ~100) already points at Studio.
  - Docs/blog `.md`: `start/your-first-model.md`, `start/what-is-koine.md`,
    `blog/introducing-koine.md`, `blog/modeling-money-value-objects-and-invariants.md`,
    `blog/one-model-many-targets.md` (×2), `guides/cli.md`,
    `tutorials/values-and-invariants.md`, `guides/koine-studio.md`,
    `reference/templates.md`.

## Design

### 1. Redirect `/playground/` → Studio

Replace `website/src/pages/playground.astro` with a tiny static redirect stub. It must run
JS, because the `#model=` hash carries real shared models and a `<meta http-equiv="refresh">`
would drop the fragment.

Mapping (base is `/Koine/`, Studio at `/Koine/studio/`):

- `#model=…` present → `/studio/#model=…` (real shared models — must round-trip)
- `?code=<enc>` → `/studio/#model=<enc>` (same encoding)
- `?example=<id>` → resolve the sample source via `sampleById`, encode, →
  `/studio/#model=<enc>`; unknown id → `/studio/`
- bare `/playground/` → `/studio/`
- `<noscript>` + `<meta http-equiv="refresh">` fallback → bare `/studio/`

The stub imports only the lightweight `samples` data plus a local 3-line base64 encode
(`encodeCode`-equivalent). It must **not** import `controller.ts` (which pulls in
CodeMirror). Performs `location.replace(target)` so the dead URL leaves no history entry.

### 2. Collapse the Playground component to embedded-only (Approach B)

`website/src/components/Playground.astro`:

- Remove the `embedded` prop; the component always renders the compact toolbar.
- Keep: the 5 target tabs (C#/TS/Python/PHP/Glossary), generated-file picker, Copy,
  Download, mobile Model/Output tabs, diagnostics, compile-as-you-type.
- Remove from markup: the sample dropdown (`.koi-sample`), Reset (`.koi-reset`), Share
  (`.koi-share`), the resizer (`.koi-resizer`), and the "Open full Playground" link
  (`.koi-open`).
- Keep/show the "Open in Studio ▸" link (`.koi-studio`) — this is now the onward handoff.
- Drop the `[data-embedded]`-toggled CSS branches; fold the embedded layout in as the only
  layout.

`website/src/playground/controller.ts`:

- Drop the `!embedded` branches: sample dropdown population, Reset, Share, resizer drag,
  target persistence (localStorage), and the `?code=`/`?example=`/localStorage paths in
  `initialSource()` — booting always uses `DEFAULT_SAMPLE`.
- Remove the `.koi-open` handler.
- Always wire `.koi-studio`: refresh `href = /studio/#model=<encodeCode(doc)>` on
  `pointerdown`/`focus` (the existing handoff logic, just no longer gated on `!embedded`).
- Keep `encodeCode`/`decodeCode`, `SAMPLES`/`DEFAULT_SAMPLE` usage, and the wasm compile loop
  untouched.

### 3. Promote Studio in the chrome

- `src/layouts/BlueprintLayout.astro`: header nav and mobile nav — `Playground` → `Studio`,
  href `/studio/`.
- `src/pages/index.astro`:
  - Hero primary CTA → "Open Koine Studio ▸", href `/studio/`. Secondary stays "Get
    started". The "No install. The compiler runs in your browser." note stays (true of
    Studio).
  - Multi-target teaser CTA → Studio with the ordering model preloaded:
    `/studio/#model=<encoded ordering sample>`, generated at build time in the page
    frontmatter (import the `ordering` sample + encode). Copy can become e.g. "Explore the
    Ordering model in Studio ▸".
  - Live-proof band: unchanged structure; mini playground stays, its "Open Koine Studio ▸"
    prose stays, the toolbar handoff (§2) is the in-editor path.

### 4. Doc / blog cleanup

- Re-point the `.koi-try` callout links and inline `[Playground]` links in the 10 `.md`
  files to `/studio/` (drop `?example=` query strings, since Studio uses the template
  gallery / `#model=`; or preload via `#model=` only where a specific model genuinely
  matters — default to bare `/studio/`).
- Reword the few sentences describing Playground-only mechanics:
  `reference/templates.md` ("Playground sample picker all read from it") and
  `guides/koine-studio.md` ("with the Playground") → reference Studio or the inline mini
  playground on the home page.
- The redirect (§1) is the safety net for any link missed.

## Verification

- `npm run build` (or the site's build script) succeeds; `/playground/` emits the redirect
  stub, `/studio/` still builds.
- Manual: visiting `/Koine/playground/`, `/Koine/playground/?example=ordering`,
  `/Koine/playground/#model=…`, and `/Koine/playground/?code=…` each lands in Studio with
  the expected model (or bare Studio for the no-arg case).
- Manual: home hero CTA and nav point at Studio; the mini playground's "Open in Studio ▸"
  opens Studio carrying the just-edited model.
- Grep: no remaining `"/playground"` links in `src/` except the redirect stub itself and the
  controller's own module path.

## Risks

- Touching `controller.ts` (Approach B) affects the mini playground real visitors see —
  re-verify compile-as-you-type, target switching, file picker, Copy/Download, mobile tabs,
  and the Studio handoff after the change.
- The redirect must preserve the `#model=` hash exactly; a regression silently breaks shared
  models. Cover the four URL shapes above in manual verification.
