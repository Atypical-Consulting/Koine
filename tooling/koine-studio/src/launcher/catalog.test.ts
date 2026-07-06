import { describe, expect, test } from 'vitest';
import { GROUPS, KIND, MODES, PREFIX_CHARS, parseMode } from '@/launcher/catalog';

// Ported verbatim from design/design_handoff_git_spotlight_logos/koine-launcher.js's `MODES` /
// `PREFIX_CHARS` / `GROUPS` / `KIND`, with one deliberate adaptation (scratchpad/SEAMS.md): the
// prototype keys integration events as "integration", but the real glossary `kind` string is
// "integration-event" — KIND is keyed by the real kind, not the prototype's shorthand.

describe('PREFIX_CHARS', () => {
  test('is the five recognized mode-switch prefixes, in prompt order', () => {
    expect(PREFIX_CHARS).toEqual(['>', '@', '#', '/', ':']);
  });
});

describe('MODES', () => {
  test('"all" is the no-prefix default', () => {
    expect(MODES.all).toEqual({ key: 'all', prefix: '', label: 'All', hint: 'everything' });
  });

  test('each prefix char resolves to its mode, label, hint, and category filter', () => {
    expect(MODES['>']).toEqual({
      key: '>', prefix: '>', label: 'Commands', hint: 'run a command', cats: ['action'],
    });
    expect(MODES['@']).toEqual({
      key: '@', prefix: '@', label: 'Symbols', hint: 'go to a domain symbol', cats: ['symbol'],
    });
    expect(MODES['#']).toEqual({
      key: '#', prefix: '#', label: 'Events', hint: 'find an event', cats: ['event'],
    });
    expect(MODES['/']).toEqual({
      key: '/', prefix: '/', label: 'Files', hint: 'open a file', cats: ['file'],
    });
    expect(MODES[':']).toEqual({
      key: ':', prefix: ':', label: 'Glossary', hint: 'look up a term', cats: ['glossary'],
    });
  });
});

describe('GROUPS', () => {
  test('lists every result category in display order, each with its section label', () => {
    expect(GROUPS).toEqual([
      ['action', 'Commands'],
      ['symbol', 'Domain symbols'],
      ['event', 'Events'],
      ['rule', 'Rules & states'],
      ['file', 'Files'],
      ['glossary', 'Glossary'],
      ['commit', 'Recent commits'],
    ]);
  });
});

describe('KIND', () => {
  test('maps each DDD kind to its 2-letter chip code, human word, and --koi-ddd-<slug> token', () => {
    expect(KIND.aggregate).toEqual({ code: 'AR', word: 'aggregate root', token: '--koi-ddd-aggregate' });
    expect(KIND.entity).toEqual({ code: 'EN', word: 'entity', token: '--koi-ddd-entity' });
    expect(KIND.value).toEqual({ code: 'VO', word: 'value object', token: '--koi-ddd-value' });
    expect(KIND.enum).toEqual({ code: 'EM', word: 'enum', token: '--koi-ddd-enum' });
    expect(KIND.service).toEqual({ code: 'SV', word: 'domain service', token: '--koi-ddd-service' });
    expect(KIND.repository).toEqual({ code: 'RP', word: 'repository', token: '--koi-ddd-repository' });
    expect(KIND.command).toEqual({ code: 'CM', word: 'command', token: '--koi-ddd-command' });
    expect(KIND.query).toEqual({ code: 'QY', word: 'query', token: '--koi-ddd-query' });
    expect(KIND.event).toEqual({ code: 'EV', word: 'domain event', token: '--koi-ddd-event' });
    // The adaptation: real glossary kind is "integration-event", not the prototype's "integration".
    expect(KIND['integration-event']).toEqual({
      code: 'IE', word: 'integration event', token: '--koi-ddd-integration-event',
    });
  });
});

describe('parseMode', () => {
  test.each([
    ['>run', '>', 'run'],
    ['@Order', '@', 'Order'],
    ['#OrderPlaced', '#', 'OrderPlaced'],
    ['/ordering.koi', '/', 'ordering.koi'],
    [':Aggregate', ':', 'Aggregate'],
  ])('strips the %s prefix and resolves its mode', (input, prefixChar, expectedQuery) => {
    const { mode, query } = parseMode(input);
    expect(mode).toBe(MODES[prefixChar]);
    expect(query).toBe(expectedQuery);
  });

  test('trims a single leading space left after stripping the prefix', () => {
    expect(parseMode('> run').query).toBe('run');
  });

  test('with no recognized prefix, resolves to MODES.all and leaves the input untouched', () => {
    const { mode, query } = parseMode('order');
    expect(mode).toBe(MODES.all);
    expect(query).toBe('order');
  });

  test('an empty string resolves to MODES.all with an empty query', () => {
    const { mode, query } = parseMode('');
    expect(mode).toBe(MODES.all);
    expect(query).toBe('');
  });
});
