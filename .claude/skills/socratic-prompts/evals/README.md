# socratic-prompts — evals

The eval suite that measures whether the `socratic-prompts` skill actually earns its context.
It lived in `~/.claude/skills/socratic-prompts-workspace/` — outside version control, next to
a copy of the skill that no longer exists — so the skill shipped here while its evidence sat
on one disk with nothing tracking it.

## Layout

| Path | What |
|---|---|
| `evals.json` | The three eval definitions: prompt, expected output, attached files, and the per-eval expectation list the grader scores against |
| `files/` | Fixtures the evals attach — `SignupForm.razor` (a Blazor form with real a11y defects) and `checkout.ts` |
| `results-iteration-1/` | The 2026-06-28 run: `benchmark.{md,json}`, `feedback.json`, and the graded transcripts per eval and configuration |

Paths inside `evals.json` (`evals/files/…`) resolve from the skill directory, which is why the
suite sits at `socratic-prompts/evals/` rather than anywhere else.

## The three evals

| # | Slug | Probes |
|--:|---|---|
| 0 | `cli-docs` | No files attached — does the skill still produce four *distinct* doc-facet prompts, name a real framework (Diátaxis, progressive disclosure…), and stop short of writing the docs itself? |
| 1 | `razor-anchor` | A file *is* attached — does it anchor application questions to the component's actual defects (placeholder-as-label, `<div>`-as-button, generic "Error") instead of emitting `[placeholders]`? |
| 2 | `instruction-rewrite` | Turning an instruction-style prompt into theory → framework → application without answering the underlying task |

## Result (iteration 1, 2026-06-28)

| Metric | With skill | Without skill | Delta |
|---|---|---|---|
| Pass rate | 100% ± 0% | 81% ± 20% | **+19 pts** |
| Time | 50.7 s ± 18.0 | 59.5 s ± 17.5 | −8.8 s |
| Tokens | 32 406 ± 1 928 | 28 893 ± 1 180 | +3 514 |

The skill pays about **3.5 k extra tokens** and buys a **19-point pass-rate gain** while running
*faster* — the structure removes flailing rather than adding work.

> ⚠️ **Read the ± with care — the methodology is weaker than the file claims.**
> `benchmark.json` sets `"runs_per_configuration": 3`, but it holds **6 run entries**: 3 evals ×
> 2 configurations × **one** run each. Only `run-1` transcripts exist on disk. So `± 20%` is
> variance *between the three evals*, not run-to-run variance, and nothing here measures the
> latter. Treat +19 points as one observation, not a converged average.
>
> Reproduce with three real repeats before quoting this as settled.
