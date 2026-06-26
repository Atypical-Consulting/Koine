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

import { isLocalProviderUrl } from '@/ai/ai';

// `AiProvider` has ONE definition (in `ai.ts`); re-export it here so callers of this module keep a
// single source of truth and the union can't drift between the two files.
export type { AiProvider } from '@/ai/ai';
import type { AiProvider } from '@/ai/ai';

/**
 * Decide — from config alone, NOT by probing the endpoint — whether the configured backend can be
 * handed a GBNF grammar to constrain decoding.
 *
 * Capable iff the provider is the OpenAI-compatible one AND the base URL points at a local (loopback)
 * server. Anthropic has no decode-time masking, and OpenAI proper (`api.openai.com`) ignores a grammar
 * field, so both are not capable. A malformed base URL is treated as not capable rather than throwing.
 *
 * The loopback test is delegated to {@link isLocalProviderUrl} (the same anchored check `ai.ts` already
 * uses to decide whether an API key is required), so the "is this a local server?" rule lives in ONE
 * place and the two can't drift. Its regex is anchored (`^https?://(localhost|127.0.0.1|[::1])…`), so a
 * spoof like `https://api.openai.com.localhost/v1` — whose host merely ends in `localhost` — is rejected,
 * and garbage / non-URL input simply fails to match (not capable) rather than throwing.
 */
export function isGrammarCapable(provider: AiProvider, baseUrl: string): boolean {
  return provider === 'openai' && isLocalProviderUrl(baseUrl);
}

/** Which constraint strategy a turn should use (see {@link chooseMechanism}). */
export type ConstraintMechanism = 'gbnf' | 'repair' | 'off';

/**
 * Pure decision: given the setting and the active backend, which constraint strategy applies.
 *  • `off`    — the toggle is off → behave exactly as before (no grammar, no gate).
 *  • `gbnf`   — the backend is grammar-capable AND the GBNF is actually available to attach
 *               (the browser WASM host exposes it; the desktop host does not) → constrain decoding.
 *  • `repair` — the toggle is on but the backend can't be token-masked (Anthropic / OpenAI proper),
 *               or the GBNF couldn't be fetched (desktop) → fall back to parse-and-repair.
 */
export function chooseMechanism(
  constrainOn: boolean,
  provider: AiProvider,
  baseUrl: string,
  gbnfAvailable: boolean,
): ConstraintMechanism {
  if (!constrainOn) return 'off';
  if (gbnfAvailable && isGrammarCapable(provider, baseUrl)) return 'gbnf';
  return 'repair';
}

/**
 * How many parse-and-repair rounds a turn may spend, given its mechanism and the configured cap.
 *
 * The `'gbnf'` path gets the SAME budget as `'repair'` (issue #446). A grammar-capable backend usually
 * makes the first candidate valid by construction, so {@link repairToValid} returns on round 0 and no
 * repair happens. But if the backend silently IGNORED the grammar (Ollama's OpenAI-compatible endpoint
 * constrains via its own `format` field and drops a top-level `grammar`), the unconstrained output can
 * fail to parse — and rather than disabling Apply right there (strictly *worse* than parse-and-repair,
 * since the user loses the repair loop they'd otherwise get), the gbnf path degrades into the same
 * bounded repair loop. `'off'` never repairs.
 */
export function repairBudgetFor(mechanism: ConstraintMechanism, maxRounds: number): number {
  if (mechanism === 'off') return 0;
  return Math.max(0, Math.floor(maxRounds));
}

/**
 * Adapt the `koine_validate` tool's formatted result string into a {@link ValidationOutcome}. The tool
 * (see `formatValidate` in assistantTools.ts) returns `ok: true — no diagnostics. …` when the model is
 * clean, or `ok: false — N error(s), M warning(s):\n- [error] L:C …` otherwise. The whole string is
 * kept as `diagnostics` so the `line:column` detail can be fed straight back into a repair re-prompt.
 *
 * The apply-gate asks "does it PARSE?" (#257), so the model is acceptable when it has **zero errors** —
 * a model that parses and compiles but only emits WARNINGS still gets `ok: false` from the tool, yet must
 * be applicable (and must not burn repair rounds "fixing" a non-error). So we read the error count, not
 * the bare `ok:` flag.
 */
export function parseValidationOutcome(result: string): ValidationOutcome {
  const trimmed = result.trimStart();
  if (trimmed.startsWith('ok: true')) return { ok: true, diagnostics: result };
  // `ok: false — N error(s), …` → it parses iff N === 0 (warnings alone don't block Apply).
  const errors = trimmed.match(/(\d+)\s+error\(s\)/);
  return { ok: errors !== null && Number(errors[1]) === 0, diagnostics: result };
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
