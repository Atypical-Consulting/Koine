// Provider-agnostic constraint driver for the AI copilot (issue #257, Task 4).
//
// Two strategies make the assistant's `.koi` output valid-by-construction, picked by backend
// capability:
//   • Grammar-capable backends (local llama.cpp-style servers behind an OpenAI-compatible endpoint —
//     Ollama / LM Studio) accept a GBNF grammar field, so the decoder can only emit valid tokens.
//     {@link isGrammarCapable} is the config-driven check Task 5 uses to decide whether to attach it.
//   • Hosted APIs without a decode-time hook (Anthropic; OpenAI proper) can't be token-masked, so we
//     fall back to bounded parse-and-repair against the real Koine parser — {@link repairToValid}.
//
// Both are pure / dependency-injected so they unit-test without a live LLM or the WASM compiler. The
// `provider`/`baseUrl` inputs mirror Settings (`src/settings/persistence.ts`).

/** Which AI backend the assistant talks to — mirrors `Settings.aiProvider`. */
export type AiProvider = 'anthropic' | 'openai';

/** The hostname OpenAI proper is served from; an OpenAI-compatible endpoint here is the hosted API
 *  (no grammar field), not a local server. */
const OPENAI_PROPER_HOST = 'api.openai.com';

/**
 * True when a host is a loopback address — the only family we treat as a local, grammar-capable
 * server. Matched by EXACT label / IP, never by substring, so a spoof like `api.openai.com.localhost`
 * (whose hostname merely ends in `localhost`) is rejected.
 */
function isLoopbackHost(host: string): boolean {
  // `URL.hostname` keeps IPv6 in brackets (`[::1]`); strip them before comparing.
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  // Anything in 127.0.0.0/8 is loopback (127.0.0.1 is just the canonical one).
  return /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h);
}

/**
 * Decide — from config alone, NOT by probing the endpoint — whether the configured backend can be
 * handed a GBNF grammar to constrain decoding.
 *
 * Capable iff the provider is the OpenAI-compatible one AND the base URL points at a local (loopback)
 * server. Anthropic has no decode-time masking, and OpenAI proper (`api.openai.com`) ignores a grammar
 * field, so both are not capable. A malformed base URL is treated as not capable rather than throwing.
 */
export function isGrammarCapable(provider: AiProvider, baseUrl: string): boolean {
  if (provider !== 'openai') return false;

  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }

  // Explicit deny for OpenAI proper (a loopback check alone would already exclude it, but spelling it
  // out documents intent and guards against an accidental future allow-by-suffix rule).
  if (host.toLowerCase() === OPENAI_PROPER_HOST) return false;

  return isLoopbackHost(host);
}

/** Outcome of one validation pass — the `ok` flag plus the human-readable `line:column` diagnostics
 *  text. Task 5 adapts `runWasmTool('koine_validate', …)` (a formatted string starting `ok: true` /
 *  `ok: false — …`) into this shape. */
export interface ValidationOutcome {
  ok: boolean;
  /** The formatted diagnostics (e.g. `- [error] 1:1 message` lines); fed back into `regenerate`. */
  diagnostics: string;
}

/**
 * The injected collaborators {@link repairToValid} drives. NOTE — this deviates from issue #257's
 * 3-arg `repairToValid(candidate, validate, maxRounds)` sketch: a driver holding only `validate` can
 * detect invalidity but cannot PRODUCE a fix, so we inject a `regenerate` callback too (Task 5 wires it
 * to a re-prompt of the model carrying the diagnostics). Keeping both injected leaves the driver pure
 * and unit-testable without a live LLM or WASM.
 */
export interface RepairDeps {
  /** Validate `.koi` source (Task 5: the WASM `koine_validate` tool). */
  validate: (source: string) => Promise<ValidationOutcome>;
  /** Produce a fresh candidate from the previous one plus the diagnostics that rejected it
   *  (Task 5: re-prompt the model with the errors). */
  regenerate: (previous: string, diagnostics: string) => Promise<string>;
}

/** The result of a repair attempt. `{ source, ok }` is the contract the plan requires; `rounds` is the
 *  repair-attempt count (0 when the first candidate was already valid) for the Task 5 repair-counter UI. */
export interface RepairResult {
  source: string;
  ok: boolean;
  rounds: number;
}

/**
 * Bounded parse-and-repair: validate `candidate`, and while it's invalid, re-`regenerate` from the last
 * diagnostics up to `maxRounds` times, validating each new candidate.
 *
 * Returns as soon as a candidate validates clean (`rounds` is the number of regenerations it took, 0 if
 * the first candidate was already valid). After `maxRounds` exhausted, returns the last candidate with
 * `ok:false`. `maxRounds <= 0` validates once and never repairs.
 */
export async function repairToValid(
  candidate: string,
  deps: RepairDeps,
  maxRounds: number,
): Promise<RepairResult> {
  let current = candidate;
  let outcome = await deps.validate(current);
  if (outcome.ok) return { source: current, ok: true, rounds: 0 };

  const rounds = Math.max(0, Math.floor(maxRounds));
  for (let round = 1; round <= rounds; round++) {
    current = await deps.regenerate(current, outcome.diagnostics);
    outcome = await deps.validate(current);
    if (outcome.ok) return { source: current, ok: true, rounds: round };
  }

  return { source: current, ok: false, rounds };
}
