# 0002. Conventional Commits + automated semantic versioning via release-please

Date: 2026-06-30

## Status

Accepted

## Context

`CONTRIBUTING.md` already states "Commits follow Conventional Commits" but nothing enforced it: a
scan of the 300 most recent commits on `main` found that roughly 95% of them don't match the
`type(scope): subject` form (most are bare squash-merged PR titles such as `Bring C#/TS/Python to
parity on plain value-object arithmetic …`). Two of those — `a5ec0684` and `7c58806d` — were the
most recent offenders at the time of this ADR.

Separately, `Directory.Build.props`'s `<Version>`/`<InformationalVersion>` is bumped by hand, and
`.github/workflows/release.yml` already packs and (eventually) publishes the CLI whenever a `v*` tag
is pushed — but nothing creates those tags. `CHANGELOG.md` already declares adherence to [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/), and
notes the project is pre-1.0 ("minor versions may include breaking changes").

Rewriting all ~600 non-conforming historical commits to "fix" them was considered and rejected: at
that scale it's a full history rewrite (new SHAs for the entire repo), which would invalidate every
fork, clone, and external link to a commit SHA, for a record that's purely historical anyway.

## Decision

1. **Enforce Conventional Commits going forward, not retroactively at scale.** Only the two most
   recent violators (`a5ec0684`, `7c58806d`) were reworded in place via `git rebase`/cherry-pick and
   force-pushed to `main`, so the convention starts clean from the current tip. The other ~600
   historical commits are left untouched.
2. **Gate PR titles in CI.** Since PRs are squash-merged, the PR title becomes the commit subject.
   `.github/workflows/pr-title-lint.yml` runs `amannn/action-semantic-pull-request` on every PR so a
   non-conforming title fails before merge — without this, the automation below would rarely have
   usable input, given the historical compliance rate above.
3. **Adopt [release-please](https://github.com/googleapis/release-please)** to derive the next
   semantic version from Conventional Commits since the last release: `fix:` → patch, `feat:` →
   minor, `!`/`BREAKING CHANGE:` → major. `.github/workflows/release-please.yml` runs it on every
   push to `main`; it opens/updates a release PR that bumps `Directory.Build.props` (via the
   `x-release-please-version` marker) and `CHANGELOG.md`, and tags `vX.Y.Z` on merge — which is what
   triggers the existing `release.yml`.
4. **`bump-minor-pre-major: true`** while the major version is `0`: a breaking change bumps `0.X.0`
   instead of jumping to `1.0.0`, matching the pre-1.0 policy `CHANGELOG.md` already documents.
   Flip this off in `release-please-config.json` deliberately when the project is ready for `1.0.0`.

## Consequences

- Version bumps and changelog entries are no longer a manual, easily-forgotten step — they fall out
  of writing a correctly-typed PR title.
- A PR with a non-conforming title is blocked by CI, which is new friction for a project that's been
  ~95% non-conforming historically; contributors (and agents) need to internalize the
  `type(scope): subject` format described in `CONTRIBUTING.md`.
- The ~600 pre-existing non-conforming commits are permanently part of `main`'s history.
  release-please only reasons about commits since the last tag, so this is harmless going forward,
  but anyone reading `git log` on older history will still see free-form titles.
- `CHANGELOG.md`'s hand-curated `[Unreleased]` section (rich, multi-paragraph entries) will
  increasingly coexist with — and likely be superseded by — release-please's terser, auto-generated,
  one-line-per-commit entries. That stylistic shift is an accepted trade-off for not hand-maintaining
  two changelogs.
