import { describe, it, expect } from 'vitest';
import {
  type Adr,
  ADR_STATUSES,
  adrFilename,
  adrSlug,
  adrTemplate,
  nextAdrNumber,
  nextAdrFilename,
  parseAdr,
  parseAdrNumberFromFilename,
  renderAdr,
} from './adr';

function sampleAdr(): Adr {
  return {
    number: 3,
    title: 'Use Markdown ADRs',
    status: 'accepted',
    context: 'The Glossary captures what words mean; nothing captures why the model is shaped this way.',
    decision: 'Store ADRs as Markdown files under docs/adr so they travel in git.',
    consequences: 'Portable and tool-agnostic.\n\nBrowser/no-folder mode needs a read-only state.',
  };
}

describe('renderAdr / parseAdr round-trip', () => {
  it('recovers every field through render → parse', () => {
    const adr = sampleAdr();
    const back = parseAdr(renderAdr(adr));
    expect(back).toEqual(adr);
  });

  it('renders the standard ADR sections in order', () => {
    const md = renderAdr(sampleAdr());
    expect(md).toContain('# 3. Use Markdown ADRs');
    expect(md).toContain('- Status: accepted');
    const ctx = md.indexOf('## Context');
    const dec = md.indexOf('## Decision');
    const con = md.indexOf('## Consequences');
    expect(ctx).toBeGreaterThan(-1);
    expect(dec).toBeGreaterThan(ctx);
    expect(con).toBeGreaterThan(dec);
  });
});

describe('parseAdr leniency', () => {
  it('tolerates blank-line noise, status casing, and a bare title', () => {
    const md = [
      '# 7.   Adopt event sourcing  ',
      '',
      '* status :  Accepted ',
      '',
      '## Context',
      '',
      'Some context.',
      '',
      '',
      '## Decision',
      '',
      'Do it.',
      '',
      '## Consequences',
      '',
      'Trade-offs.',
      '',
    ].join('\n');
    const adr = parseAdr(md);
    expect(adr.number).toBe(7);
    expect(adr.title).toBe('Adopt event sourcing');
    expect(adr.status).toBe('accepted');
    expect(adr.context).toBe('Some context.');
    expect(adr.decision).toBe('Do it.');
    expect(adr.consequences).toBe('Trade-offs.');
  });

  it('falls back gracefully on a malformed ADR rather than throwing', () => {
    const adr = parseAdr('just some prose with no headings at all');
    expect(adr.number).toBe(0);
    expect(adr.title).toBe('just some prose with no headings at all');
    expect(ADR_STATUSES).toContain(adr.status);
    expect(adr.context).toBe('');
  });

  it('normalizes an unknown status to proposed', () => {
    const adr = parseAdr('# 1. T\n\n- Status: whatever\n\n## Context\n\nc\n');
    expect(adr.status).toBe('proposed');
  });

  it('does NOT truncate a section body at an embedded "## " sub-heading or code fence', () => {
    const md = [
      '# 1. Title',
      '',
      '- Status: accepted',
      '',
      '## Context',
      '',
      'Intro paragraph.',
      '',
      '### A subsection',
      '',
      '```md',
      '## a heading inside a code fence',
      '```',
      '',
      'Trailing paragraph.',
      '',
      '## Decision',
      '',
      'The decision.',
      '',
      '## Consequences',
      '',
      'The consequences.',
      '',
    ].join('\n');
    const adr = parseAdr(md);
    // The whole Context body survives — the embedded fenced "## a heading…" no longer cuts it short.
    expect(adr.context).toContain('Intro paragraph.');
    expect(adr.context).toContain('## a heading inside a code fence');
    expect(adr.context).toContain('Trailing paragraph.');
    // Decision/Consequences still split correctly on the real section headings.
    expect(adr.decision).toBe('The decision.');
    expect(adr.consequences).toBe('The consequences.');
  });
});

describe('slug / filename helpers', () => {
  it('slugifies a title', () => {
    expect(adrSlug('Use Markdown ADRs!')).toBe('use-markdown-adrs');
    expect(adrSlug('  Café & Crème  ')).toBe('caf-cr-me');
    expect(adrSlug('')).toBe('untitled');
  });

  it('zero-pads the number to four digits in the filename', () => {
    expect(adrFilename(3, 'Use Markdown ADRs')).toBe('0003-use-markdown-adrs.md');
    expect(adrFilename(42, 'X')).toBe('0042-x.md');
  });

  it('parses the number prefix from a filename', () => {
    expect(parseAdrNumberFromFilename('0003-use-markdown-adrs.md')).toBe(3);
    expect(parseAdrNumberFromFilename('12-no-pad.md')).toBe(12);
    expect(parseAdrNumberFromFilename('readme.md')).toBeNull();
    expect(parseAdrNumberFromFilename('notes/0001-x.md')).toBe(1);
  });
});

describe('nextAdrNumber / nextAdrFilename', () => {
  it('starts at 1 when there are no ADRs', () => {
    expect(nextAdrNumber([])).toBe(1);
    expect(nextAdrFilename([], 'First Decision')).toBe('0001-first-decision.md');
  });

  it('increments past the highest existing NNNN (non-contiguous, ignoring non-ADR files)', () => {
    const existing = ['0001-a.md', '0003-b.md', 'readme.md', 'index.md'];
    expect(nextAdrNumber(existing)).toBe(4);
    expect(nextAdrFilename(existing, 'Third One')).toBe('0004-third-one.md');
  });
});

describe('adrTemplate', () => {
  it('produces a proposed ADR with the standard sections and the title', () => {
    const md = adrTemplate('Adopt CQRS', 5);
    expect(md).toContain('# 5. Adopt CQRS');
    expect(md).toContain('- Status: proposed');
    expect(md).toContain('## Context');
    expect(md).toContain('## Decision');
    expect(md).toContain('## Consequences');
    // The template is itself a valid ADR.
    const adr = parseAdr(md);
    expect(adr.number).toBe(5);
    expect(adr.title).toBe('Adopt CQRS');
    expect(adr.status).toBe('proposed');
  });

  it('defaults the number to 1 when omitted', () => {
    expect(adrTemplate('First')).toContain('# 1. First');
  });
});
