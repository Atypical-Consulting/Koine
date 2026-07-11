# Rust demo

A runnable, self-checking demo for Koine's **Rust emitter** target (issue #1073) — the polyglot
sibling of [`demo/Pizzeria.Domain`](../Pizzeria.Domain) (which proves the C# emitter end-to-end as
part of its own `dotnet build`), [`demo/typescript`](../typescript), [`demo/python`](../python), and
[`demo/php`](../php).

## What it proves

1. `templates/starters/ordering` — a single `Ordering` context modeling an `Order` aggregate with
   an `OrderLine` value object and an `OrderStatus` state machine — regenerates cleanly to Rust as a
   `koine-domain` crate with the Koine CLI.
2. The generated crate, plus a hand-written driver ([`src/main.rs`](src/main.rs)) that constructs
   and exercises it, **compiles** under `cargo run` — cargo's own compile step is a real, strict
   type-check for this target (there is no separate lint pass the way `tsc`/`mypy`/`phpstan`
   provide for the TypeScript/Python/PHP demos: a Rust program that type-checks IS a Rust program
   that compiled).
3. The driver actually **runs** and asserts real values:
   - `OrderLine::subtotal()` (a derived method) is correctly computed (`unit_price *
     Decimal::from(quantity)`) for two different lines;
   - a freshly constructed `Order` defaults to `Draft` and carries both lines;
   - overriding the trailing `status` parameter constructs a `Placed` `Order` directly;
   - `Order` equality is by **id** (entity identity), not by structural contents — two orders with
     the same id but different `lines` are equal, and two orders with different ids are not;
   - the `Draft`/`Placed`/`Shipped`/`Cancelled` `OrderStatus` enum variants are all constructible,
     mutually distinguishable, round-trip through `OrderStatus::from_name`/`from_value`, and route
     correctly through the generated `OrderStatus::match_()` exhaustive dispatch.

   The driver asserts **values**, never emitted formatting/whitespace, so this demo never churns
   when the emitter's output shape changes — only when its *behavior* does.

## How to run it

```bash
bash demo/rust/run.sh
```

`run.sh` is idempotent and callable from anywhere; it always:

1. regenerates `demo/rust/generated/` (the `koine-domain` crate) from
   `templates/starters/ordering` with the Koine CLI;
2. builds and runs [`src/main.rs`](src/main.rs) under `cargo run`, which depends on that crate via
   a `path` dependency declared in [`Cargo.toml`](Cargo.toml).

A clean run prints `OK: Rust demo generated, compiled, and asserted successfully.` and exits `0`.
Any failed assertion (or compile error) exits non-zero with the offending detail on stderr.

### Toolchain requirement

This demo needs `cargo` — either on `PATH`, or via the `KOINE_CARGO` environment variable override,
exactly as `tests/Koine.Compiler.Tests/Conformance/RustConformanceTests.cs` honors. When it is not
available, `run.sh` prints an install notice and exits `3` (the toolchain-absent sentinel
`tests/Koine.Compiler.Tests/DemoBuildTests.cs` maps to a clean, honest xUnit **Skipped** result
locally, and a hard **Failed** under `KOINE_REQUIRE_CONFORMANCE=true` — the flag CI sets, so a
toolchain that silently goes missing in CI reddens the build instead of hiding as a skip). The first
`cargo run` fetches `rust_decimal` and `regex` (the two dependencies `koine_runtime` needs) from
crates.io if they aren't already cached locally; CI has network access, so this is not a hidden
requirement there.

## What this demo does NOT prove

### 1. No runtime state-transition guard

`templates/starters/ordering`'s `states status { Draft -> Placed; Placed -> Shipped; Placed ->
Cancelled }` block has **no paired `command` declarations**. Per Koine's documented semantics (see
[§11.6](../../website/src/content/docs/reference/commands-events-state.md)), *"the block by itself
emits nothing — it is a constraint. Its effect appears wherever a command assigns that field"* — the
runtime transition guard is only generated on a `command`'s assignment of the governed field.
Because this starter template declares no commands, the emitted `Order` has no generated mutator
and no illegal-transition guard to exercise.

This is a property of **the template**, not a Rust-emitter bug — every other Koine template that
uses a `states` block (`pizzeria`, `library`, `saas-subscription`, `ticketing`) pairs it with
commands, and the same gap applies identically to the C#, TypeScript, Python, and PHP output for
this same template. A human may want to file a follow-up issue to enrich
`templates/starters/ordering.koi` with real `place`/`ship`/`cancel` commands (making its
`template.json` "state transitions" teaching claim literally exercised by a generated guard), which
would let this demo — and its TypeScript/Python/PHP siblings — assert a genuine illegal-transition
rejection.

> This section previously also listed a Rust-specific parity gap: `Order::new` rendered no trailing
> `status` parameter at all, unlike the C#/TypeScript/Python/PHP emitters. That gap is fixed (#1380)
> — `Order::new`'s generated signature now takes a trailing `status: Option<OrderStatus>` that
> defaults to `Draft` when omitted, matching the other four emitters' shape, and this driver now
> constructs a `Placed` `Order` directly (see `src/main.rs`) the same way its TypeScript/Python/PHP
> siblings do.

## Layout

```
demo/rust/
  run.sh                generate -> gate -> cargo run (compile IS the type-check) -> assert
  Cargo.toml             the demo's own binary crate; depends on generated/ via a path dependency
  src/main.rs             the hand-written driver (see above)
  generated/             git-ignored; regenerated by every run.sh (the koine-domain crate)
  target/                 git-ignored; cargo's build output
  reference/              one committed emitted .rs.txt snapshot, for browsing without running the tool
```
