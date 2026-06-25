import { describe, expect, test, vi } from 'vitest';
import {
  chooseMechanism,
  isGrammarCapable,
  parseValidationOutcome,
  repairToValid,
  type RepairDeps,
} from '@/ai/grammarConstraint';

describe('isGrammarCapable()', () => {
  test('local OpenAI-compatible endpoints accept a grammar field (capable)', () => {
    // Ollama and LM Studio expose an OpenAI-compatible API on loopback and honour a grammar field.
    expect(isGrammarCapable('openai', 'http://localhost:11434/v1')).toBe(true);
    expect(isGrammarCapable('openai', 'http://localhost:1234/v1')).toBe(true);
    expect(isGrammarCapable('openai', 'http://127.0.0.1:11434/v1')).toBe(true);
    expect(isGrammarCapable('openai', 'http://[::1]:1234/v1')).toBe(true);
  });

  test('Anthropic is never grammar-capable (no decode-time token masking)', () => {
    expect(isGrammarCapable('anthropic', 'http://localhost:11434/v1')).toBe(false);
    expect(isGrammarCapable('anthropic', 'https://api.anthropic.com')).toBe(false);
  });

  test('hosted OpenAI proper is not grammar-capable', () => {
    expect(isGrammarCapable('openai', 'https://api.openai.com/v1')).toBe(false);
  });

  test('is robust to look-alike hosts (no naive substring matching)', () => {
    // A spoof host that merely CONTAINS "localhost" must not be treated as a local server.
    expect(isGrammarCapable('openai', 'https://api.openai.com.localhost/v1')).toBe(false);
    // …and one that contains "api.openai.com" but is genuinely loopback stays capable.
    expect(isGrammarCapable('openai', 'http://127.0.0.1:8080/v1')).toBe(true);
    // Garbage / non-URL input is treated as not capable rather than throwing.
    expect(isGrammarCapable('openai', 'not a url')).toBe(false);
    expect(isGrammarCapable('openai', '')).toBe(false);
  });
});

describe('chooseMechanism()', () => {
  test('off whenever the toggle is off, regardless of provider/url/availability', () => {
    expect(chooseMechanism(false, 'openai', 'http://localhost:1234/v1', true)).toBe('off');
    expect(chooseMechanism(false, 'anthropic', 'https://api.anthropic.com', false)).toBe('off');
  });

  test('gbnf only when on AND grammar-capable AND the GBNF is actually available', () => {
    // Capable local backend with the grammar in hand → constrain decoding.
    expect(chooseMechanism(true, 'openai', 'http://localhost:1234/v1', true)).toBe('gbnf');
    // Capable, but the GBNF couldn't be fetched (e.g. desktop host has no accessor) → repair fallback.
    expect(chooseMechanism(true, 'openai', 'http://localhost:1234/v1', false)).toBe('repair');
  });

  test('repair when on but the backend cannot be token-masked', () => {
    // Anthropic is never capable; OpenAI proper ignores a grammar field — both repair.
    expect(chooseMechanism(true, 'anthropic', 'https://api.anthropic.com', true)).toBe('repair');
    expect(chooseMechanism(true, 'openai', 'https://api.openai.com/v1', true)).toBe('repair');
  });
});

describe('parseValidationOutcome()', () => {
  test('an ok:true validate string parses to a clean outcome carrying the whole text', () => {
    const s = 'ok: true — no diagnostics. The model compiles.';
    expect(parseValidationOutcome(s)).toEqual({ ok: true, diagnostics: s });
  });

  test('an ok:false validate string parses to a dirty outcome keeping the line:column detail', () => {
    const s = 'ok: false — 1 error(s), 0 warning(s):\n- [error] 1:1 boom';
    expect(parseValidationOutcome(s)).toEqual({ ok: false, diagnostics: s });
  });

  test('tolerates leading whitespace before the ok: prefix', () => {
    expect(parseValidationOutcome('  ok: true — fine').ok).toBe(true);
    expect(parseValidationOutcome('\nok: false — nope').ok).toBe(false);
  });
});

describe('repairToValid()', () => {
  const clean = { ok: true, diagnostics: 'ok: true — no diagnostics. The model compiles.' };
  const dirty = (n: number) => ({
    ok: false,
    diagnostics: `ok: false — ${n} error(s), 0 warning(s):\n- [error] 1:1 boom`,
  });

  test('returns ok:true with rounds:0 and never regenerates when the candidate is already valid', async () => {
    const validate = vi.fn().mockResolvedValue(clean);
    const regenerate = vi.fn();
    const deps: RepairDeps = { validate, regenerate };

    const result = await repairToValid('context C {}', deps, 3);

    expect(result).toEqual({ source: 'context C {}', ok: true, rounds: 0 });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(regenerate).not.toHaveBeenCalled();
  });

  test('gives up after exactly maxRounds regenerate attempts when never valid', async () => {
    const validate = vi.fn().mockResolvedValue(dirty(1));
    const regenerate = vi.fn().mockImplementation((prev: string) => Promise.resolve(prev + '!'));
    const deps: RepairDeps = { validate, regenerate };

    const result = await repairToValid('bad', deps, 3);

    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(3);
    expect(result.source).toBe('bad!!!'); // last regenerated candidate
    expect(regenerate).toHaveBeenCalledTimes(3);
    expect(validate).toHaveBeenCalledTimes(4); // initial + one per round
  });

  test('feeds the line:column diagnostics back into regenerate each round', async () => {
    const validate = vi.fn().mockResolvedValue(dirty(2));
    const regenerate = vi.fn().mockResolvedValue('still bad');
    const deps: RepairDeps = { validate, regenerate };

    await repairToValid('seed', deps, 1);

    expect(regenerate).toHaveBeenCalledWith('seed', dirty(2).diagnostics);
  });

  test('succeeds on a later round and reports the round it converged on', async () => {
    // invalid, invalid, then clean on the 2nd regenerate.
    const validate = vi
      .fn()
      .mockResolvedValueOnce(dirty(1))
      .mockResolvedValueOnce(dirty(1))
      .mockResolvedValueOnce(clean);
    const regenerate = vi
      .fn()
      .mockResolvedValueOnce('try1')
      .mockResolvedValueOnce('fixed');
    const deps: RepairDeps = { validate, regenerate };

    const result = await repairToValid('seed', deps, 5);

    expect(result).toEqual({ source: 'fixed', ok: true, rounds: 2 });
    expect(regenerate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(3);
  });

  test('maxRounds <= 0 validates once and never repairs', async () => {
    const validate = vi.fn().mockResolvedValue(dirty(1));
    const regenerate = vi.fn();
    const deps: RepairDeps = { validate, regenerate };

    const result = await repairToValid('bad', deps, 0);

    expect(result).toEqual({ source: 'bad', ok: false, rounds: 0 });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(regenerate).not.toHaveBeenCalled();
  });
});
