// Curated empty-query default set for the Spotlight launcher (issue #1143, task 4). Ported from
// design/design_handoff_git_spotlight_logos/koine-launcher.js's `defaultResults()`: rather than
// dumping the whole catalog when the query is empty, the launcher shows a "Top hits" slice of domain
// symbols and a "Recent" slice — commits when the host has git history, files otherwise. buildCatalog
// already omits every commit entry when `!canUseGit` (buildCatalog.ts's `commitEntries`), so "any
// commit entries present in the catalog" is enough of a gate here without threading `canUseGit`
// through a second seam.
import type { CatalogEntry } from '@/launcher/catalog';

const TOP_HITS_LIMIT = 4;
const RECENT_LIMIT = 4;

/** The curated empty-query result set: a few domain symbols, and a few recent commits or files. */
export interface DefaultResults {
  hits: CatalogEntry[];
  recent: CatalogEntry[];
}

/**
 * Curate the empty-query default view from the live catalog: the first `TOP_HITS_LIMIT` domain
 * symbols (catalog/pool order) and the first `RECENT_LIMIT` commits — already newest-first, since
 * `buildCatalog` lists `sources.gitLog()` in that order — or, when there are none (browser host, or
 * any host with no git history), the first `RECENT_LIMIT` files instead.
 */
export function defaultResults(catalog: CatalogEntry[]): DefaultResults {
  const hits = catalog.filter((entry) => entry.cat === 'symbol').slice(0, TOP_HITS_LIMIT);
  const commits = catalog.filter((entry) => entry.cat === 'commit');
  const recentPool = commits.length ? commits : catalog.filter((entry) => entry.cat === 'file');
  return { hits, recent: recentPool.slice(0, RECENT_LIMIT) };
}
