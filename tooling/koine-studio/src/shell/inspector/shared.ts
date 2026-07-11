// Shared helpers for the inspector facade and its #985 sub-modules (#1262). The decomposition's sibling
// modules (contextMapPanel / activeContextController / surfaceLoaders / centerDeckController) deliberately
// never import each other — only the facade wires cross-module effects — which left these three small
// helpers duplicated in exactly two places each. This module is the ONE place they may share: it is
// store/facade-free (no runtime import of the app store, the facade, or any sibling module — the slice
// types below are type-only, erased at compile time), so importing it can never reintroduce the
// import-cycle risk the split guards against. Keep it that way: pure functions over passed-in values
// only; anything that needs the store instance, a deps bag, or a DOM lookup belongs in its consumer.
import { render } from 'preact';
import type { CenterView, DeckState } from '@/store/slices/uiChrome';

/** The center surfaces visible under a deck state: overview shows all four (canonical order), focus shows
 *  the primary plus the 2-up secondary when split. Pure over the passed `deck` value — each consumer
 *  binds its own store read (`store.getState().deck`) at the call site. */
export function visibleCenters(deck: DeckState): CenterView[] {
  if (deck.mode === 'overview') return ['visual', 'technical', 'output', 'docs'];
  return deck.secondary ? [deck.primary, deck.secondary] : [deck.primary];
}

/** The per-workspace storage key derived from the opened-folder token (folder identity, or 'scratch' in
 *  no-folder mode) — keys the active-scope and diagram-layout persistence, so both consumers derive the
 *  SAME key from the same injected `folderRootToken`. */
export function contextWorkspaceKey(folderRootToken: string): string {
  return folderRootToken || 'scratch';
}

/** Write a status/empty/error message imperatively into a host that may currently hold a Preact tree.
 *  Unmounting any prior Preact tree FIRST is load-bearing: a raw innerHTML write and the reconciler must
 *  never fight over the same node (on a host that never holds a Preact tree the unmount is a harmless
 *  no-op, kept so every host gets the same contract). */
export function docMessage(view: HTMLElement, text: string, kind: 'muted' | 'error' = 'muted'): void {
  render(null, view);
  view.innerHTML = '';
  const p = document.createElement('p');
  p.className = kind === 'error' ? 'doc-error' : 'muted';
  p.textContent = text;
  view.appendChild(p);
}
