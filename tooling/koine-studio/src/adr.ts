// Pure ADR (Architecture Decision Record) markdown model (#147). No DOM, no filesystem — just the
// (de)serialization, slug/filename, and template helpers the docs store and panel build on, so they
// unit-test cleanly. ADRs are stored as standalone Markdown under `docs/adr/NNNN-title.md` so they
// travel in git and read fine outside Studio (community-standard, à la Nygard/MADR).
//
// On-disk shape (what renderAdr emits and parseAdr reads back):
//
//   # 3. Use Markdown ADRs
//
//   - Status: accepted
//
//   ## Context
//   …
//   ## Decision
//   …
//   ## Consequences
//   …

/** The lifecycle states an ADR can carry. Drives the status badge in the docs panel. */
export const ADR_STATUSES = ['proposed', 'accepted', 'superseded', 'deprecated', 'rejected'] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];

/** The default status for a freshly authored ADR. */
export const DEFAULT_ADR_STATUS: AdrStatus = 'proposed';

/** One Architecture Decision Record, parsed from (or rendered to) a single Markdown file. */
export interface Adr {
  /** The sequence number (the `NNNN` prefix of the filename / the `# N.` heading); 0 when unknown. */
  number: number;
  title: string;
  status: AdrStatus;
  context: string;
  decision: string;
  consequences: string;
}

/** Normalize an arbitrary status string to a known {@link AdrStatus}, defaulting to `proposed`. */
export function normalizeStatus(raw: string | null | undefined): AdrStatus {
  const v = (raw ?? '').trim().toLowerCase();
  return (ADR_STATUSES as readonly string[]).includes(v) ? (v as AdrStatus) : DEFAULT_ADR_STATUS;
}

/** Render an ADR to its canonical Markdown form (the inverse of {@link parseAdr}). */
export function renderAdr(adr: Adr): string {
  return (
    `# ${adr.number}. ${adr.title}\n\n` +
    `- Status: ${adr.status}\n\n` +
    `## Context\n\n${adr.context.trim()}\n\n` +
    `## Decision\n\n${adr.decision.trim()}\n\n` +
    `## Consequences\n\n${adr.consequences.trim()}\n`
  );
}

/** Extract the trimmed body of a `## {heading}` section: from the heading to the next `## ` (or EOF). */
function section(md: string, heading: string): string {
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const start = md.search(headingRe);
  if (start < 0) return '';
  const afterHeading = md.slice(start).replace(headingRe, '');
  const next = afterHeading.search(/^##\s+/m);
  return (next < 0 ? afterHeading : afterHeading.slice(0, next)).trim();
}

/**
 * Parse a Markdown ADR into an {@link Adr}. Lenient by design (the docs panel renders whatever a
 * workspace happens to hold): a missing heading yields '', an unrecognized status normalizes to
 * `proposed`, and a body with no `# N. Title` heading falls back to the first line as the title.
 */
export function parseAdr(md: string): Adr {
  const text = md.replace(/\r\n/g, '\n');

  // Title heading: `# N. Title` (number optional). Fall back to the first non-blank line.
  const numbered = text.match(/^#\s+(\d+)\.\s*(.*?)\s*$/m);
  let number = 0;
  let title = '';
  if (numbered) {
    number = Number(numbered[1]);
    title = numbered[2].trim();
  } else {
    const heading = text.match(/^#\s+(.*?)\s*$/m);
    title = (heading?.[1] ?? text.split('\n').find((l) => l.trim() !== '') ?? '').trim();
  }

  const statusLine = text.match(/^[-*]\s*status\s*:\s*(.+?)\s*$/im);
  const status = normalizeStatus(statusLine?.[1]);

  return {
    number,
    title,
    status,
    context: section(text, 'Context'),
    decision: section(text, 'Decision'),
    consequences: section(text, 'Consequences'),
  };
}

/** A filesystem-safe slug for an ADR title (lowercase, non-alphanumeric → `-`). Empty → `untitled`. */
export function adrSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'untitled';
}

/** The canonical `NNNN-slug.md` filename for an ADR (number zero-padded to four digits). */
export function adrFilename(number: number, title: string): string {
  return `${String(number).padStart(4, '0')}-${adrSlug(title)}.md`;
}

/** The `NNNN` sequence number encoded in an ADR filename, or null when it has no numeric prefix. */
export function parseAdrNumberFromFilename(name: string): number | null {
  const base = name.split('/').pop() ?? name;
  const m = base.match(/^(\d+)[-.]/);
  return m ? Number(m[1]) : null;
}

/** The next free ADR number: one past the highest numeric prefix among `existing`, else 1. */
export function nextAdrNumber(existing: string[]): number {
  const max = existing.reduce((acc, name) => {
    const n = parseAdrNumberFromFilename(name);
    return n != null && n > acc ? n : acc;
  }, 0);
  return max + 1;
}

/** The filename for the next ADR given the current files and a title (`NNNN-slug.md`). */
export function nextAdrFilename(existing: string[], title = 'untitled'): string {
  return adrFilename(nextAdrNumber(existing), title);
}

/** A starter ADR body for `title` (status `proposed`) with the standard sections filled with prompts. */
export function adrTemplate(title: string, number = 1): string {
  return renderAdr({
    number,
    title,
    status: DEFAULT_ADR_STATUS,
    context: 'What is the issue we are seeing that motivates this decision?',
    decision: 'What is the change we are proposing or doing?',
    consequences: 'What becomes easier or harder because of this change?',
  });
}
