## Koine Studio — how to build with this design system

Koine Studio is the IDE for **Koine**, a DSL for Domain-Driven Design. This sync gives you two things:
**live React-mountable components** (the real Studio panels) and the **design tokens** they're built on.

### Live components — `window.KoineStudio.*`
The Studio's panels are authored in Preact; each is wrapped in a thin adapter so it mounts as a normal
**React** component. Compose them like any React component:

```jsx
// plain-props panel
<KoineStudio.DeckBar mode="focus" primary="visual" secondary={null}
  onOverview={() => {}} onFocus={() => {}} onOpenBeside={() => {}} />

// store-bound panel: pass a Studio store + its data model
const store = KoineStudio.createStore();          // an empty Studio store (zustand)
<KoineStudio.GlossaryPanel store={store} model={glossaryModel} handlers={{ onGoto(){}, onSave(){} }} />
```

Two shapes, told apart by each component's `*.prompt.md` / `*.d.ts`:
- **Plain-props** — pass data/callbacks directly: `DeckBar`, `DeckCard`, `ExportMenu`, `RightStrip`,
  `AssistantView`, `SourceControlPanel`, plus zero-config scenes `DeckStage`, `LeftRail`.
- **Store-bound** — pass `store={KoineStudio.createStore()}` **and** the panel's data prop(s) (`model`,
  `index`, …): `GlossaryPanel`, `ModelOutlinePanel`, `PropertiesPanel`, `RelationshipsPanel`,
  `EventsPanel`, `ContextBreadcrumb`, `DiagnosticsStripPanel`, `WorkspaceProblemsBadge`, `CanvasPalette`,
  `DocsPanelHost`, `HistoryControls`, `StoreInspector`. The store carries UI state (active context,
  selection, filter); the data prop carries the domain model.

Also on the namespace: `KoineStudio.createStore()` (store factory) and `KoineStudio.DECK_SURFACES` (the
Canvas/Code/Output/Docs surface descriptors). Each component ships a `<Name>.d.ts` (real prop contract)
and a `<Name>.prompt.md` (usage) beside its preview card — **read those before composing a panel.**
`SettingsPage` is a preview-only reference (it bundles a full editor) and is not on the namespace.

### Setup
`styles.css` is the whole styling system (fonts + tokens + the Studio's compiled component CSS via its
`@import` closure). **No provider/wrapper is needed.** Dark is the default; set `data-theme="light"` on
`<html>` for light — every color token flips.

### Design tokens — style your own markup with `var(--koi-*)`
Use a token for every color/font/space/radius (never hardcode). Families (defined in `tokens/tokens.css`):

| Family | Tokens |
|---|---|
| Surfaces | `--koi-paper` · `--koi-paper-2` · `--koi-surface` · `--koi-line` |
| Text | `--koi-fg` · `--koi-muted` · `--koi-ink-soft` |
| Accent | `--koi-accent` · `--koi-on-accent` · `--koi-cyan` · `--koi-accent-grad` |
| Fonts | `--koi-font-display` · `--koi-font-body` · `--koi-font-mono` |
| Radius | `--koi-radius-2xs…-xs…-sm` · `--koi-radius` (8px) · `--koi-radius-lg` · `--koi-radius-pill` |
| Spacing | `--koi-space-1` (4px) … `--koi-space-4-5` (18px) |
| Type ramp | `--koi-text-2xs` … `--koi-text-lg` |
| Motion | `--koi-dur-fast·-base·-mid·-slow` · Elevation `--koi-shadow` |
| DDD hues | `--koi-ddd-aggregate·-entity·-value·-enum·-event·-service·-repository·-spec` (+ command/query/policy/…) |
| Language | `--lang-csharp·-typescript·-python·-php·-rust` |

Reusable control classes ship in the CSS: `.koi-select` · `.koi-number` · `.koi-text` · `.koi-checkbox`.
The `Tokens` gallery cards (Colors, Typography, DDD palette, …) show every value.

### Idiomatic snippet — a Studio-style screen from real panels + tokens
```jsx
const store = KoineStudio.createStore();
<div style={{ display:'grid', gridTemplateColumns:'260px 1fr', gap:'var(--koi-space-3)',
  background:'var(--koi-paper)', color:'var(--koi-fg)', fontFamily:'var(--koi-font-body)' }}>
  <KoineStudio.ModelOutlinePanel store={store} model={outlineModel} handlers={handlers} />
  <KoineStudio.DeckStage />
</div>
```
Prefer tokens over literals and real panels over re-implementations — that keeps a design on-brand and
theme-aware for free.
