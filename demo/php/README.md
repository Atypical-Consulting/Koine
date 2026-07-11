# PHP demo

A runnable, self-checking demo for Koine's **PHP emitter** target (issue #1073) — the polyglot
sibling of [`demo/Pizzeria.Domain`](../Pizzeria.Domain) (which proves the C# emitter end-to-end as
part of its own `dotnet build`), [`demo/typescript`](../typescript), and [`demo/python`](../python).

## What it proves

1. `templates/starters/ordering` — a single `Ordering` context modeling an `Order` aggregate with
   an `OrderLine` value object and an `OrderStatus` state machine — regenerates cleanly to PHP with
   the Koine CLI.
2. Every emitted `.php` file, plus a hand-written driver ([`main.php`](main.php)) that constructs
   and exercises the generated package, parses cleanly under `php -l` (an always-on syntax gate).
3. The generated package plus the driver type-check under `phpstan analyse --level max` — the same
   strict-type bar `tests/Koine.Compiler.Tests/Conformance/PhpConformanceTests.cs` already holds the
   PHP backend to.
4. The driver actually **runs** under PHP and asserts real values:
   - `OrderLine::subtotal()` (a derived method) is correctly computed (`unitPrice * quantity`) for
     two different lines;
   - a freshly constructed `Order` defaults to `Draft` and carries both lines;
   - `Order` equality is by **id** (entity identity), not by structural contents — two orders built
     from distinct `OrderId` objects wrapping the *same* underlying value are equal regardless of
     differing lines/status, and two orders built from `OrderId`s wrapping different values are not;
   - the `Draft`, `Placed`, and `Shipped` `OrderStatus` enum cases are all constructible, mutually
     distinguishable, and route correctly through the generated `OrderStatus::match_()` exhaustive
     dispatch.

   The driver asserts **values**, never emitted formatting/whitespace, so this demo never churns
   when the emitter's output shape changes — only when its *behavior* does.

## How to run it

```bash
bash demo/php/run.sh
```

`run.sh` is idempotent and callable from anywhere; it always:

1. regenerates `demo/php/generated/` from `templates/starters/ordering` with the Koine CLI;
2. runs `php -l` over every emitted `.php` file plus `main.php`;
3. type-checks `generated/` and `main.php` together under `phpstan analyse --level max`;
4. runs `main.php` under PHP (no Composer autoloading — the driver `require_once`s the generated
   classes directly, in dependency order, the same way
   `tests/Koine.Compiler.Tests/Conformance/PhpConformanceTests.cs` exercises emitted files: written
   to disk and analyzed/run as-is, with no autoloader).

A clean run prints `OK: PHP demo generated, syntax-checked, type-checked, and asserted
successfully.` and exits `0`. Any failed assertion (or syntax/type error) exits non-zero with the
offending detail on stderr.

### Toolchain requirement

This demo needs a PHP 8.1+ interpreter and `phpstan` — either on `PATH`, or via the `KOINE_PHP` /
`KOINE_PHPSTAN` environment variable overrides, exactly as the
`tests/Koine.Compiler.Tests/Conformance/` suites honor (`phpstan` itself resolves as a direct
`phpstan` on `PATH`, or falls back to `<repo root>/vendor/bin/phpstan`). When neither is available,
`run.sh` prints an install notice and exits `3` (the toolchain-absent sentinel
`tests/Koine.Compiler.Tests/DemoBuildTests.cs` maps to a clean, honest xUnit **Skipped** result
locally, and a hard **Failed** under `KOINE_REQUIRE_CONFORMANCE=true` — the flag CI sets, so a
toolchain that silently goes missing in CI reddens the build instead of hiding as a skip). No
`composer install` of the demo itself is required: the demo relies only on a global PHP + phpstan,
the same way the conformance harness does; [`composer.json`](composer.json) is metadata only (it
documents the PHP version floor and a `composer run demo` convenience script), not a dependency
manifest this demo's `run.sh` consumes.

## What this demo does NOT prove

### 1. No runtime state-transition guard

`templates/starters/ordering`'s `states status { Draft -> Placed; Placed -> Shipped; Placed ->
Cancelled }` block has **no paired `command` declarations**. Per Koine's documented semantics (see
[§11.6](../../website/src/content/docs/reference/commands-events-state.md)), *"the block by itself
emits nothing — it is a constraint. Its effect appears wherever a command assigns that field"* — the
runtime transition guard is only generated on a `command`'s assignment of the governed field.
Because this starter template declares no commands, the emitted `Order` class accepts any
`OrderStatus` value directly in its constructor, with no generated mutator and no illegal-transition
guard to exercise.

This is a property of **the template**, not a PHP-emitter bug — every other Koine template that uses
a `states` block (`pizzeria`, `library`, `saas-subscription`, `ticketing`) pairs it with commands,
and the same gap applies identically to the C#, TypeScript, Python, and Rust output for this same
template. This demo therefore constructs `Order` snapshots directly at each lifecycle value
(`Draft`, `Placed`, `Shipped`) to prove the status values themselves are correct and
distinguishable, and does **not** assert that constructing an illegal transition (e.g. `Draft ->
Shipped`) is rejected, because nothing in the emitted code rejects it today.

A human may want to file a follow-up issue to enrich `templates/starters/ordering.koi` with real
`place`/`ship`/`cancel` commands (making its `template.json` "state transitions" teaching claim
literally exercised by a generated guard), which would let this demo — and its TypeScript/Python/Rust
siblings — assert a genuine illegal-transition rejection.

## Layout

```
demo/php/
  run.sh               generate -> gate -> php -l -> phpstan --level max -> run -> assert
  main.php              the hand-written driver (see above)
  composer.json          metadata only (PHP version floor + a `composer run demo` convenience script)
  generated/            git-ignored; regenerated by every run.sh
  vendor/                git-ignored; only appears if a contributor runs `composer install`
  reference/             one or two committed emitted .php.txt snapshots, for browsing without running the tool
```
