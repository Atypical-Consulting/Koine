---
id: 8
title: Release assets built inside the release-please run
status: proposed
date: 2026-07-06
links:
  - type: relates-to
    target: 2
---

# Release assets built inside the release-please run

## Context and Problem Statement

[ADR 0002](0002-conventional-commits-and-automated-semver.md) adopted release-please: on merge of its
release PR it bumps the version, tags `vX.Y.Z`, and creates a GitHub Release. ADR 0002's Decision 3
assumed that tag push would trigger `.github/workflows/release.yml` — an `on: push: tags: 'v*'`
workflow that packed the CLI.

That assumption is false. release-please creates the tag using the default `GITHUB_TOKEN`, and GitHub
deliberately does **not** run `on: push` / `on: release` workflows for events created by
`GITHUB_TOKEN` (recursion prevention). Confirmed empirically: `release.yml` has zero run history and
`v0.246.0` carries no release assets — the pack workflow never once fired.

We also want each release to ship downloadable executables: self-contained Koine CLI binaries
(win-x64/linux-x64/osx-arm64) and unsigned Koine Studio desktop installers per OS.

## Considered Options

* Switch release-please to a PAT / GitHub App token so its tag would trigger `on: push: tags`.
* Build and attach release assets inside the release-please workflow run itself, gated on
  `release_created`.

## Decision Outcome

Chosen option: "Build and attach release assets inside the release-please workflow run", because the
PAT / GitHub App token alternative works but requires managing a privileged secret and widens token
scope; the same-run / `release_created` approach needs neither.

We will build and attach release assets **inside the release-please workflow run**, gated on the
`release-please-action` step's `release_created` output — not from any tag- or release-triggered
workflow.

- The `release-please` job exposes `release_created` and `tag_name` as job outputs.
- Downstream jobs (`cli-binaries`, `nupkg`, `studio-desktop`) declare `needs: release-please` and run
  only when `release_created == 'true'`, or on a manual `workflow_dispatch` dry-run that builds but
  never uploads. They run in the same workflow run, which already holds a `contents: write` token, so
  no PAT or GitHub App token is required.
- The Koine Studio desktop build is factored into a reusable workflow (`studio-build.yml`) called by
  both CI (build/test only) and this release flow (build + upload), keeping one source of truth.
- The dead `.github/workflows/release.yml` is removed; its CLI-pack step is folded into the `nupkg`
  job.

## Consequences

- Anything that must run on release is a gated job in `release-please.yml`, not a separate
  tag/release-triggered workflow — the latter silently never fires under the default token.
- This supersedes ADR 0002's Decision 3 on the specific point that the tag triggers `release.yml`.
  The rest of ADR 0002 (Conventional Commits, release-please adoption, the bootstrap baseline) stands.
- Adding a new release artifact means adding or adjusting a gated job here; the `workflow_dispatch`
  dry-run (build without upload) is the way to validate it before a live release.
