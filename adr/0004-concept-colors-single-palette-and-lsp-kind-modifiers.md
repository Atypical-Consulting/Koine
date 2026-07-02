# 0004. Concept Colors — single palette + LSP kind modifiers

Date: 2026-07-02

## Status

Proposed

<!-- One of: Proposed | Accepted | Rejected | Deprecated | Superseded by [NNNN](NNNN-xxx.md) -->

## Context

Koine's whole promise is *one ubiquitous language* — yet the **color** of a DDD concept changes
depending on which surface you look at. An inventory of the codebase found two disjoint color systems
and one deliberate contradiction:

- **A DDD-kind palette** (`--koi-ddd-*`, `tooling/koine-studio/src/styles/abstracts/_ddd.scss`) drives
  the Studio explorer icons, the inspector accent, and the canvas HTML labels. Its hex values are
  hand-duplicated in `diagrams-maxgraph.ts` (`DDD_HEX`).
- **A separate syntax palette** (`--koi-hl-*` / `--koi-hl-sem-*`) drives CodeMirror in Studio and the
  website playground, with unrelated hues — value objects render one blue in code and a different blue
  in the explorer; enums one yellow in code and another in the tree.
- **The LSP is the structural blocker.** `SemanticTokenProvider` emits only
  `type/enum/enumMember/property/keyword/parameter` — an aggregate is indistinguishable from a value
  object on the wire, so *no editor can color by concept today* even if it wanted to.
- **A third dialect contradicts the others:** the canvas's `EVENT_FLOW_HEX` colors aggregates yellow
  and commands blue, against the explorer's indigo/red.

Because the compiler collapses aggregate / entity / value object / event / service / repository —
everything except enums — into a single `type` semantic token, a Domain Developer or Architect
scanning a model cannot carry the color association from the tree or diagram into the source, which is
exactly where it would pay off. VS Code (TextMate scopes) and Rider (pure LSP client) inherit the same
under-specified legend.

Two design forces are in tension. We want kind-aware coloring in *our* editors, but we must not
regress generic LSP clients (any theme with no Koine knowledge, Rider via LSP4IJ) that today at least
render domain names with the base `type` color. And per the strictly-layered pipeline, a color is a
*presentation* concern that must never leak into `src/Koine.Compiler` / `Ast/`.

## Decision

We will adopt **Concept Colors** — *one DDD concept, one color, everywhere* — realized as follows:

1. **The compiler tells clients the concept *kind*, never the color.** Extend the LSP semantic-token
   legend with one **modifier per DDD concept kind** — `aggregate`, `entity`, `valueObject`,
   `enumeration`, `domainEvent`, `integrationEvent`, `command`, `query`, `readModel`, `service`,
   `repository`, `policy`, `factory`, `stateMachine`, `specification` — occupying bits **1–15** after
   the existing `declaration` bit (bit 0). The legend grows **append-only**: token-type indices 0–5
   and the declaration bit never shift. A *declaration* name carries `declaration | <kind>`; a
   *reference* resolves through the existing `ModelIndex` to its declaring kind and carries `<kind>`
   alone. Base token types (`type`, `enum`, …) are unchanged, so unknown clients degrade gracefully to
   today's baseline coloring. Primitives (`Decimal`, `String`, `List<…>`) carry no kind modifier.

2. **One machine-readable palette is the single source of every concept hex.**
   `design/concept-colors.json` becomes the only file in which a concept hex may be written. Every
   other occurrence is generated or `var()`-derived. Per-project generator scripts emit **committed**
   artifacts — Studio `_ddd.generated.scss` + `conceptColors.generated.ts`, website
   `concept-colors.generated.css` + a mirrored JSON, VS Code `semanticTokenScopes` defaults — each
   guarded by a sync test so the generated files can never drift from the source. Today's
   `--koi-ddd-*` hues are kept **verbatim** as the canonical `dark` values (users already know them
   from the explorer/canvas); `light` values are contrast-tuned variants held to WCAG contrast.

3. **Editors color names by kind, structure stays neutral.** Each editor decodes the kind bits into a
   `cm-st-k-<slug>` class themed `color: var(--koi-ddd-<slug>)`, applied *after* the base
   `cm-st-<type>` rule so kind wins. Keywords, strings, numbers, and punctuation stay neutral —
   **structure stays neutral; names carry the concept color.** VS Code maps the modifiers via
   `semanticTokenScopes` + default `semanticTokenColorCustomizations`.

4. **Conflicting palettes are retired.** The canvas's separate event-storming palette
   (`EVENT_FLOW_HEX`) is deleted in favor of the concept palette, and the editor's ad-hoc
   `--koi-hl-sem-enum` hue yields to `--koi-ddd-enum`. A documentation page (`guides/concept-colors`)
   names the principle, renders the palette *from the JSON* (so it can never drift), and carries the
   Event-Storming ↔ Koine mapping table for orientation.

Alternatives rejected: **custom token *types* per kind** (generic clients would drop domain names to
*no* styling — a regression outside our tools); **editor-local re-classification** (duplicates
compiler knowledge in every client and drifts, violating the layered pipeline); **adopting classic
Event-Storming sticky colors as the palette** (covers only ~6 kinds, tuned for paper not text-on-dark,
and would repaint an explorer/canvas users already know).

## Consequences

- **The legend is now a compatibility contract.** Token-type indices 0–5 and the modifier bit order
  (declaration = 0, kinds = 1–15) are frozen; new modifiers may only be *appended* at higher bits.
  Reordering them silently mis-colors every client that has cached the legend.
- **Colors are provably absent from the compiler.** `src/Koine.Compiler` ships only kind *names*; the
  layered-pipeline invariant (no presentation concept in `Ast/`) is preserved, and the classification
  reuses the `ModelIndex` the workspace already builds.
- **Generated files are committed and must be regenerated, not hand-edited.** Each carries a
  `GENERATED — edit design/concept-colors.json` banner and a sync test fails CI if it drifts. Editing
  a `--koi-ddd-*` value now means editing the JSON and re-running the generator, a small extra step
  traded for guaranteed cross-surface consistency.
- **Generic LSP clients keep working.** A theme with no Koine knowledge, or Rider via LSP4IJ, ignores
  the unknown modifiers and renders domain names with the base `type`/`enum` color exactly as today —
  no regression, just no upgrade until a client opts in.
- **`EVENT_FLOW_HEX` and `--koi-hl-sem-enum` are gone.** The event-flow view and kind-tagged enum
  identifiers now inherit the concept palette; the one behavior users lose is the event-storming-style
  yellow-aggregate/blue-command mapping on the canvas, which the docs page documents as a mapping
  table instead.
- **Deliberately deferred (follow-ups, not blockers):** a hue for bounded contexts (today structural /
  neutral), Rider-side custom coloring beyond the LSP fallback, a Shiki theme for static docs code
  blocks, and user-customizable palettes.
