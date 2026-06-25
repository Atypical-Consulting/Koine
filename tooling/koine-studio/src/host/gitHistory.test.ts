import { describe, expect, test } from 'vitest';
import { buildLogLArgs, parseLogL, LOG_FORMAT, type ChangeEntry } from '@/host/gitHistory';

// The control-delimited header git emits per commit (see LOG_FORMAT): <RS>sha<US>author<US>date<US>subject.
const RS = '\x1e';
const US = '\x1f';
const header = (sha: string, author: string, date: string, subject: string) =>
  `${RS}${sha}${US}${author}${US}${date}${US}${subject}`;

describe('buildLogLArgs', () => {
  test('forms the -L start,end:file invocation with the parser format', () => {
    const args = buildLogLArgs('src/Order.koi', 12, 20);
    expect(args).toEqual(['log', '--no-color', `--format=${LOG_FORMAT}`, '-L', '12,20:src/Order.koi']);
  });

  test('a single-line span uses an equal start and end', () => {
    expect(buildLogLArgs('a.koi', 7, 7)).toContain('7,7:a.koi');
  });
});

describe('parseLogL', () => {
  test('turns git log -L output into ChangeEntry[], newest first, ignoring the diff hunks', () => {
    // Two commits, each followed by a patch hunk for the range — exactly what `git log -L` produces.
    const output =
      header('a1b2c3d', 'Alice Dupont', '2026-06-20T10:30:00+02:00', 'Add the Rule invariant') +
      '\ndiff --git a/Order.koi b/Order.koi\n@@ -12,4 +12,5 @@\n+  rule total > 0\n' +
      header('e4f5g6h', 'Bob', '2026-05-01T09:00:00+00:00', 'Introduce Order aggregate') +
      '\ndiff --git a/Order.koi b/Order.koi\n@@ -0,0 +12,4 @@\n+aggregate Order {\n';

    const entries = parseLogL(output);

    expect(entries).toEqual<ChangeEntry[]>([
      { sha: 'a1b2c3d', author: 'Alice Dupont', date: '2026-06-20T10:30:00+02:00', message: 'Add the Rule invariant' },
      { sha: 'e4f5g6h', author: 'Bob', date: '2026-05-01T09:00:00+00:00', message: 'Introduce Order aggregate' },
    ]);
  });

  test('empty output (no history / untracked file) yields an empty list', () => {
    expect(parseLogL('')).toEqual([]);
    expect(parseLogL('\n')).toEqual([]);
  });

  test('preserves a subject that itself contains a colon or punctuation', () => {
    const output = header('deadbee', 'Carol', '2026-01-02T03:04:05Z', 'fix(studio): tidy the panel');
    expect(parseLogL(output)).toEqual<ChangeEntry[]>([
      { sha: 'deadbee', author: 'Carol', date: '2026-01-02T03:04:05Z', message: 'fix(studio): tidy the panel' },
    ]);
  });
});
