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

### 2. `Order::new` has no `status` parameter at all (Rust-specific parity gap)

Unlike the C#, TypeScript, Python, and PHP emitters — which all render `Order`'s default-valued
`status` member as an **optional trailing constructor parameter** defaulting to `Draft` (e.g.
TypeScript's `constructor(id, lines, status = OrderStatus.Draft)`) — the Rust emitter's
`Order::new(id: OrderId, lines: Vec<OrderLine>) -> Result<Self, DomainError>` takes **no `status`
parameter whatsoever**; it unconditionally sets `status = OrderStatus::Draft` inline. Since
`Order`'s fields are private and no setter is generated, there is no way from outside the crate to
construct an `Order` whose `status` is anything but `Draft`.

This means the driver cannot mirror the TypeScript/Python/PHP siblings' "construct a `Placed`
order directly" assertions. It works around the gap by exercising the `OrderStatus` enum's
`Draft`/`Placed`/`Shipped`/`Cancelled` variants as freestanding values (they are public and need no
`Order` to construct), and its entity-identity assertion only varies `lines` between the two
same-id instances, not `status` (which the constructor cannot express) — see
[`reference/README.md`](reference/README.md) for the exact emitted-code comparison across targets.

**This is a real Rust-emitter parity gap worth a follow-up issue** against
`src/Koine.Emit.Rust/RustEmitter.Aggregates.cs` (render the same optional trailing parameter the
other four emitters already do) — not something this demo's driver silently papers over: it is
called out here, in `reference/README.md`, and in the `KNOWN GAPS` doc comment atop `src/main.rs`.
This demo does not touch `src/Koine.Emit.Rust/` itself, per issue #1073's scope (demo + test-harness
only).

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
