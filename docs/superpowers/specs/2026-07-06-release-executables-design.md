# Design — Honest release notes + cross-platform executables on release

Date: 2026-07-06
Status: Approved (brainstorm) — pending implementation plan
Branch: `feat/release-cross-platform-executables`

## Problem

Two independent problems surfaced from the 0.246.x release cycle:

1. **The upcoming release under-reports its work.** Release-please PR #1121 bumps
   `0.246.0 → 0.246.1` with a *single* changelog line, even though the PR it credits (#1120)
   closed **four** issues — #581, #902, #977 (shared emitter-infra consolidation + unified
   `NeedsAdd` migration) and #1091 (the multi-owner cross-context qualification bugfix). Root
   cause: #1120 was **squash-merged into one `fix:` commit**, so release-please saw exactly one
   Conventional Commit → one patch bump, one changelog entry. The substantial refactoring work is
   invisible in the release notes.

2. **No downloadable executables ship on release.** The user wants native artifacts for macOS,
   Windows, and Linux produced automatically whenever the Release Please PR merges. Today nothing
   is attached: the tag-triggered `release.yml` (CLI nupkg pack) **has never run** and
   `v0.246.0` has **zero release assets**.

### Why the tag trigger is dead (load-bearing constraint)

`release.yml` is `on: push: tags: 'v*'`. Release-please creates the tag using the default
`GITHUB_TOKEN`. GitHub deliberately does **not** trigger `on: push`/`on: release` workflows for
events created by `GITHUB_TOKEN` (recursion prevention). Confirmed empirically: `release.yml` has
zero run history. Therefore any tag-triggered or release-event-triggered build is dead on arrival.
The reliable fix is to build **within the release-please workflow run**, gated on the
release-please-action's own outputs — that run already holds a `contents: write` token and needs no
new secret.

## Decisions (from brainstorm)

| # | Decision | Choice |
|---|----------|--------|
| 1 | Disposition of the pending release | **Bump to minor `0.247.0`** with enriched, honest notes |
| 2 | What ships as an executable | **Both** the Koine CLI and the Koine Studio desktop app |
| 3 | CLI target RIDs | **The 3 existing profiles**: `win-x64`, `linux-x64`, `osx-arm64` |
| 4 | Studio installer signing | **Unsigned for now**, with a documented "installing unsigned builds" note |
| 5 | Studio build code path | **Extract a reusable workflow** shared by CI and release (one source of truth) |
| 6 | The dead `release.yml` | **Fold its nupkg pack into the new flow and delete `release.yml`** |
| 7 | Prevention guard | **Include** a lightweight convention so future multi-issue squashes don't collapse |

## Part 1 — Release `0.247.0` with honest notes

This is a **live release-management operation** on `main` + the open release PR, not a feature
branch. Sequence:

1. **Set the version.** Push one empty commit to `main` with a `Release-As: 0.247.0` footer:
   ```
   git commit --allow-empty -m "chore: release 0.247.0" -m "Release-As: 0.247.0"
   ```
   release-please re-runs, supersedes the 0.246.1 PR, and regenerates PR #1121 as
   `chore(main): release 0.247.0`. This is release-please's supported version-override path — no
   manifest hand-editing.

2. **Enrich the in-repo changelog.** After regeneration, edit the release PR branch's
   `CHANGELOG.md` (and the PR body) to group the four issues honestly:
   - **Features** — shared emitter-infra consolidation (#581, #977); unified `NeedsAdd` migration (#902)
   - **Bug Fixes** — multi-owner cross-context type qualification (#1091)

3. **Guarantee the published notes.** release-please recomputes release notes from commits at merge
   time and may drop hand-added lines. So after the release PR merges and `v0.247.0` is created,
   **finalize the GitHub Release body** with:
   ```
   gh release edit v0.247.0 --notes-file <enriched-notes.md>
   ```
   This decouples the published notes from release-please's commit-derived computation
   (belt-and-suspenders).

### Prevention guard (decision 7)

Add a short convention to the `merge-pr` skill (and/or `CONTRIBUTING`): when a squash-merged PR
closes **multiple** issues, its squash-commit body should carry **one Conventional Commit line per
issue** so release-please emits a changelog entry per unit of work instead of collapsing to the PR
title. Keep it to a paragraph + example. This is documentation/process only — no tooling.

> Verification note: whether release-please splits a multi-line squash body into multiple changelog
> entries must be confirmed against release-please-action v5 behavior during implementation. If it
> does not split reliably, the guard degrades to "don't bundle unrelated issues into one squash" —
> still an improvement.

## Part 2 — CLI + Studio executables on release

Delivered as a normal feature branch → PR. All build jobs live in (or are called from)
`release-please.yml` and run in the same workflow run that creates the release.

### Trigger wiring

- Give the `release-please-action` step an `id: release`.
- Expose job outputs from the `release-please` job: `release_created`, `tag_name`.
- New build jobs declare `needs: release-please` and
  `if: needs.release-please.outputs.release_created == 'true'`.
- Add `workflow_dispatch` with a boolean input (e.g. `upload: false` default) so the whole matrix
  can be **dry-run manually** before a real release is trusted to it. On dispatch runs the upload
  step is skipped.

### Job A — `cli-binaries` (matrix)

| runner | rid | archive |
|--------|-----|---------|
| ubuntu-latest | linux-x64 | `koine-<tag>-linux-x64.tar.gz` |
| windows-latest | win-x64 | `koine-<tag>-win-x64.zip` |
| macos-latest | osx-arm64 | `koine-<tag>-osx-arm64.tar.gz` |

Steps: setup .NET via the `setup-dotnet-wasm` composite (`install-wasm-workloads: false`) →
`dotnet publish src/Koine.Cli -p:PublishProfile=<rid>` (reuses the existing `.pubxml`; self-contained,
single-file, trimming off) → archive the single `koine`/`koine.exe` from `bin/publish/<rid>/`
(tar.gz preserves the Unix exec bit; zip on Windows) → `gh release upload <tag> <archive> --clobber`
(guarded by the dispatch `upload` flag).

### Job B — `nupkg` (ubuntu)

Folds in the currently-dead `release.yml` pack: `dotnet pack src/Koine.Cli/Koine.Cli.csproj -c Release`
→ attach the `.nupkg` to the release via `gh release upload --clobber`. Keeps the existing NuGet-push
TODO comment (still gated on a future `NUGET_API_KEY`). **`release.yml` is then deleted.**

### Job C — `studio-desktop` (matrix, via reusable workflow)

Decision 5: extract `koine-studio.yml`'s desktop matrix into a reusable workflow
`.github/workflows/studio-build.yml` (`on: workflow_call`) with inputs:

- `publish` (bool, default false) — when true, run the bundle + upload steps.
- `tag` (string, optional) — the release tag to upload assets to.

`koine-studio.yml`'s existing desktop job becomes a thin caller (`uses: ./.github/workflows/studio-build.yml`
with `publish: false`) so CI behavior is unchanged. `release-please.yml` calls the same reusable
workflow with `publish: true` and `tag: <tag_name>`.

New work inside the reusable workflow's publish path (CI currently stops at `cargo build --locked`
and never bundles):

- Add a **`tauri build`** (bundle) step producing the distributables:
  - macOS → `.dmg` (+ `.app`)
  - Windows → `.msi` and/or NSIS `.exe`
  - Linux → `.AppImage` (and `.deb` if enabled)
- Locate bundles under `tooling/koine-studio/src-tauri/target/release/bundle/**`.
- Upload each to the release via `gh release upload <tag> <bundle> --clobber`.
- **Unsigned** (decision 4): Tauri's default no-signing config is fine; add an "Installing unsigned
  builds" note (macOS: right-click → Open; Windows SmartScreen: More info → Run anyway) to the
  release notes and/or docs.

> Verification note: exact `tauri build` invocation (`npm run tauri build` vs `cargo tauri build`)
> and the precise bundle output paths per OS must be confirmed during implementation.

### Assets on each future release

`v0.247.0` (and every subsequent release) gets: 3 CLI archives + 1 `.nupkg` + the Studio installers
per OS, all attached to the release-please-created GitHub Release. Users download from the Releases
page.

## Components & boundaries

| Unit | Purpose | Interface | Depends on |
|------|---------|-----------|------------|
| `release-please.yml` (extended) | Version PR + fan-out to build jobs on release | `on: push[main]` + `workflow_dispatch`; job outputs `release_created`, `tag_name` | release-please-action, composite, studio-build.yml |
| `cli-binaries` job | Self-contained CLI archives per RID | matrix input `rid`; emits release assets | existing `.pubxml` profiles, `gh` |
| `nupkg` job | CLI global-tool package | emits `.nupkg` release asset | `dotnet pack` |
| `studio-build.yml` (new reusable) | Build/test (+ optionally bundle & upload) Studio desktop | `workflow_call` inputs `publish`, `tag` | Tauri, npm workspace, LSP sidecar publish |
| `koine-studio.yml` (thinned) | CI caller of studio-build | `uses:` with `publish: false` | studio-build.yml |
| merge-pr skill / CONTRIBUTING note | Prevent thin changelogs | documentation | — |

## Error handling

- `fail-fast: false` on all matrices so one OS leg failing doesn't cancel the others' uploads.
- `gh release upload … --clobber` is idempotent — safe on re-runs / re-dispatch.
- Build jobs are gated on `release_created == 'true'`, so ordinary pushes to `main` (no release)
  never trigger heavy builds; only an actual release does.
- Per-job `permissions: contents: write` (already at workflow level) for `gh release upload`.
- Timeouts on every job (match the repo's existing 15–30 min backstops).

## Testing / de-risking

- **`actionlint`** on all touched/new workflow YAML.
- **`workflow_dispatch` dry-run** (upload=false) to exercise the CLI + Studio matrix end-to-end
  without a real release.
- The CLI publish profiles are already proven green — `koine-studio.yml` publishes the LSP sidecar
  from them on every Studio CI run.
- Full `release_created == true` path cannot be exercised without an actual merge; the dispatch
  dry-run is the mitigation.

## Out of scope (YAGNI)

- Code-signing / notarization (deferred; unsigned now).
- Additional RIDs (osx-x64 / linux-arm64 / win-arm64).
- Publishing the `.nupkg` to NuGet.org (still a TODO, gated on `NUGET_API_KEY`).
- Homebrew / winget / apt package channels.
