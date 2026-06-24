// Pure workspace search/replace core, factored out of the Studio shell so find-across-files is
// unit-testable without a DOM, an editor, or a live host fs. Every function here is pure over plain
// `{ uri, text }` records — no imports, no app state. The Preact search panel (searchController.tsx)
// drives these; the host fs / dirty pipeline live entirely on the panel side.

/** A find query as the search panel collects it from its inputs. */
export interface SearchQuery {
  /** The needle: a literal substring, or a regex source when {@link regex} is true. */
  text: string;
  /** Match case (`Order` ≠ `order`) when true. */
  caseSensitive: boolean;
  /** Require word boundaries around the match (`order` does not match inside `reorder`). */
  wholeWord: boolean;
  /** Treat {@link text} as a JavaScript regular-expression source. */
  regex: boolean;
  /**
   * Optional comma-separated glob filter over file uris (`*.koi`, `src/*.koi`, `**​/test/*.koi`).
   * Empty matches every file. `*` matches within a path segment, `**` spans segments.
   */
  include: string;
}

/** One hit within a file. `line` is 1-based; `column` is the 0-based offset within that line. */
export interface Match {
  /** 1-based line number of the match start. */
  line: number;
  /** 0-based character offset of the match start within its line (counts a CRLF's CR). */
  column: number;
  /** Length of the matched text, in UTF-16 code units. */
  length: number;
  /** The full source line containing the match start, with any trailing CR stripped (for the tree). */
  preview: string;
}

/** Every match in one file; only files with at least one hit are emitted. */
export interface FileMatches {
  uri: string;
  matches: Match[];
}

/**
 * The result of a search: the per-file hits, plus a human-readable `error` when the query could not
 * be compiled (an invalid regex). On error `files` is empty and nothing throws, so the panel can show
 * the message inline. (The plan sketches `runSearch(): FileMatches[]`; carrying the regex error out
 * of band needs this thin envelope, which keeps the "no throw, returns an error result" contract.)
 */
export interface SearchOutcome {
  files: FileMatches[];
  error: string | null;
}

/** Escape a literal so it can be embedded in a RegExp source verbatim. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ASCII word characters for the whole-word boundary assertions — mirrors `\b` without needing the
// `u` flag (which would reject otherwise-valid regex sources the user typed).
const WORD = 'A-Za-z0-9_';

/** Build the effective RegExp source for a query (literal-escaped + whole-word wrapped as needed). */
function buildPattern(q: SearchQuery): string {
  const base = q.regex ? q.text : escapeRegExp(q.text);
  if (!q.wholeWord) return base;
  return `(?<![${WORD}])(?:${base})(?![${WORD}])`;
}

type Compiled = { regex: RegExp; error: null } | { regex: null; error: string };

/** Compile a query to a global RegExp, or return its error message (invalid regex source). */
function compile(q: SearchQuery): Compiled {
  // `g` to walk every match, `m` so ^/$ anchor per line, `i` unless case-sensitive.
  const flags = `gm${q.caseSensitive ? '' : 'i'}`;
  try {
    return { regex: new RegExp(buildPattern(q), flags), error: null };
  } catch (e) {
    return { regex: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Offsets at which each line starts (index 0 is the start of line 1). */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** Locate an absolute index → 1-based line, 0-based column, and the (CR-stripped) line preview. */
function locate(text: string, starts: number[], idx: number): { line: number; column: number; preview: string } {
  // Greatest line start ≤ idx, via binary search.
  let lo = 0;
  let hi = starts.length - 1;
  let k = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= idx) {
      k = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const lineStart = starts[k];
  // The line spans up to the next line start (drop its trailing '\n'), or to EOF for the last line.
  const lineEnd = k + 1 < starts.length ? starts[k + 1] - 1 : text.length;
  let preview = text.slice(lineStart, lineEnd);
  if (preview.endsWith('\r')) preview = preview.slice(0, -1);
  return { line: k + 1, column: idx - lineStart, preview };
}

/** Translate a glob (`*`, `**`, `?`) into an anchored RegExp matched against a file uri. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?'; // `**/` = any number of leading directories
        } else {
          re += '.*'; // bare `**` = anything, slashes included
        }
      } else {
        re += '[^/]*'; // `*` = anything within a single path segment
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
    }
  }
  // Anchor on a segment boundary so `*.koi` matches `…/x.koi` and `src/*.koi` matches `…/src/x.koi`.
  return new RegExp('(?:^|/)' + re + '$');
}

/** Parse the comma-separated include field into globs (empty entries dropped). */
function parseIncludes(include: string): RegExp[] {
  return include
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(globToRegExp);
}

/** Whether `uri` passes the include filter (always true when no globs were given). */
function included(uri: string, globs: RegExp[]): boolean {
  return globs.length === 0 || globs.some((g) => g.test(uri));
}

/**
 * Whether `uri` passes a comma-separated include glob (`*.koi`, `src/*.koi`, …); an empty/whitespace
 * filter matches every file. The single-uri convenience over the same glob engine `runSearch` uses,
 * exported so the workspace file enumerator can filter without re-implementing glob matching.
 */
export function matchesInclude(uri: string, include: string): boolean {
  return included(uri, parseIncludes(include));
}

/** All matches of `regex` in `text`, with their line/column/preview resolved. */
function findMatches(text: string, regex: RegExp): Match[] {
  const starts = lineStartOffsets(text);
  const out: Match[] = [];
  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    const loc = locate(text, starts, m.index);
    out.push({ line: loc.line, column: loc.column, length: m[0].length, preview: loc.preview });
    if (m[0].length === 0) regex.lastIndex++; // a zero-width match would otherwise loop forever
  }
  return out;
}

/**
 * Search every file for the query. Returns per-file matches (only files with hits), or an error
 * envelope when the query is an invalid regex. An empty `text` matches nothing (not an error).
 */
export function runSearch(files: { uri: string; text: string }[], q: SearchQuery): SearchOutcome {
  if (q.text === '') return { files: [], error: null };
  const compiled = compile(q);
  if (compiled.error !== null) return { files: [], error: compiled.error };
  const globs = parseIncludes(q.include);
  const result: FileMatches[] = [];
  for (const file of files) {
    if (!included(file.uri, globs)) continue;
    const matches = findMatches(file.text, compiled.regex);
    if (matches.length > 0) result.push({ uri: file.uri, matches });
  }
  return { files: result, error: null };
}

/** One file to consider for replacement. Its live `bufferText` (if open) wins over `diskText`. */
export interface ReplaceTarget {
  uri: string;
  /** The file's live buffer text when it is OPEN (unsaved edits included). */
  bufferText?: string;
  /** The file's on-disk text, used only when the file is closed (`bufferText` undefined). */
  diskText?: string;
}

/** A planned replacement for one file. `open` tells the caller how to route the new text. */
export interface PlannedReplace {
  uri: string;
  /** True when the source was the live buffer (route through the buffer/dirty pipeline, undoable);
   *  false when it was on-disk text (write back through the host fs). */
  open: boolean;
  /** The file's text after the replacement. */
  text: string;
  /** How many matches were replaced (always > 0 — unchanged files are omitted). */
  count: number;
}

/**
 * Plan the replacements for a set of files without performing any I/O. For each target it picks the
 * current source (live buffer text when open, on-disk text when closed), applies the query's
 * replacement, and reports the resulting text, the match count, and whether it routes through the
 * buffer pipeline (`open`) or a disk write. Files whose text is unchanged are dropped, so the caller
 * never marks a buffer dirty or writes a file for a no-op. Pure — the caller does the actual edits.
 */
export function planReplacements(targets: ReplaceTarget[], q: SearchQuery, replacement: string): PlannedReplace[] {
  const out: PlannedReplace[] = [];
  for (const target of targets) {
    const open = target.bufferText !== undefined;
    const source = (open ? target.bufferText : target.diskText) ?? '';
    const text = applyReplace(source, q, replacement);
    if (text === source) continue; // no match / invalid regex / empty query — nothing to route
    const count = runSearch([{ uri: target.uri, text: source }], q).files[0]?.matches.length ?? 0;
    out.push({ uri: target.uri, open, text, count });
  }
  return out;
}

/** Expand `$&` / `$1`…`$99` / `$$` against a match — only in regex mode; literal mode inserts verbatim. */
function expandReplacement(replacement: string, m: RegExpExecArray, q: SearchQuery): string {
  if (!q.regex) return replacement;
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (_, token: string) => {
    if (token === '$') return '$';
    if (token === '&') return m[0];
    const group = m[Number(token)];
    return group ?? '';
  });
}

/**
 * Replace every match of the query in `text` with `replacement`. Edits are spliced in right-to-left
 * so each splice leaves earlier offsets valid. A literal replacement is inserted verbatim ($1 stays
 * `$1`); in regex mode `$&`/`$1`… are expanded. An invalid regex or empty query returns `text` as-is.
 * Line endings are preserved because only the matched spans are touched.
 */
export function applyReplace(text: string, q: SearchQuery, replacement: string): string {
  if (q.text === '') return text;
  const compiled = compile(q);
  if (compiled.error !== null) return text;
  const regex = compiled.regex;
  regex.lastIndex = 0;
  const edits: { from: number; to: number; insert: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    edits.push({ from: m.index, to: m.index + m[0].length, insert: expandReplacement(replacement, m, q) });
    if (m[0].length === 0) regex.lastIndex++;
  }
  let out = text;
  for (let i = edits.length - 1; i >= 0; i--) {
    out = out.slice(0, edits[i].from) + edits[i].insert + out.slice(edits[i].to);
  }
  return out;
}
