# Center-view concepts — interactive POCs

Five distinct interaction models for managing Koine Studio's center surfaces
(**Canvas · Code · Output · Docs**), built to replace the current double tab row.
Each is pure HTML/CSS/JS, shares an identical app-shell mock and identical
Pizzeria/Ordering content, and works in **both light and dark** themes — so you
compare the *idea*, not the dressing.

## Open

```bash
cd tooling/koine-studio/design/center-concepts
python3 -m http.server 7788
# → http://localhost:7788/index.html   (gallery: pick a concept on the left)
```

Each concept is also a standalone file you can open directly
(`concept-1-lens.html`, …). The theme toggle (top-right of each) flips light/dark;
in the gallery it drives the embedded concept too.

## The five

| # | Name | Thesis | Switch | Split | Best when |
|---|------|--------|--------|-------|-----------|
| 1 | **Lens** | One model, four lenses — not four documents | centered segmented control | hover a lens → ⊞ opens it beside the current; closeable | you want the safest, most familiar upgrade |
| 2 | **Orbit** | Keyboard-first focus rail | edge icon rail · `Alt`+`1–4` | drag an icon onto the stage, or the ⊞ toggle | power users; minimal chrome; live status on icons |
| 3 | **Atelier** | The model is the map | top-left floating dock over the canvas | implicit — canvas is always behind the drawer | DDD-first; the diagram is the home, code/docs peek in |
| 4 | **Panes** | Composable editor groups, no tab row anywhere | per-pane breadcrumb `▾` | add/close panes (1–3), drag the seams | the "VS Code editor groups done right" direction, clean |
| 5 | **Deck** | Zoom out to see everything | filmstrip · `1–4` | n/a — `Esc`/Overview shows all four at once (2×2) | a signature, demo-able moment; whole-model glance |
| 6 | **Deck v2** ⭐ | Deck, refined | filmstrip · `1–4` · ⊞/`⇧+1–4` open beside | **1-up or 2-up** — two live surfaces, resizable seam, swap ⇄, per-pane ✕ | the recommended evolution of Deck: keeps the bird's-eye, adds Lens-style compare |

### Deck v2 — what changed from Deck

- **Two live surfaces.** Focus mode is now 1-up *or* 2-up: any pair side by side,
  with a draggable seam, a swap (⇄), and a per-pane close (✕). The filmstrip's ⊞
  ("open beside") is the Lens compare affordance, ported into the card world.
- **Real FLIP transitions.** v1 animated `top/left/width/height` (layout props) —
  reflow every frame, content re-rasterized, canvas edges restuttered. v2 lays every
  card out at its *final* size instantly and animates only `transform` (translate +
  scale) — a compositor-only zoom at 60fps. Because the canvas's layout box is
  final-size from frame one, its edges draw **once** and are merely scaled during the
  zoom. Expo-out easing, subtle stagger into the bird's-eye.
- **Grounded overview.** The 2×2 bird's-eye rings the active pair so you always know
  where the zoom will return.
- **Active-pane selection.** Clicking either pane in a 2-up selects it (accent header +
  cap); the panes don't move. ⇄ inverts left/right but keeps the selection.
- **Facets (sub-views) answered.** Each surface holds its facets in a sub-strip in the
  card header — Code = Editor·Scenarios, Output = Generated·Compatibility·Context Map,
  Docs = Glossary·ADRs·Notes. The surface stays the unit (the 2×2 stays clean, 4 cards
  not 9); the strip picks the facet, and each pane remembers its own. Switchable live in
  both 1-up and 2-up; hidden in the bird's-eye (the body still shows the current facet).
- Plain click / `1–4` = go to that surface 1-up; ⊞ / `⇧`+`1–4` = open beside.
  `Esc` toggles the bird's-eye. Respects `prefers-reduced-motion`.
- Hover/reveal chrome animates via opacity + width (the ⊞ and close buttons fade and the
  header resizes smoothly) on a single shared `cubic-bezier(.33,1,.68,1)` easing.

## Notes

- Surface hosts are a cached pool (one DOM node per view, moved between panes,
  never re-created) — the same single-element technique the real Studio uses, and
  what makes "switch one pane without refreshing the other" free.
- The canvas is a real mini-diagram: draggable nodes, edges redrawn on resize.
- These are throwaway design POCs (not wired to the Studio store). Once a
  direction is chosen, it gets implemented against `uiChrome.ts` /
  `CenterSplitPanes.tsx` for real.
