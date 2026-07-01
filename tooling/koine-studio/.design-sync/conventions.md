## Koine Studio — how to build with this design system

Koine Studio is the IDE for **Koine**, a DSL for Domain-Driven Design. This is a
**token-first CSS design system**, not a component library: you style your own
markup with the design tokens below. There are **no React/JS components to import** —
build with plain HTML/JSX elements and Koine's CSS custom properties.

### Setup — no provider, just the stylesheet
`styles.css` is the whole system; its `@import` closure loads the three brand fonts,
every token, and the app's compiled component CSS. **No wrapper or provider is needed.**
Theme: **dark is the default**. For light, set `data-theme="light"` on `<html>` —
every `--koi-*` color token flips; nothing else changes.

### The idiom — style with `var(--koi-*)`, never hardcoded values
Reach for a token for every color, font, radius, space, and duration. The families
(all real, defined in `tokens/tokens.css`):

| Family | Tokens | Use for |
|---|---|---|
| Surfaces | `--koi-paper` · `--koi-paper-2` · `--koi-surface` · `--koi-line` | page bg · raised panels · inputs · borders |
| Text | `--koi-fg` · `--koi-muted` · `--koi-ink-soft` | primary · secondary · body ink |
| Accent | `--koi-accent` · `--koi-on-accent` · `--koi-cyan` · `--koi-accent-grad` | primary accent, ink on it, secondary, signature gradient |
| State | `--koi-error` · `--koi-on-error` | error surfaces |
| Fonts | `--koi-font-display` · `--koi-font-body` · `--koi-font-mono` | headings · UI/body · code |
| Radius | `--koi-radius-2xs·-xs·-sm` · `--koi-radius` (base 8px) · `--koi-radius-lg` · `--koi-radius-pill` | corners |
| Spacing | `--koi-space-1` (4px) … `--koi-space-4-5` (18px) | padding / margin / gap |
| Type ramp | `--koi-text-2xs` … `--koi-text-lg` (0.7–0.9rem, compact UI) | font-size |
| Motion | `--koi-dur-fast·-base·-mid·-slow` (0.12–0.18s) | transitions |
| Elevation | `--koi-shadow` | floating surfaces (dialogs, menus) |
| Z-index | `--koi-z-sticky·-overlay·-modal·-popover` | stacking |
| Syntax | `--koi-hl-keyword·-type·-string·-number·-comment·-punct` (+ `-regex·-meta`) | code coloring |
| DDD hues | `--koi-ddd-aggregate·-entity·-value·-enum·-event·-service·-repository·-spec` (+ command/query/policy/factory/state-machine…) | one hue per DDD building block — use these when coloring domain concepts |
| Language | `--lang-csharp·-typescript·-python·-php·-rust` | code-target brand badges |

Reusable control classes ship in the compiled CSS (style forms with these, not from
scratch): **`.koi-select` · `.koi-number` · `.koi-text` · `.koi-checkbox`** (accent
focus ring, `--koi-surface` fill) and **`.koi-field-label`**.

### Where the truth lives
Read `tokens/tokens.css` (both themes, one file) before styling; `styles.css` is the
entry. Every token family has a visual reference card under `components/tokens/`
(Colors, Typography, DDD palette, Syntax highlighting, Radius, Spacing, Elevation,
Language identity, Form controls) — open the matching `.html` to see real values.

### Idiomatic snippet
```html
<div style="
  background: var(--koi-paper-2);
  border: 1px solid var(--koi-line);
  border-radius: var(--koi-radius);
  padding: var(--koi-space-4);
  box-shadow: var(--koi-shadow);
  font-family: var(--koi-font-body);
  color: var(--koi-fg);">
  <h3 style="font-family: var(--koi-font-display); margin: 0 0 var(--koi-space-2)">Order</h3>
  <span style="color: var(--koi-ddd-aggregate)">aggregate</span>
  <button class="koi-select">Emit C#</button>
</div>
```
Prefer tokens over literals everywhere — that is what keeps a design on-brand and
theme-aware for free.
