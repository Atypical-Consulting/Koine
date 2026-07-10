// The ubiquitous-language glossary editor (#67): pure data helpers for the glossary tab, decoupled
// from the LSP/editor wiring via a `handlers` object so they unit-test cleanly. `ide.ts` supplies the
// handlers (jump-to-source via the editor, persist via koine/setDoc). The DOM assembly used to live
// here as `renderGlossary`/`renderEntry`/`renderDescription`/`openDescriptionEditor`; #992 moved it into
// `GlossaryPanel.tsx` as real JSX (`GlossaryEntryRow`) — this module keeps only the pure functions its
// importers (the panel, its tests) still consume.
import type { GlossaryEntry, Range } from '@/lsp/lsp';

export interface GlossaryHandlers {
  /** Jump the editor to a declaration's name range. */
  onGoto(range: Range): void;
  /** Persist a description (write the `///` doc comment back to source). */
  onSave(entry: GlossaryEntry, text: string): void;
}

/** Documentation coverage over the glossary entries (an entry counts as documented iff its doc is non-blank). */
export function coverage(entries: GlossaryEntry[]): { documented: number; total: number; pct: number } {
  const documented = entries.filter((e) => e.doc != null && e.doc.trim().length > 0).length;
  const total = entries.length;
  const pct = total === 0 ? 0 : Math.round((documented / total) * 100);
  return { documented, total, pct };
}

/** Group entries by owning context, preserving declaration order of both contexts and entries. */
export function groupByContext(entries: GlossaryEntry[]): { context: string; entries: GlossaryEntry[] }[] {
  const groups: { context: string; entries: GlossaryEntry[] }[] = [];
  for (const e of entries) {
    let g = groups.find((x) => x.context === e.context);
    if (!g) {
      g = { context: e.context, entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}
