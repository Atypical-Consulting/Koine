# auto-dev — token economics (the why)

The actionable rules live in `SKILL.md` (§ Token economics). This file is the rationale +
measurement methodology — read it when tuning cost or explaining a run's economics, not every turn.

## The shape of the spend

A long auto-dev run is expensive in a specific, fixable way. Measured over a 120-merge run:
**~83% of all spend was context *cache* (re-reading each agent's context every turn), only ~16% was
generated output.** In an agentic loop you pay for *context volume × number of turns*, not for
thinking. That single fact drives all three levers.

## Lever 1 — tier the model (≈⅔ of the savings)

Cache-read tokens dominate, and they are ~5× cheaper on a mid model and ~15× cheaper on a small model
than on the top model. Most fleet work is *mechanical* — make one failing test pass, fix a guard,
regenerate a snapshot, edit docs — and doesn't need the top model. The failing-test-first + green-CI
gates in the child skills catch any miss a cheaper model makes, which is what makes cheap-by-default
safe. Reserve the top model for genuine reasoning (cross-cutting/ambiguous work) and for
**escalation**: re-dispatch once on the top model when a lower tier couldn't green it (Step 4).

The orchestrator stays on the top model — its dispatch/conflict reasoning is worth it — but its
*per-turn context* is what it pays to re-read every turn, so keep that small (lever 2).

## Lever 2 — shrink what's re-read every turn

- **No per-issue TaskList.** A task list grows unboundedly and is re-injected on *every* turn — pure
  cache-read waste multiplied by thousands of turns. The state file is the only working memory.
- **Compact deliberately, don't wait for 100% auto-compact.** Both cost and answer quality degrade
  well before the window is full. Compact *with a focus directive* so the summary keeps what's
  expensive to reconstruct. Continuity otherwise lives in the state file — so the first action after
  any compact / `/clear` / `loop` re-fire is to re-read it; that turns a reset into a clean base
  instead of amnesia.
- **Delegate heavy reads to throwaway `Explore` sub-agents.** When you must read widely to find a
  small answer, the sub-agent does the reading and returns only the conclusion, so the file-dump dies
  with it instead of riding in your re-read-every-turn context. (This is also why a symbol-retrieval
  MCP didn't pay off: it adds per-turn schema weight and extra round-trips — the opposite of this.)
- **Strip MCP servers workers don't need.** Every connected MCP server injects its tool schemas into
  *every* turn of *every* session — dead weight re-read thousands of times. `--strict-mcp-config`
  with only the servers actually used (usually none).

## Lever 3 — take fewer turns

Each tool round-trip is a turn, and every turn re-reads the whole context.
- **Batch independent tool calls** into one turn (this is why ripgrep beats per-symbol retrieval:
  many matches per call, fewer round-trips).
- **Let scripts collapse query+classify** — a script turns a multi-turn "query then reason" into one
  call.
- **Cache-TTL nuance:** the prompt cache has a ~5-min TTL, so a wake *past* it pays a full cache
  **write** (1.25× input), not a cheap read (0.1×). A needless short tick is pure cost; a wake after a
  long idle should batch all pending reconcile work to amortize the rewrite.

## Measurement

`scripts/usage_report.py <project-transcript-dir> --main <orchestrator-session-id>` aggregates tokens
+ $-equivalent across the orchestrator and every worker session, broken down by model (so the tiering
payoff is visible). It auto-detects the transcript dir from `$PWD` if not given. Track **tokens/merge**
and **$/merge** across runs so a regression shows up immediately. Dollar figures are API list-price
equivalents — on a subscription they map to rate-limit budget, not cash; the authoritative cash figure
is the built-in `/cost`.
