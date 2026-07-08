# 0009. The active bounded-context scope is the workbench spine

Date: 2026-07-08

## Status

Proposed

## Context

Koine Studio already has a global **active bounded-context scope** (the `activeContext` store slice,
issue #146): a single "which context am I looking at" value, defaulting to *All contexts*, driven from
the left Domain navigator and — since #1182 — the status-bar `Context:` control, and read back by a
subscription that re-renders the scoped surfaces.

But an IA audit of the workbench (the pass that produced #1180, #1182, #1186, #1189) found the scope
only reaches about **half** the surfaces. Selecting a context today narrows the domain **diagram**, the
**glossary**, and the bottom **Events/Relationships** tables — and is silently ignored by the **Files
tree**, the **Output/Generated rail**, the **Context Map** centre view, and **Problems**. Because some
surfaces react and others don't, a user can't tell whether a scope choice "took": the same action means
different things in different panes. The mental model never settles, which was a root cause of the
"the panels feel confusing" report that started the consolidation.

The audit also established two facts that shape the fix:

- The scope is a **filter, never a mutation** — every helper derives a narrowed *projection* from
  existing data; the compiler / LSP / semantic model are untouched.
- Some surfaces must **not** disappear under a scope. The Files tree is the only place you *author*
  and manage `.koi` source; the Output rail is the overview of *everything* the model emits. Hiding
  their non-active entries would break authoring and lose the whole-model view.

## Decision

We will make the active-context scope the **single spine every surface obeys**. Concretely:

- **Model-derived surfaces narrow.** The diagram, glossary, model outline, and the Events/Relationships
  tables show only the active context (identity when *All contexts*). This is the existing behaviour;
  it stays.
- **Source and output surfaces emphasise, never hide.** The Files tree and the Output/Generated rail
  keep *every* entry visible and **emphasise** the active context's entries (and de-emphasise the
  rest). *All contexts* removes the emphasis. This preserves authoring and the whole-model overview.
- **The strategic Domain navigator stays global.** It is the *selector* — it must list every context
  to let you pick one — so it never narrows; it only marks which context is active.
- **One canonical control, one escape.** The status-bar `Context:` segment is the single scope control
  (#1182); *All contexts* is the universal escape from any narrowing or emphasis.
- **Every surface declares its relationship to the scope.** A surface is *narrowing*, *emphasising*, or
  *the selector* — a deliberate, documented choice. A new model-derived surface may not silently ignore
  the scope; if it should stay global, that is stated, not defaulted into.
- **Emphasis carries a non-colour signal.** Because de-emphasis (dimming) is a colour/contrast-only
  cue, an emphasising surface also marks the active group with a non-colour indicator (a marker/label),
  so the active scope reads without relying on hue (WCAG AA).

Everything continues to route through the one choke point: `setActiveContext` → `applyScope` writes the
slice; the `activeContext` subscription (`rerenderScopedSurfaces`) fans out. This decision extends
*which* surfaces that subscription touches and *how* each responds — it introduces no second scope path.

## Consequences

- **Easier:** one coherent mental model — pick a context and the whole workbench responds, each pane in
  its declared way. Each surface's scope behaviour becomes a reviewable decision rather than an
  accident. The single choke point and subscription remain the only wiring, so adding a surface is
  "subscribe + declare narrow/emphasise", not new plumbing.
- **Harder / trade-offs accepted:** every model-derived surface must be wired to the subscription and
  make the narrow-vs-emphasise call — more per-surface code and one more judgement per panel. Emphasis
  is a *weaker* signal than hiding, so an emphasising surface must invest in a legible active marker;
  we accept that over the alternative (hiding source/output, which breaks authoring and the overview).
  Matching the Output rail's by-folder grouping to bounded-context names assumes emitted output is
  organised by context — true across the current targets; a target that flattens output would emphasise
  nothing (a graceful no-op) until its grouping is taught the mapping.
- **Rollout:** incremental — one or two surfaces per PR, tracked by #1188. This ADR ships alongside the
  first application (the Output/Generated rail emphasises the active context). The Files tree, the
  Context Map centre view, and a Problems scope filter follow; the strategic navigator gains a
  persistent active marker.
