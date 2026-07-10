# Python demo

A runnable, self-checking demo for Koine's **Python emitter** target (issue #1073) — the polyglot
sibling of [`demo/Pizzeria.Domain`](../Pizzeria.Domain) (which proves the C# emitter end-to-end as
part of its own `dotnet build`) and [`demo/typescript`](../typescript).

## What it proves

1. `templates/starters/ordering` — a single `Ordering` context modeling an `Order` aggregate with
   an `OrderLine` value object and an `OrderStatus` state machine — regenerates cleanly to Python
   with the Koine CLI.
2. The generated package, plus a hand-written driver ([`main.py`](main.py)) that constructs and
   exercises it, type-checks under `mypy --strict` — first the generated package on its own (via
   the `mypy.ini` the emitter ships to users), then the driver against that package.
3. The driver actually **runs** under Python and asserts real values:
   - `OrderLine.subtotal` (a derived `@property`) is correctly computed (`unit_price * quantity`)
     for two different lines;
   - a freshly constructed `Order` defaults to `Draft` and carries both lines;
   - `Order` equality is by **id** (entity identity), not by structural contents — two orders with
     the same id but different lines/status are equal, and two orders with different ids are not;
   - the `Draft`, `Placed`, and `Shipped` `OrderStatus` values are all constructible, mutually
     distinguishable, and route correctly through the generated `OrderStatus.match` exhaustive
     dispatch.

   The driver asserts **values**, never emitted formatting/whitespace, so this demo never churns
   when the emitter's output shape changes — only when its *behavior* does.

## How to run it

```bash
bash demo/python/run.sh
```

`run.sh` is idempotent and callable from anywhere; it always:

1. regenerates `demo/python/generated/` from `templates/starters/ordering` with the Koine CLI;
2. type-checks `generated/` under `mypy --config-file mypy.ini .` (the exact config the emitter
   ships to users);
3. type-checks `main.py` against that package under `mypy --strict`;
4. runs `main.py` under Python, with `generated/` on `PYTHONPATH`.

A clean run prints `Python demo: all assertions passed.` and exits `0`. Any failed assertion (or
type error) exits non-zero with the offending detail on stderr.

### Toolchain requirement

This demo needs a Python 3.11+ interpreter and `mypy` — either on `PATH`, or via the `KOINE_PYTHON`
/ `KOINE_MYPY` environment variable overrides, exactly as the `tests/Koine.Compiler.Tests/Conformance/`
suites honor (mypy itself resolves as a direct `mypy` on `PATH`, or falls back to `<python> -m mypy`).
When neither is available, `run.sh` prints an install notice and exits `3` (the toolchain-absent
sentinel `tests/Koine.Compiler.Tests/DemoBuildTests.cs` maps to a clean, honest xUnit **Skipped**
result locally, and a hard **Failed** under `KOINE_REQUIRE_CONFORMANCE=true` — the flag CI sets, so
a toolchain that silently goes missing in CI reddens the build instead of hiding as a skip). No
`pip install` of the demo itself is required beyond `mypy`: the demo relies only on the stdlib plus
a global Python + mypy, the same way the conformance harness does.

## What this demo does NOT prove

`templates/starters/ordering`'s `states status { Draft -> Placed; Placed -> Shipped; Placed ->
Cancelled }` block has **no paired `command` declarations**. Per Koine's documented semantics (see
[§11.6](../../website/src/content/docs/reference/commands-events-state.md)), *"the block by itself
emits nothing — it is a constraint. Its effect appears wherever a command assigns that field"* — the
runtime transition guard is only generated on a `command`'s assignment of the governed field.
Because this starter template declares no commands, the emitted `Order` dataclass accepts any
`OrderStatus` value directly in its constructor, with no generated mutator and no illegal-transition
guard to exercise.

This is a property of **the template**, not a Python-emitter bug — every other Koine template that
uses a `states` block (`pizzeria`, `library`, `saas-subscription`, `ticketing`) pairs it with
commands, and the same gap applies identically to the C#, TypeScript, PHP, and Rust output for this
same template. This demo therefore constructs `Order` snapshots directly at each lifecycle value
(`Draft`, `Placed`, `Shipped`) to prove the status values themselves are correct and
distinguishable, and does **not** assert that constructing an illegal transition (e.g. `Draft ->
Shipped`) is rejected, because nothing in the emitted code rejects it today.

A human may want to file a follow-up issue to enrich `templates/starters/ordering.koi` with real
`place`/`ship`/`cancel` commands (making its `template.json` "state transitions" teaching claim
literally exercised by a generated guard), which would let this demo — and its TypeScript/PHP/Rust
siblings — assert a genuine illegal-transition rejection.

## Layout

```
demo/python/
  run.sh               generate -> gate -> type-check (generated) -> type-check (driver) -> run -> assert
  main.py              the hand-written driver (see above)
  generated/           git-ignored; regenerated by every run.sh
  .mypy_cache/          git-ignored; mypy's incremental cache
  reference/           one or two committed emitted .py.txt snapshots, for browsing without running the tool
```
