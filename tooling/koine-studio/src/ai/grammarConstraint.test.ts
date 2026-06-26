import { describe, expect, test, vi } from 'vitest';
import {
  chooseMechanism,
  isGrammarCapable,
  parseValidationOutcome,
  repairBudgetFor,
  repairToValid,
  type RepairDeps,
} from '@/ai/grammarConstraint';
import { normalizeMcpValidate } from '@/ai/assistantTools';

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

describe('repairBudgetFor()', () => {
  // The repair-round budget is what makes the gbnf path self-heal (#446): 'gbnf' now gets the SAME
  // budget as 'repair', so a grammar a backend silently ignored (Ollama) falls into parse-and-repair
  // instead of stopping after the single validate — the gbnf path is never strictly worse than repair.
  test("'off' never repairs", () => {
    expect(repairBudgetFor('off', 3)).toBe(0);
  });

  test("'repair' gets the full round budget", () => {
    expect(repairBudgetFor('repair', 3)).toBe(3);
  });

  test("'gbnf' ALSO gets the full budget — a failed validate degrades to parse-and-repair", () => {
    expect(repairBudgetFor('gbnf', 3)).toBe(3);
  });

  test('floors and clamps the round count (never negative, integral)', () => {
    expect(repairBudgetFor('repair', -1)).toBe(0);
    expect(repairBudgetFor('gbnf', 2.9)).toBe(2);
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

  test('a warning-only model parses (zero errors) so it stays applicable — warnings do not block', () => {
    const s = 'ok: false — 0 error(s), 2 warning(s):\n- [warning] 3:5 unused';
    // The gate asks "does it parse?", not "is it warning-free?": 0 errors ⇒ ok.
    expect(parseValidationOutcome(s)).toEqual({ ok: true, diagnostics: s });
  });

  test('a model with errors (any count) does not parse', () => {
    expect(parseValidationOutcome('ok: false — 2 error(s), 1 warning(s):\n- [error] 1:1 x').ok).toBe(false);
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

describe('desktop apply-gate end-to-end (issue #445)', () => {
  // The desktop host's validate seam is parseValidationOutcome ∘ normalizeMcpValidate over the MCP
  // ValidateTool JSON. Before the normalization these tests would fail: the raw `{"ok":true,…}` JSON is
  // not the browser `ok:` string, so parseValidationOutcome read it as not-parsing → spurious repair →
  // Apply disabled. They lock the gate to the browser contract on desktop.
  const VALID_MCP = JSON.stringify({ ok: true, errorCount: 0, warningCount: 0, diagnostics: [] });
  const ERROR_MCP = JSON.stringify({
    ok: false,
    errorCount: 1,
    warningCount: 0,
    diagnostics: [{ severity: 'error', code: 'KOI0201', message: 'unknown type Mony', line: 1, column: 1, endLine: 1, endColumn: 5, file: 'model.koi' }],
  });

  test('a valid-model MCP payload passes the gate on the first try (ok, no repair rounds)', async () => {
    // The desktop validate callback: run koine_validate over the MCP sidecar, normalize, then parse.
    const validate = vi.fn(async (_source: string) => parseValidationOutcome(normalizeMcpValidate(VALID_MCP)));
    const regenerate = vi.fn();

    const result = await repairToValid('context Billing {}', { validate, regenerate }, 3);

    expect(result.ok).toBe(true);
    expect(result.rounds).toBe(0); // valid first try — the bug burned repair rounds here
    expect(regenerate).not.toHaveBeenCalled();
  });

  test('an error MCP payload is classified not-parsing and drives repair', async () => {
    const validate = vi.fn(async (_source: string) => parseValidationOutcome(normalizeMcpValidate(ERROR_MCP)));
    const regenerate = vi.fn().mockResolvedValue('context Billing {}');

    const outcome = parseValidationOutcome(normalizeMcpValidate(ERROR_MCP));
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics).toContain('1 error(s)');
    expect(outcome.diagnostics).toContain('1:1 unknown type Mony');

    const result = await repairToValid('bad', { validate, regenerate }, 2);
    expect(result.ok).toBe(false);
  });

  test('malformed MCP text fails CLOSED — a single bounded failure, never an infinite repair loop', async () => {
    // A non-JSON tool result (e.g. the sidecar-unavailable error string) must not be read as ok…
    const malformed = 'Error: the Koine MCP server is not available.';
    expect(parseValidationOutcome(normalizeMcpValidate(malformed)).ok).toBe(false);

    // …and repair stays bounded by maxRounds rather than spinning forever.
    const validate = vi.fn(async (_source: string) => parseValidationOutcome(normalizeMcpValidate(malformed)));
    const regenerate = vi.fn().mockImplementation((prev: string) => Promise.resolve(prev + '?'));

    const result = await repairToValid('seed', { validate, regenerate }, 2);
    expect(result.ok).toBe(false);
    expect(result.rounds).toBe(2);
    expect(regenerate).toHaveBeenCalledTimes(2);
  });
});
