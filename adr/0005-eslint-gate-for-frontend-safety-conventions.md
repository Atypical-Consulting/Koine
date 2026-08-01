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

## Addendum (2026-07-31) — the deferred `recommendedTypeChecked` ratchet is under way (#998)

The "deferred ratchet" this decision left open is now in progress. `tseslint.configs.recommendedTypeChecked`
is **on** in both `eslint.config.mjs` files, adopted as an **inverted allow-list**: the whole preset applies,
and each rule that still has findings is listed in that config's `RATCHET_PENDING` map as `'off'` with its
live finding count. Every subsequent ratchet PR fixes one rule's findings and **deletes** its entry, so the
table only ever shrinks and the remaining debt is visible in the config itself. Entries are never re-added,
and no finding is ever cleared with a blanket `eslint-disable`.

The preset turns on 47 rules. A fresh measurement on 2026-07-31 (the `~1,300` figure above was the #993-time
snapshot of a since-grown codebase) found **1,961 findings across 17 rules in `koine-studio`** and **41
across 5 rules in `koine-ui`** — so **30 of the 47 rules were already clean** and went straight to `error`.

Starting per-rule burn-down (findings at ratchet time; ✅ = enforced by the PR that opened the ratchet):

| Rule | koine-studio | koine-ui |
|---|---:|---:|
| `no-empty-object-type` | 2 ✅ | 2 ✅ |
| `no-redundant-type-constituents` | 2 ✅ | 0 ✅ |
| `restrict-template-expressions` | 2 ✅ | 0 ✅ |
| `await-thenable` | 5 ✅ | 0 ✅ |
| `prefer-const` | 8 ✅ | 0 ✅ |
| `no-base-to-string` | 9 ✅ | 0 ✅ |
| `prefer-promise-reject-errors` | 10 ✅ | 0 ✅ |
| `no-unsafe-return` | 12 ✅ | 0 ✅ |
| `no-unsafe-argument` | 50 ✅ | 0 ✅ |
| `no-explicit-any` | 65 | 1 |
| `no-unsafe-assignment` | 68 ✅ | 0 ✅ |
| `no-unused-vars` | 72 | 1 |
| `no-unsafe-call` | 129 | 0 ✅ |
| `no-unnecessary-type-assertion` | 221 | 15 |
| `no-unsafe-member-access` | 261 | 0 ✅ |
| `require-await` | 477 | 0 ✅ |
| `unbound-method` | 546 | 22 |
| *(the other 30 preset rules)* | 0 ✅ | 0 ✅ |

`no-unsafe-argument` was burned down in a follow-up PR (#1785); `no-unsafe-assignment` in a further
follow-up (#1814) — the latter's fix also uncovered and closed a real gap: `koine-studio`'s
`npm run lint` script had no step generating the git-ignored `src/templates.generated.ts` before
type-aware linting ran (only `predev`/`prebuild` did), so any file transitively importing from it
type-checked against an unresolvable module and produced a spurious `error`-typed finding; a
`prelint` hook (mirroring the existing `predev`/`prebuild` convention) now generates it first.

The still-pending counts above are **stale** (the ratchet-start snapshot) — the configs'
`RATCHET_PENDING` tables carry the live per-rule figures (each `off` entry's own comment), which is
what to re-measure from before editing either table. As of #1814 (2026-08-02): koine-studio carries
**1,691 findings across 7 rules** (`no-explicit-any` 53, `no-unused-vars` 73, `no-unsafe-call` 113,
`no-unsafe-member-access` 159, `no-unnecessary-type-assertion` 234, `require-await` 490,
`unbound-method` 569 — some rose or fell from the ratchet-start snapshot as unrelated commits landed
and as typing the burned-down rules' seams incidentally tightened/loosened others); koine-ui is
unchanged at 39 across 4 rules.

A rule is burned down across **both** packages in the same PR, so it is never half-enforced across the
tree — the per-directory ratchet #998 considered and rejected. Two rules carry a non-default *option*
(both still `error`, neither an exemption): `no-empty-object-type: { allowInterfaces: 'with-single-extends' }`,
because a `declare module` augmentation only merges through an interface, so `vitest-axe.d.ts`'s body is
necessarily empty; and `prefer-const: { ignoreReadBeforeAssign: true }`, because the codebase's
forward-declaration idiom for mutually-referencing controllers (`let workspace: WorkspaceController;`,
read by a thunk defined above its single assignment) *cannot* be `const` — the default rule demands an
edit that does not compile.

`src/templates.generated.ts` (koine-studio) is excluded from the gate outright: it is a ~180KB
machine-generated, git-ignored module, and CI runs `npm run lint` before the generator has produced it — so
linting it would make the gate depend on build order.

This addendum records the ratchet's **start**; the decision above stands unchanged until the last
`RATCHET_PENDING` entry is gone, at which point #998's closeout amends it to record full adoption.
