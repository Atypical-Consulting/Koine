// Groups + ranks the Spotlight launcher's catalog into the sections `.lx-results` renders (issue
// #1143, task 4): the curated empty-query default (Top hits / Recent, `defaultResults`) when the "all"
// mode has no query, or the fuzzy-ranked pool (`rank`) grouped by `GROUPS` category order otherwise.
// Pulled out of LauncherPanel.tsx into its own pure, DOM-free function so a later task's selection
// reducer (which needs to index the exact same flat visible order for ↑/↓ wrap-around) and preview
// pane (which need "the Nth visible row's entry") can share this derivation instead of re-deriving it
// against the rendered component tree.
import { GROUPS, type CatalogEntry, type Category, type LauncherMode } from '@/launcher/catalog';
import { defaultResults } from '@/launcher/defaults';
import { rank, type RankedResult } from '@/launcher/fuzzy';

/** One grouped section of the results list: its header label and ranked rows. */
export interface ResultSection {
  label: string;
  rows: RankedResult[];
}

/**
 * The grouped sections to render, plus every section's rows flattened top-to-bottom in the same
 * order they paint — the index space a selection reducer's ↑/↓ (and "which entry is selected") must
 * key off, so `visible[i]` always matches the i-th `.lx-item` in DOM order.
 */
export interface DerivedResults {
  sections: ResultSection[];
  visible: RankedResult[];
}

const asRanked = (entries: CatalogEntry[]): RankedResult[] =>
  entries.map((entry) => ({ entry, score: 0, ranges: [] }));

/**
 * Derive the launcher's results view from the live `catalog`, the current `mode`, and the
 * mode-prefix-stripped `query`. An empty query in `MODES.all` shows the curated default set
 * (`defaultResults`) as "Top hits" / "Recent" sections; every other case fuzzy-ranks the catalog
 * (`rank`, restricted to `mode.cats` when the mode sets one) and groups the ranked rows by category in
 * `GROUPS` display order, skipping any group with no matches.
 */
export function deriveResults(catalog: CatalogEntry[], mode: LauncherMode, query: string): DerivedResults {
  let sections: ResultSection[];

  if (mode.key === 'all' && query === '') {
    const { hits, recent } = defaultResults(catalog);
    sections = [
      { label: 'Top hits', rows: asRanked(hits) },
      { label: 'Recent', rows: asRanked(recent) },
    ].filter((section) => section.rows.length > 0);
  } else {
    const ranked = rank(query, catalog, mode.cats);
    const byCat = new Map<Category, RankedResult[]>();
    for (const row of ranked) {
      const bucket = byCat.get(row.entry.cat);
      if (bucket) bucket.push(row);
      else byCat.set(row.entry.cat, [row]);
    }
    sections = GROUPS.filter(([cat]) => byCat.has(cat)).map(([cat, label]) => ({ label, rows: byCat.get(cat)! }));
  }

  return { sections, visible: sections.flatMap((section) => section.rows) };
}
