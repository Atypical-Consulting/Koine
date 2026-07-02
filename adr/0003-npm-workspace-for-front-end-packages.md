# 0003. npm workspace root for the front-end packages

Date: 2026-07-02

## Status

Accepted

## Context

Issue #905 extracts Koine Studio's (`tooling/koine-studio`) reusable design-system UI — `--koi-*`
tokens, framework-free DOM primitives, store-free presentational Preact components — into a new,
separately versioned, publishable package `@atypical/koine-ui` (`tooling/koine-ui`), so both
`koine-studio` and `website` can consume it, and external consumers could eventually `npm install`
it. Before this change, `tooling/koine-studio`, `tooling/koine-textmate`, and `website` were three
independent npm packages with no shared root — each had its own `package.json` and
`package-lock.json`, and nothing linked them. A workspace-internal package like `koine-ui` needs
some mechanism for `koine-studio`/`website` to resolve it without publishing to a registry first.

npm workspaces (native to npm ≥7, no extra tooling) was the natural fit: a root `package.json` with
a `workspaces` glob turns every matching subfolder with its own `package.json` into a linked member,
resolved via symlinks in a shared root `node_modules`, with one lockfile at the root.

Adopting it had two consequences beyond the immediate `koine-ui` extraction, both of which this ADR
records since they affect the whole front-end, not just this one package:

1. **CI regression.** `.github/workflows/{koine-studio,website,deploy-docs}.yml` ran `npm ci` scoped
   to each package's own subdirectory, against that subdirectory's own `package-lock.json`. Once
   `koine-studio`/`website` depend on a workspace-only package, those per-subdirectory lockfiles
   can't resolve it (`@atypical/koine-ui` isn't a registry package) — `npm ci` there fails. The fix
   is for every `npm ci` to run at the workspace root, against the root lockfile, before any
   subdirectory-scoped build/test script runs (npm's ancestor `node_modules` walk resolves the
   dependency from there).
2. **`dist/` on a fresh checkout.** `koine-ui`'s `package.json` `exports` map points at `dist/`,
   which is build output (gitignored, not committed). A workspace member depends on it via the
   `"@atypical/koine-ui": "*"` symlink resolution, but a fresh clone/`npm ci` has no `dist/` yet — so
   `tsc` in any consumer fails immediately after install. A root `postinstall` script
   (`"postinstall": "npm run build --workspace=@atypical/koine-ui"`) builds it automatically after
   every `npm install`/`npm ci` anywhere in the workspace.

npm workspaces has no built-in sparse/per-member install: `npm ci` always resolves the union of all
workspace members' dependencies against the single root lockfile, regardless of which member's
script you intend to run afterward. Tried a narrower `npm ci --workspace=website` as an alternative
for `website.yml`'s CI job (which doesn't use `koine-ui` yet — see Consequences); it still installed
`koine-studio`'s full devDependency tree (Storybook, Playwright, Tauri CLI, CodeMirror, maxGraph),
confirming this is inherent to vanilla npm workspaces, not a flag away.

## Decision

1. **Root `package.json`** with `"workspaces": ["tooling/*", "website"]`. `tooling/koine-jetbrains`
   (Gradle, no `package.json`) is silently skipped by the glob, as npm workspaces does for any
   non-npm member.
2. **One lockfile at the root.** The 3 per-member lockfiles (`tooling/koine-studio/package-lock.json`,
   `website/package-lock.json`, `tooling/koine-textmate/package-lock.json`) are deleted; the root
   `package-lock.json` is the single source of truth and is committed (the repo-root `.gitignore`'s
   blanket `/package-lock.json` rule, written before any root `package.json` existed, is narrowed
   accordingly).
3. **Every CI `npm ci` runs at the workspace root**, immediately before any subdirectory-scoped
   build/test step, in `koine-studio.yml`, `website.yml`, and `deploy-docs.yml`. `cache-dependency-path`
   / `cache-key-files` inputs across those workflows point at the root lockfile.
4. **A root `postinstall` hook builds `@atypical/koine-ui`'s `dist/`** after every workspace install,
   so `exports`-map resolution never sees a missing `dist/` on a fresh checkout, in CI, or after a
   `git clean`.
5. **`koine-ui` stays independently versioned** (`0.1.0`, unrelated to `Directory.Build.props`) — it
   has its own release cadence as a front-end package, separate from the .NET/NuGet artifact's
   release-please-driven semver ([ADR 0002](0002-conventional-commits-and-automated-semver.md)).

## Consequences

- Every contributor's `npm install`, anywhere in the monorepo — including one who only touches
  `website/` or never touches the front-end at all — now installs the union of all 4 workspace
  members' dependencies and triggers a `koine-ui` production build via `postinstall`. This is a
  real, accepted cost of the single-lockfile model; it was not achievable to narrow away with
  vanilla npm (see Context).
- `website.yml`'s CI job depends on `@atypical/koine-ui` in `website/package.json` (added so the
  Astro playground *can* import components directly later — issue #905's scope keeps the embedding
  path unchanged for now, so nothing in `website/src` imports it yet) — its `npm ci` step is
  correspondingly heavier than the website-only install it replaced, even though that job's own
  vitest suite doesn't need Studio's toolchain. Revisit if this job's runtime becomes a real problem;
  the fix would likely be adopting a workspace-aware package manager with sparse installs (pnpm) or
  waiting for `website` to actually consume `koine-ui` and re-evaluating the trade-off then.
- Running `npm ci`/`npm install` inside a workspace-member subdirectory (rather than the root) now
  produces a broken or incomplete install — every documented workflow (CI and local) must install at
  the root first.
- A future workspace member added under `tooling/*` (or a new top-level front-end package) is picked
  up automatically by the `workspaces` glob; a member added elsewhere needs the glob extended and — if
  it's meant to be reached by CI — the same "install at root" pattern applied to its workflow.
