---
id: 5
title: ESLint flat-config gate for the front-end safety conventions
status: proposed
date: 2026-07-02
---

# ESLint flat-config gate for the front-end safety conventions

## Context and Problem Statement

The Studio front end (`tooling/koine-studio`, Preact + TS-strict + Zustand) and the shared UI package
(`tooling/koine-ui`) hold four load-bearing safety conventions that TypeScript's type-checker cannot see:

- **void-prefixed floating promises** — a forgotten `.catch`/`await`/`void` is the #633 stuck-button bug class;
- **`domById` over bare `document.getElementById`** — throw-on-missing instead of a silent `null`;
- **escape-before-`innerHTML`** — the XSS contract documented in `editor/markdown.ts`;
- **the react-hooks rules** — hook call-order and dependency correctness.

Before this decision the repo had **no ESLint anywhere** — no config, no dependency, no `lint` script — and
CI gated the front end only on `npm run build` (tsc) and `npm test` (vitest). The conventions held by review
vigilance plus a hand-run `grep … | wc -l` census in `CONTRIBUTING-preact-migration.md`. An empirical probe
showed prod code was already clean on the highest-value rules, making adoption nearly free — but every
ungated week risks the first silent regression. This is the repo's first lint infrastructure, its first
repo-level (root `devDependencies`) front-end tooling, and it wires a new cross-cutting step into CI — a
process decision worth recording, the front-end analogue of the existing `dotnet format` gate on the C# side.

## Considered Options

* No ESLint (status quo) — hold the conventions by review vigilance and a hand-run grep census.
* The `recommendedTypeChecked` preset — measured at ~1,300 findings on the current codebase.
* A narrow, flat-config gate covering only the four load-bearing conventions.

## Decision Outcome

Chosen option: "A narrow, flat-config gate covering only the four load-bearing conventions", because
`recommendedTypeChecked` measured ~1,300 findings (a follow-up ratchet, not a zero-rewrite adoption),
and every ungated week under the status quo risks the first silent regression of a convention review
alone had been holding.

We will adopt a **narrow, flat-config ESLint gate** over both front-end packages:

- Root `devDependencies` (the single npm-workspace lockfile lives there): `eslint` ^10, `typescript-eslint`
  ^8, `eslint-plugin-react-hooks` ^7. Type-aware rules run via `parserOptions.projectService` against each
  package's own `tsconfig.json` (`include: ["src"]`).
- Only the rules that encode the four conventions — `@typescript-eslint/no-floating-promises` /
  `no-misused-promises`, `react-hooks/rules-of-hooks` / `exhaustive-deps`, `no-restricted-properties`
  (getElementById), and `no-restricted-syntax` (the `innerHTML` / `outerHTML` / `insertAdjacentHTML`
  HTML-injection sinks) — **not** the `recommendedTypeChecked` preset. tsc + review stay authoritative
  for style; no Prettier.
- Everything staged so adoption needs **zero mass rewrites**: rules are `error` where prod is already green,
  `off` in tests/stories (a documented follow-up for the ~93 test floating-promises), and the `innerHTML`
  ban carries a two-tier allow-list — permanent imperative islands (CodeMirror, maxGraph, the host seam) off
  permanently, and per-panel *pending-migration* entries each naming the migration issue that retires it.
- A single Linux CI leg (`.github/workflows/koine-studio.yml`'s `studio-web` job) runs
  `npm run lint -w koine-studio -w @atypical/koine-ui` after `npm ci`; lint findings are OS-independent, so
  it is not triplicated across the desktop matrix.

## Consequences

- **Easier:** the four conventions are machine-enforced for all new code — a forgotten `.catch`, a bare
  `getElementById`, a new HTML-injection sink, or a hooks-rule violation fails CI instead of shipping.
  Reviewers stop re-litigating them by eye across two packages; editors get squiggles. The `innerHTML`
  allow-list is now a canonical, CI-checked census of the remaining imperative islands, replacing the
  hand-run grep.
- **Harder / accepted trade-offs:** contributors need the root dev-dependencies installed (npm-workspace
  hoisting handles this transparently); type-aware linting adds a CI step. The gate is deliberately narrow,
  so it does not catch the broader `recommendedTypeChecked` class yet (deferred ratchet). The allow-list is
  **file-level**, not a per-file count budget: a panel already on the list can still add `innerHTML` while
  listed — the accepted cost of a zero-rewrite adoption; the ban still stops any *new* file introducing the
  sink. The disable-justification protocol is a review convention, not itself lint-enforced.

This is Tier 1 of the imperative-island migration arc (#979 / #980 / #985 / #987 / #989–#992): those issues
assume this gate exists and shrink its allow-list as they land.
