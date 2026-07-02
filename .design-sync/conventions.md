## Building with @atypical/koine-ui

`@atypical/koine-ui` is the design system extracted from **Koine Studio**, a dark-themed IDE for a
Domain-Driven-Design language. Every component is exposed on `window.KoineUi.*` as a normal
React-mountable component — use them as `<DeckBar .../>`, `<DeckCard .../>`, etc. with the props in each
component's `.d.ts`. Composition (passing `children`) works normally.

### Wrap everything in the dark themed surface — REQUIRED

The design tokens live on `:root` and are **dark by default**, but the package ships **no rule that paints
the page background** — the host app must establish the surface. Without it, the components' light ink
(`--koi-fg`) renders on a white page and is nearly invisible. Wrap your app root in a themed surface:

```jsx
function App() {
  return (
    <div style={{ background: 'var(--koi-paper)', color: 'var(--koi-fg)', fontFamily: 'var(--koi-font-body)', minHeight: '100vh' }}>
      <DeckBar mode="focus" primary="visual" secondary={null} surfaces={surfaces} onOverview={…} onFocus={…} onOpenBeside={…} />
      {/* your layout — style it with the koi tokens below */}
    </div>
  );
}
```

`window.KoineUi.ThemeSurface` is a ready-made version of that wrapper if you prefer.

### Styling idiom: koi tokens (no utility classes)

The components style themselves; **you style your own layout glue with `var(--koi-*)` CSS custom
properties** — never invent class names, and don't restyle the components. The vocabulary (all defined in
the bound `styles.css`):

| Concern | Tokens |
|---|---|
| Surfaces (dark→raised) | `--koi-paper` `--koi-paper-2` `--koi-surface` · borders `--koi-line` |
| Ink | `--koi-fg` (primary) `--koi-ink-soft` `--koi-muted` (dim) |
| Accent / status | `--koi-accent` `--koi-cyan` `--koi-error` · on-accent ink `--koi-on-accent` |
| Spacing | `--koi-space-1` … `--koi-space-4-5` (4px … 18px, plus `-0-5`/`-1-25` half-steps) |
| Radius | `--koi-radius-xs` `--koi-radius-sm` `--koi-radius` `--koi-radius-lg` `--koi-radius-pill` |
| Type | `--koi-font-body` `--koi-font-mono` · sizes `--koi-text-xs` … `--koi-text-lg` |
| Domain (DDD) accents | `--koi-ddd-aggregate` `--koi-ddd-entity` `--koi-ddd-value` `--koi-ddd-event` `--koi-ddd-command` … |
| Language accents | `--lang-csharp` `--lang-typescript` `--lang-python` `--lang-php` `--lang-rust` |

A light theme exists: set `data-theme="light"` on an ancestor (`html[data-theme=light]`) to flip the same
tokens. Default (no attribute) is dark.

### Where the truth lives

Read the bound `styles.css` and its `@import` closure for the full token set and component styles, and each
component's `.prompt.md` for its API and usage. The components are: **DeckBar**, **DeckCard** (the center
"deck" of surface cards), **LeftRail**, **RightStrip** (rail toolbars), **AssistantView** (AI chat host),
**ExportMenu**. Prefer reading those real files over guessing.
