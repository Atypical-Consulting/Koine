// Pure git line-history parsing for the inspector's "Change history" section (issue #150).
//
// The desktop host shells out to `git log -L <start>,<end>:<file>` over a declaration's source span;
// this module owns the two pure pieces around that call so they unit-test without a git process:
//   • `buildLogLArgs` — forms the exact `git` argument vector (the `-L start,end:file` invocation).
//   • `parseLogL`     — turns the command's stdout into a flat `ChangeEntry[]`, newest first.
//
// To stay robust against arbitrary diff content (`git log -L` interleaves each commit header with the
// patch for the range), the header is emitted with a custom `--format` using ASCII control characters
// as delimiters: a RECORD SEPARATOR (U+001E) starts every commit header line and a UNIT SEPARATOR
// (U+001F) splits its fields. Neither byte appears in source diffs, so the parser can split on them
// and ignore the patch lines entirely.

/** One commit that touched the selected element's line range. */
export interface ChangeEntry {
  /** The full commit SHA. */
  sha: string;
  /** The author name (`%an`). */
  author: string;
  /** The author date as a strict ISO-8601 string (`%aI`); the renderer formats it for display. */
  date: string;
  /** The commit subject line (`%s`). */
  message: string;
}

/** RECORD SEPARATOR — prefixes each commit header line so chunks split cleanly off the diff noise. */
const RS = '\x1e';
/** UNIT SEPARATOR — splits the fields within a commit header line. */
const US = '\x1f';

/**
 * The `--format` passed to `git log`: one control-delimited header line per commit
 * (`<RS>sha<US>author<US>isoDate<US>subject`). Used by {@link buildLogLArgs} and mirrored by the
 * tests, so the format and its parser never drift.
 */
export const LOG_FORMAT = `${RS}%H${US}%an${US}%aI${US}%s`;

/**
 * Build the `git` argument vector that logs the history of lines `startLine..endLine` of `file`
 * (1-based, inclusive — matching git's `-L`). `--no-color` keeps the output plain and `--format`
 * emits the control-delimited header {@link parseLogL} expects.
 */
export function buildLogLArgs(file: string, startLine: number, endLine: number): string[] {
  return ['log', '--no-color', `--format=${LOG_FORMAT}`, '-L', `${startLine},${endLine}:${file}`];
}

/**
 * Parse the stdout of `git log -L … --format=LOG_FORMAT` into a flat {@link ChangeEntry} list, in the
 * order git emits them (newest first). Each commit is one `RS`-delimited chunk; only the chunk's first
 * line (the header) is read — the trailing patch hunks are ignored. Chunks without a SHA are skipped,
 * so empty output (no history / not a git repo's tracked file) yields `[]`.
 */
export function parseLogL(output: string): ChangeEntry[] {
  const entries: ChangeEntry[] = [];
  for (const chunk of output.split(RS)) {
    if (!chunk) continue; // the leading split fragment before the first record, or trailing blank
    const header = chunk.split('\n', 1)[0];
    const fields = header.split(US);
    const sha = fields[0]?.trim();
    if (!sha) continue;
    entries.push({
      sha,
      author: fields[1] ?? '',
      date: fields[2] ?? '',
      // A subject never contains a US, but join the tail defensively rather than dropping anything.
      message: fields.slice(3).join(US),
    });
  }
  return entries;
}
