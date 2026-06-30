# 0002. Conventional Commits + automated semantic versioning via release-please

Date: 2026-06-30

## Status

Accepted

## Context

`CONTRIBUTING.md` already states "Commits follow Conventional Commits" but nothing enforced it: of
the 624 commits on `main` at the time of this ADR, 369 (~59%) didn't match the `type(scope): subject`
form — most are bare squash-merged PR titles such as `Bring C#/TS/Python to parity on plain
value-object arithmetic …`.

Separately, `Directory.Build.props`'s `<Version>`/`<InformationalVersion>` is bumped by hand, and
`.github/workflows/release.yml` already packs and (eventually) publishes the CLI whenever a `v*` tag
is pushed — but nothing creates those tags. `CHANGELOG.md` already declares adherence to [Keep a
Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/), and
notes the project is pre-1.0 ("minor versions may include breaking changes").

A first pass at this ADR proposed rewording only the most recent violators and leaving the rest of
history alone, on the grounds that a full rewrite would touch every commit SHA. On review, the
project maintainer wanted full compliance: every commit on `main`, not just the recent ones.

## Decision

1. **Reword all 624 commits on `main` to Conventional Commits form, in one rewrite.** A classifier
   was built rather than hand-typing 369 messages:
   - Where a squash-merge commit's body still carried the original, author-typed Conventional Commit
     sub-commits (`* fix(emit-cs): …`) — true for 281 of the 369 — that ground truth was used
     directly (highest-impact type wins: `feat` > `fix` > … > `chore`, mirroring how
     semantic-release/release-please pick a dominant type for a squashed set). Boilerplate bullets
     from the review loop itself (`fix: address code-review findings`) were filtered out first so
     they couldn't outrank the substantive bullets.
   - The remaining 88 were classified by keyword/pattern heuristics on the subject line (dependency
     bumps, bug-shaped phrasing, refactor verbs, etc.), with 26 low-confidence fallback guesses
     hand-corrected by reading each one.
   - The rewrite was applied via `git filter-branch --msg-filter` (preserves tree, parents, and the
     8 true merge commits — only verified `git diff <old> <new> --stat` was empty before pushing) and
     force-pushed to `main` with `--force-with-lease`.
   - This invalidates every existing commit SHA on `main`. Any fork, clone, or external link to a
     specific commit hash from before this date no longer resolves on `main` (the objects still exist
     in this repo's history if ever needed, just unreferenced by the branch).
2. **Gate PR titles in CI going forward.** Since PRs are squash-merged, the PR title becomes the
   commit subject. `.github/workflows/pr-title-lint.yml` runs `amannn/action-semantic-pull-request`
   on every PR so a non-conforming title fails before merge — without this, history would drift right
   back to non-compliance.
3. **Adopt [release-please](https://github.com/googleapis/release-please)** to derive the next
   semantic version from Conventional Commits since the last release: `fix:` → patch, `feat:` →
   minor, `!`/`BREAKING CHANGE:` → major. `.github/workflows/release-please.yml` runs it on every
   push to `main`; it opens/updates a release PR that bumps `Directory.Build.props` (via the
   `x-release-please-version` marker) and `CHANGELOG.md`, and tags `vX.Y.Z` on merge — which is what
   triggers the existing `release.yml`.
4. **`bump-minor-pre-major: true`** while the major version is `0`: a breaking change bumps `0.X.0`
   instead of jumping to `1.0.0`, matching the pre-1.0 policy `CHANGELOG.md` already documents.
   Flip this off in `release-please-config.json` deliberately when the project is ready for `1.0.0`.
5. **Tag the current version (`v0.17.12`) at the new `main` tip once this lands**, so release-please's
   first run has an explicit baseline to diff from instead of reasoning about the entire (now-clean)
   624-commit history for its first release PR.

## Consequences

- `git log` on `main` now reads as Conventional Commits end to end — no asterisk, no "recent commits
  only."
- Every commit SHA on `main` changed. Anyone with a local clone, an open branch based on pre-rewrite
  `main`, or a bookmarked commit URL needs to rebase onto/refetch the new history; a couple of
  in-flight branches in this workspace needed exactly that as part of landing this change.
- The classifier's type/scope assignments for the 88 keyword-derived (non-ground-truth) messages are
  a best-effort read of each subject line, not a re-derivation from the original diff — they're
  almost certainly more accurate than the original untyped titles, but not guaranteed perfect.
- A PR with a non-conforming title is now blocked by CI; contributors (and agents) need to write
  `type(scope): subject` titles from now on.
- `CHANGELOG.md`'s hand-curated `[Unreleased]` section (rich, multi-paragraph entries) will
  increasingly coexist with — and likely be superseded by — release-please's terser, auto-generated,
  one-line-per-commit entries. That stylistic shift is an accepted trade-off for not hand-maintaining
  two changelogs.
