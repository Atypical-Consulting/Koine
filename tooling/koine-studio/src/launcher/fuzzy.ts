// Pure, DOM-free port of the fuzzy ranking scheme from
// design/design_handoff_git_spotlight_logos/koine-launcher.js's `fuzzy` / `highlight` / `rank`. Ported
// verbatim (same subsequence walk, same bonus weights) so the Preact launcher ranks results
// identically to the prototype; the only change is the shape of the output — `highlight` returns
// view-model segments instead of an HTML string with `<mark>`, so the UI layer stays DOM-free too —
// and `rank` takes its pool as a parameter instead of closing over the prototype's global `DATA`.
import type { CatalogEntry, Category } from '@/launcher/catalog';

/** One matched-or-not run of a highlighted string, in original text order. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/** The result of a successful fuzzy match: the score and the matched character indices (0-based, into the ORIGINAL text). */
export interface FuzzyMatch {
  score: number;
  ranges: number[];
}

/**
 * Score `text` as a fuzzy subsequence match of `q`. Returns `null` when `q` is not a subsequence of
 * `text` (case-insensitively). An empty query always matches with a neutral `{ score: 0, ranges: [] }`.
 *
 * Bonuses (ported verbatim from the prototype):
 * - base `+1` per matched character
 * - `+3` when the match is consecutive with the previous one
 * - `+4` when the match sits on a word boundary (index 0, or preceded by a non-alphanumeric char)
 * - `+3` when the matched character is an uppercase "camelCase hump" (and not at index 0)
 * - `-0.15` per unmatched character in `text` (a loose-length penalty favoring tighter matches)
 * - `+12` when `text` starts with `q` (case-insensitive)
 */
export function fuzzy(q: string, text: string): FuzzyMatch | null {
  if (!q) return { score: 0, ranges: [] };
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  let ti = 0;
  let prev = -2;
  let score = 0;
  const ranges: number[] = [];
  for (let si = 0; si < s.length; si++) {
    const ch = s[si];
    let found = -1;
    for (let k = ti; k < t.length; k++) {
      if (t[k] === ch) {
        found = k;
        break;
      }
    }
    if (found === -1) return null;
    let bonus = 1;
    if (found === prev + 1) bonus += 3; // consecutive
    if (found === 0 || /[^a-z0-9]/i.test(t[found - 1])) bonus += 4; // word boundary
    if (/[A-Z]/.test(text[found]) && found > 0) bonus += 3; // camelCase hump
    score += bonus;
    ranges.push(found);
    prev = found;
    ti = found + 1;
  }
  score -= (t.length - s.length) * 0.15; // prefer tight matches
  if (t.startsWith(s)) score += 12;
  return { score, ranges };
}

/**
 * Turn `ranges` (matched character indices into `text`) into merged runs of matched/unmatched text
 * — the pure data a Preact component maps to `<mark>` vs plain text, never an HTML string.
 */
export function highlight(text: string, ranges: number[]): HighlightSegment[] {
  if (!ranges.length) return [{ text, match: false }];
  const set = new Set(ranges);
  const segments: HighlightSegment[] = [];
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    const last = segments[segments.length - 1];
    if (last && last.match === match) {
      last.text += text[i];
    } else {
      segments.push({ text: text[i], match });
    }
  }
  return segments;
}

/** One scored catalog entry: the score and the title's matched-index ranges (empty when the score came from the secondary keywords/ctx/sub pass, since then the title itself isn't what matched). */
export interface RankedResult {
  entry: CatalogEntry;
  score: number;
  ranges: number[];
}

/**
 * Rank `pool` for `query`, optionally restricted to `cats`. Two passes per entry: first
 * `fuzzy(query, entry.title)` — a hit keeps that score and its highlight ranges. When the title
 * doesn't match, a secondary pass scores `entry.keywords + ' ' + entry.ctx + ' ' + entry.sub` at
 * `secondary.score * 0.4 - 2`, with no highlight ranges. An entry matching neither pass is dropped.
 * Results sort by score descending, ties broken by the shorter title. An empty query is a fast path:
 * every (cats-filtered) pool entry at `score: 0, ranges: []`, in pool order.
 */
export function rank(query: string, pool: CatalogEntry[], cats?: Category[]): RankedResult[] {
  const filtered = cats ? pool.filter((e) => cats.includes(e.cat)) : pool;
  if (!query) return filtered.map((entry) => ({ entry, score: 0, ranges: [] }));
  const out: RankedResult[] = [];
  for (const entry of filtered) {
    const primary = fuzzy(query, entry.title);
    if (primary) {
      out.push({ entry, score: primary.score, ranges: primary.ranges });
      continue;
    }
    const hay = `${entry.keywords ?? ''} ${entry.ctx ?? ''} ${entry.sub ?? ''}`;
    const secondary = fuzzy(query, hay);
    if (secondary) out.push({ entry, score: secondary.score * 0.4 - 2, ranges: [] });
  }
  out.sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length);
  return out;
}
