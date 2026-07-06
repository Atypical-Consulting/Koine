# Cross-platform executables on release + honest 0.247.0 notes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and attach Koine CLI binaries (win-x64/linux-x64/osx-arm64) and Koine Studio desktop installers to every GitHub Release, and cut a 0.247.0 release whose notes honestly credit all four issues #1120 closed.

**Architecture:** Because release-please creates tags with `GITHUB_TOKEN` (which cannot trigger `on: push`/`on: release` workflows), all build jobs run **inside the release-please workflow run**, gated on the `release-please-action` step's `release_created` output. The Studio desktop build is extracted into a reusable workflow (`studio-build.yml`) called by both CI (build/test only) and the release flow (build + upload). The CLI reuses its existing self-contained single-file publish profiles.

**Tech Stack:** GitHub Actions, `googleapis/release-please-action@v5`, .NET 10 (`dotnet publish`/`pack`), Tauri v2 (`npm run tauri -- build`), `gh` CLI for release uploads.

## Global Constraints

- **Commit identity (every commit):** `git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" commit -m "..."`
- **PR title = Conventional Commits.** The Part-2 PR title uses `ci:` scope (CI/workflow change, no version bump): `ci: build & publish cross-platform executables on each release`.
- **Pin every third-party action by the SHA already used elsewhere in this repo** (copy verbatim): `actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7`, `actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1 # v5`, `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6`, `actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6`, `dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30 # stable`. Local composite/reusable actions use `./` paths (no SHA).
- **.NET SDK:** `10.0.x`, quality `preview`. **Node:** `24`.
- **CLI RIDs (exactly these three):** `win-x64`, `linux-x64`, `osx-arm64`. Do NOT add other RIDs.
- **Studio installers are UNSIGNED.** No signing secrets. Ship with a documented install note.
- **Every job carries a `timeout-minutes`** (match existing: 15 for .NET-only jobs, 30 for the Studio matrix).
- **`fail-fast: false`** on every matrix so one OS leg failing doesn't cancel the others' uploads.
- **`gh release upload … --clobber`** (idempotent) for all asset uploads; token via `env: GH_TOKEN: ${{ github.token }}`.
- **Do NOT edit generated parser code or unrelated workflows.** Touch only the files each task names.

## File Structure

| File | Responsibility | Task |
|------|----------------|------|
| `.github/workflows/studio-build.yml` (**new**) | Reusable (`workflow_call`) Studio desktop build; inputs `bundle`/`publish`/`tag`; matrix over 3 OS; optional `tauri build` + upload | 1 |
| `.github/workflows/koine-studio.yml` (**modify**) | Replace inline `studio` matrix job with a thin caller of `studio-build.yml` (bundle/publish=false); keep `studio-web` | 1 |
| `.github/workflows/release-please.yml` (**modify**) | Add `workflow_dispatch`; expose `release_created`/`tag_name` outputs; add `cli-binaries` + `nupkg` jobs and `studio-desktop` caller | 2, 3 |
| `.github/workflows/release.yml` (**delete**) | Dead tag-triggered pack — folded into `nupkg` job | 2 |
| `.claude/skills/merge-pr/SKILL.md` (**modify**) | Prevention convention: multi-issue squash bodies list one Conventional Commit line per issue | 4 |
| *(live ops — no repo file)* | 0.247.0 `Release-As` + enriched notes + `gh release edit` | 5 |

Task 3 depends on Task 1 (the reusable workflow must exist). Task 2 is independent of Task 1. Task 5 (Part 1 release) runs **after** Tasks 1–4 are merged to `main`, so 0.247.0 is the first release carrying executables.

---

### Task 1: Extract the reusable Studio build workflow; thin `koine-studio.yml`

**Files:**
- Create: `.github/workflows/studio-build.yml`
- Modify: `.github/workflows/koine-studio.yml` (replace the `studio` job, lines 22–207, with a caller; leave `studio-web` untouched)
- Verify with: `actionlint`

**Interfaces:**
- Produces: reusable workflow `./.github/workflows/studio-build.yml` with `workflow_call` inputs `bundle: boolean` (default false), `publish: boolean` (default false), `tag: string` (default ''). When `bundle` is true it runs `tauri build`; when `publish` is true it uploads installers to release `tag`. Task 3 consumes this.

- [ ] **Step 1: Install actionlint (one-time, local verify tool)**

Run: `brew install actionlint`
Expected: actionlint installed. Fallback if no brew: `go install github.com/rhysd/actionlint/cmd/actionlint@latest` (adds `~/go/bin` to PATH), or download the binary from the actionlint releases page.

- [ ] **Step 2: Create `.github/workflows/studio-build.yml`**

This is the current `studio` matrix job (koine-studio.yml lines 22–207) moved verbatim under `workflow_call`, plus three publish-gated steps at the end. Write exactly:

```yaml
name: studio-build

# Reusable Koine Studio desktop build (Tauri v2) over Linux/Windows/macOS.
# Called by koine-studio.yml (CI: build+test only) and release-please.yml (release: build+upload).
# `bundle: true` runs `tauri build` to produce installers; `publish: true` uploads them to the
# GitHub Release named by `tag`. Default (bundle=false) reproduces the prior CI behavior exactly.

on:
  workflow_call:
    inputs:
      bundle:
        description: Run `tauri build` to produce distributable installers.
        type: boolean
        default: false
      publish:
        description: Upload the built installers to the release named by `tag` (implies bundle).
        type: boolean
        default: false
      tag:
        description: Release tag to upload installers to (required when publish is true).
        type: string
        default: ''

permissions:
  contents: write

jobs:
  studio:
    name: studio (${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            rid: linux-x64
            triple: x86_64-unknown-linux-gnu
          - os: windows-latest
            rid: win-x64
            triple: x86_64-pc-windows-msvc
          - os: macos-latest
            rid: osx-arm64
            triple: aarch64-apple-darwin
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7

      - name: Setup .NET
        uses: actions/setup-dotnet@26b0ec14cb23fa6904739307f278c14f94c95bf1 # v5
        with:
          dotnet-version: '10.0.x'
          dotnet-quality: preview

      - name: Cache NuGet
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6
        with:
          path: ~/.nuget/packages
          key: ${{ runner.os }}-nuget-${{ hashFiles('**/*.csproj', 'Directory.Build.props') }}
          restore-keys: ${{ runner.os }}-nuget-

      - name: Cap apt acquire timeouts (cold-cache safety net)
        if: runner.os == 'Linux'
        run: |
          printf 'Acquire::Retries "3";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
            | sudo tee /etc/apt/apt.conf.d/99-koine-timeouts >/dev/null

      - name: Install Linux system dependencies (Tauri v2)
        if: runner.os == 'Linux'
        uses: awalsh128/cache-apt-pkgs-action@553a35bb8ebd9fcabcb1c9451aa4c98e1b4ca8a9 # v1
        with:
          packages: libwebkit2gtk-4.1-dev libsoup-3.0-dev libgtk-3-dev libappindicator3-dev librsvg2-dev patchelf
          version: koine-tauri-1

      - name: Publish LSP sidecar
        run: dotnet publish src/Koine.Cli -p:PublishProfile=${{ matrix.rid }}

      - name: Run headless LSP tests
        run: dotnet test tests/Koine.Compiler.Tests/Koine.Compiler.Tests.csproj -c Release --filter "FullyQualifiedName~LspServerTests"

      - name: Setup Node
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6
        with:
          node-version: '24'
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@4be7066ada62dd38de10e7b70166bc74ed198c30 # stable

      - name: Cache Cargo build
        id: cargo-cache
        uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            tooling/koine-studio/src-tauri/target
          key: ${{ runner.os }}-cargo-${{ hashFiles('tooling/koine-studio/src-tauri/Cargo.lock') }}
          restore-keys: |
            ${{ runner.os }}-cargo-

      - name: Stage sidecar for Tauri (externalBin)
        shell: bash
        run: |
          ext=""
          [ "${{ runner.os }}" = "Windows" ] && ext=".exe"
          mkdir -p tooling/koine-studio/src-tauri/binaries
          cp "src/Koine.Cli/bin/publish/${{ matrix.rid }}/koine${ext}" \
             "tooling/koine-studio/src-tauri/binaries/koine-${{ matrix.triple }}${ext}"

      - name: Build Rust host (cargo)
        working-directory: tooling/koine-studio/src-tauri
        shell: bash
        run: |
          if [ "${{ steps.cargo-cache.outputs.cache-hit }}" = "true" ]; then
            cargo update -p koine-studio --offline
          else
            cargo update -p koine-studio
          fi
          cargo build --locked
          cargo test --locked

      - name: Install npm dependencies (workspace root)
        run: npm ci

      - name: Build frontend (npm)
        working-directory: tooling/koine-studio
        run: npm run build

      - name: Install Playwright Chromium (Storybook story tests)
        uses: ./.github/actions/setup-playwright
        with:
          working-directory: tooling/koine-studio
          cache-key-files: package-lock.json

      - name: "Redirect temp to the D: drive for headroom (Windows)"
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          "TEMP=$env:RUNNER_TEMP" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
          "TMP=$env:RUNNER_TEMP"  | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
          Write-Host "TEMP/TMP redirected to $env:RUNNER_TEMP"
          Get-PSDrive -PSProvider FileSystem |
            Select-Object Name,
              @{N='Used(GB)';E={[Math]::Round($_.Used/1GB,2)}},
              @{N='Free(GB)';E={[Math]::Round($_.Free/1GB,2)}} |
            Format-Table -AutoSize

      - name: Test frontend (npm)
        working-directory: tooling/koine-studio
        run: npm test

      # --- Release-only: build the distributable installers and upload them. ---
      # `tauri build` runs beforeBuildCommand (npm run build) then a cargo release build + bundles
      # for this OS (tauri.conf.json bundle.targets = "all"). The `-- ` forwards `build` to the
      # local tauri CLI. Installers are UNSIGNED (no signing secrets configured).
      - name: Build Tauri installers
        if: ${{ inputs.bundle }}
        working-directory: tooling/koine-studio
        run: npm run tauri -- build

      - name: Collect installers
        if: ${{ inputs.bundle }}
        shell: bash
        run: |
          set -euo pipefail
          shopt -s nullglob
          dest="studio-installers"
          mkdir -p "$dest"
          base="tooling/koine-studio/src-tauri/target/release/bundle"
          for f in "$base"/dmg/*.dmg \
                   "$base"/msi/*.msi "$base"/nsis/*.exe \
                   "$base"/appimage/*.AppImage "$base"/deb/*.deb; do
            cp "$f" "$dest/"
          done
          echo "Collected installers:"; ls -la "$dest"

      - name: Upload installers to release
        if: ${{ inputs.publish }}
        env:
          GH_TOKEN: ${{ github.token }}
        shell: bash
        run: |
          set -euo pipefail
          gh release upload "${{ inputs.tag }}" studio-installers/* --clobber
```

- [ ] **Step 3: Replace the `studio` job in `koine-studio.yml` with a caller**

In `.github/workflows/koine-studio.yml`, delete the entire `studio:` job (lines 22–207, from `  studio:` up to and including the `run: npm test` step) and replace it with the caller job below. Leave the `on:`, `permissions:`, `concurrency:` headers and the whole `studio-web:` job unchanged.

```yaml
jobs:
  # Desktop build/test on all 3 OSes via the reusable workflow. bundle/publish stay false in CI:
  # this reproduces the prior inline `studio` job exactly (no installers produced or uploaded).
  studio-desktop:
    uses: ./.github/workflows/studio-build.yml
    with:
      bundle: false
      publish: false

  studio-web:
    # ...unchanged...
```

- [ ] **Step 4: Validate both workflows**

Run: `actionlint .github/workflows/studio-build.yml .github/workflows/koine-studio.yml`
Expected: no output (exit 0). If actionlint reports "reusable workflow call ... input not defined" or a boolean-type error, fix the `with:` block before proceeding.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/studio-build.yml .github/workflows/koine-studio.yml
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "ci: extract reusable studio-build workflow shared by CI and release"
```

---

### Task 2: Rewire `release-please.yml` triggers, add CLI binaries + nupkg jobs, delete `release.yml`

**Files:**
- Modify: `.github/workflows/release-please.yml`
- Delete: `.github/workflows/release.yml`
- Verify with: `actionlint` + a local `dotnet publish` smoke test

**Interfaces:**
- Consumes: existing publish profiles `src/Koine.Cli/Properties/PublishProfiles/{win-x64,linux-x64,osx-arm64}.pubxml` (self-contained single-file; produce `koine`/`koine.exe` under `src/Koine.Cli/bin/publish/<rid>/`).
- Produces: `release-please` job outputs `release_created` (string 'true'/'false') and `tag_name` (e.g. `v0.247.0`), consumed by Task 3.

- [ ] **Step 1: Add `workflow_dispatch` to the trigger block**

In `.github/workflows/release-please.yml`, change the `on:` block from:

```yaml
on:
  push:
    branches: [main]
```

to:

```yaml
on:
  push:
    branches: [main]
  # Manual dry-run: builds the CLI/Studio matrices without uploading (release_created is false
  # off a dispatch, so every upload step is skipped). Use to validate the build path pre-release.
  workflow_dispatch:
```

- [ ] **Step 2: Give the release-please job an id and outputs**

Change the `release-please:` job header + step so the action's outputs surface as job outputs:

```yaml
  release-please:
    needs: bootstrap-baseline
    runs-on: ubuntu-latest
    timeout-minutes: 15
    outputs:
      release_created: ${{ steps.release.outputs.release_created }}
      tag_name: ${{ steps.release.outputs.tag_name }}
    steps:
      - uses: googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7 # v5
        id: release
        with:
          target-branch: main
```

- [ ] **Step 3: Add the `cli-binaries` and `nupkg` jobs**

Append these two jobs to `release-please.yml` (after the `release-please` job). Both are gated so heavy builds run only on an actual release or a manual dispatch; uploads happen only on a real release.

```yaml
  # Self-contained, single-file CLI per OS, attached to the release. Reuses the existing
  # Properties/PublishProfiles/<rid>.pubxml (SelfContained, PublishSingleFile, trimming OFF).
  cli-binaries:
    name: cli (${{ matrix.rid }})
    needs: release-please
    if: ${{ needs.release-please.outputs.release_created == 'true' || github.event_name == 'workflow_dispatch' }}
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            rid: linux-x64
          - os: windows-latest
            rid: win-x64
          - os: macos-latest
            rid: osx-arm64
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7

      - name: Setup .NET
        uses: ./.github/actions/setup-dotnet-wasm
        with:
          install-wasm-workloads: false

      - name: Publish self-contained CLI
        run: dotnet publish src/Koine.Cli -p:PublishProfile=${{ matrix.rid }}

      - name: Archive (tar.gz, Unix)
        if: runner.os != 'Windows'
        shell: bash
        run: |
          set -euo pipefail
          tag="${{ needs.release-please.outputs.tag_name }}"
          tag="${tag:-dev}"
          out="koine-${tag}-${{ matrix.rid }}.tar.gz"
          tar -C "src/Koine.Cli/bin/publish/${{ matrix.rid }}" -czf "$out" koine
          echo "ASSET=$out" >> "$GITHUB_ENV"

      - name: Archive (zip, Windows)
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          $tag = "${{ needs.release-please.outputs.tag_name }}"
          if (-not $tag) { $tag = "dev" }
          $out = "koine-$tag-${{ matrix.rid }}.zip"
          Compress-Archive -Path "src/Koine.Cli/bin/publish/${{ matrix.rid }}/koine.exe" -DestinationPath $out -Force
          "ASSET=$out" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8

      - name: Upload to release
        if: ${{ needs.release-please.outputs.release_created == 'true' }}
        env:
          GH_TOKEN: ${{ github.token }}
        shell: bash
        run: gh release upload "${{ needs.release-please.outputs.tag_name }}" "$ASSET" --clobber

  # CLI packed as a .NET global tool, attached to the release. Folds in the (never-triggered)
  # release.yml pack. NuGet.org publish stays a TODO until a NUGET_API_KEY secret exists.
  nupkg:
    needs: release-please
    if: ${{ needs.release-please.outputs.release_created == 'true' || github.event_name == 'workflow_dispatch' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7

      - name: Setup .NET
        uses: ./.github/actions/setup-dotnet-wasm
        with:
          install-wasm-workloads: false

      - name: Pack CLI
        run: dotnet pack src/Koine.Cli/Koine.Cli.csproj -c Release -o ./artifacts

      - name: Upload nupkg to release
        if: ${{ needs.release-please.outputs.release_created == 'true' }}
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload "${{ needs.release-please.outputs.tag_name }}" ./artifacts/*.nupkg --clobber

      # TODO: publish to NuGet once a NUGET_API_KEY secret is configured:
      # dotnet nuget push ./artifacts/*.nupkg --api-key ${{ secrets.NUGET_API_KEY }} \
      #   --source https://api.nuget.org/v3/index.json --skip-duplicate
```

- [ ] **Step 4: Delete the dead `release.yml`**

```bash
git rm .github/workflows/release.yml
```

- [ ] **Step 5: Validate the workflow**

Run: `actionlint .github/workflows/release-please.yml`
Expected: no output (exit 0).

- [ ] **Step 6: Smoke-test the CLI publish + archive locally (native RID)**

Run:
```bash
dotnet publish src/Koine.Cli -p:PublishProfile=osx-arm64
tar -C src/Koine.Cli/bin/publish/osx-arm64 -czf /tmp/koine-smoke-osx-arm64.tar.gz koine
tar -tzf /tmp/koine-smoke-osx-arm64.tar.gz
```
Expected: publish succeeds; the archive lists a single entry `koine`. Confirms the publish-dir path and archive step are correct. Clean up: `rm /tmp/koine-smoke-osx-arm64.tar.gz`.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/release-please.yml
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "ci: publish self-contained CLI binaries & nupkg on release; drop dead release.yml"
```

---

### Task 3: Add the `studio-desktop` caller job to `release-please.yml`

**Files:**
- Modify: `.github/workflows/release-please.yml`
- Verify with: `actionlint`

**Interfaces:**
- Consumes: Task 1's reusable `studio-build.yml` (inputs `bundle`, `publish`, `tag`) and Task 2's `release-please` outputs `release_created`, `tag_name`.

- [ ] **Step 1: Append the caller job**

Add this job to `release-please.yml` (after `nupkg`). On a real release it bundles + uploads; on a manual dispatch it bundles only (dry-run), and it doesn't run at all on ordinary pushes.

```yaml
  # Studio desktop installers (.dmg/.msi or NSIS .exe/.AppImage/.deb), UNSIGNED, attached to the
  # release. Reuses the same build as CI via the reusable workflow; publish only on a real release.
  studio-desktop:
    needs: release-please
    if: ${{ needs.release-please.outputs.release_created == 'true' || github.event_name == 'workflow_dispatch' }}
    permissions:
      contents: write
    uses: ./.github/workflows/studio-build.yml
    with:
      bundle: ${{ needs.release-please.outputs.release_created == 'true' || github.event_name == 'workflow_dispatch' }}
      publish: ${{ needs.release-please.outputs.release_created == 'true' }}
      tag: ${{ needs.release-please.outputs.tag_name }}
```

- [ ] **Step 2: Validate the workflow**

Run: `actionlint .github/workflows/release-please.yml`
Expected: no output (exit 0). In particular actionlint must accept the reusable-workflow `with:` inputs against `studio-build.yml`'s declared types.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-please.yml
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "ci: publish unsigned Studio desktop installers on release"
```

---

### Task 4: Prevention guard — document the multi-issue squash convention

**Files:**
- Modify: `.claude/skills/merge-pr/SKILL.md`
- Verify with: read-back (no build impact)

- [ ] **Step 1: Locate the merge/squash section**

Run: `grep -n "squash\|Conventional\|changelog\|release-please" .claude/skills/merge-pr/SKILL.md`
Expected: finds where the skill describes the squash-merge step. If no obvious anchor, add the note under the section that performs `gh pr merge --squash`.

- [ ] **Step 2: Insert the convention note**

Add this block near the squash-merge instruction (adapt heading depth to the surrounding file):

```markdown
#### Multi-issue PRs: keep the changelog honest

release-please derives the version bump and one CHANGELOG entry **per Conventional Commit on
`main`**. A squash-merge collapses the whole PR into a single commit, so a PR that closes several
issues yields exactly one release-notes line and one bump — under-reporting the work (this is what
happened with #1120 → the thin 0.246.1 notes).

When squash-merging a PR that closes **more than one issue**, write the squash-commit **body** with
one Conventional Commit line per distinct change, e.g.:

    fix(emit): qualify multi-owner cross-context type references (#1091)

    feat(emit): consolidate shared emitter infra onto #356 helpers (#581, #977)
    feat(emit): migrate C#/TS/Python emitters to the unified NeedsAdd model (#902)

Verify the resulting release PR lists an entry per line. If release-please does not split the body,
prefer not bundling unrelated issues into one squash in the first place.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/merge-pr/SKILL.md
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit -m "docs(merge-pr): note multi-issue squash convention to keep release notes honest"
```

- [ ] **Step 4: Open the Part-2 PR**

```bash
git push -u origin feat/release-cross-platform-executables
gh pr create --title "ci: build & publish cross-platform executables on each release" \
  --body "Implements docs/superpowers/specs/2026-07-06-release-executables-design.md.

- Reusable studio-build.yml shared by CI (build/test) and release (build + upload)
- CLI self-contained single-file binaries (win-x64/linux-x64/osx-arm64) + nupkg attached to each release
- Studio desktop installers (unsigned) attached to each release
- Build jobs run inside the release-please run (gated on release_created) because the GITHUB_TOKEN tag can't trigger on:push:tags — which is why the old release.yml never ran; it's removed
- workflow_dispatch dry-run for the whole matrix
- merge-pr convention note so future multi-issue squashes don't collapse the changelog

Closes the 'no executables on release' gap. Part 1 (0.247.0 honest notes) is a separate live release op."
```

- [ ] **Step 5: (optional) Dry-run the matrix before merge**

After the PR's `feat/*` branch is on GitHub, trigger the manual dry-run to prove the build path without uploading:
Run: `gh workflow run release-please.yml --ref feat/release-cross-platform-executables`
Then watch: `gh run list --workflow=release-please.yml --branch feat/release-cross-platform-executables`
Expected: `cli-binaries` (×3), `nupkg`, and `studio-desktop` all green; no assets uploaded (release_created is false off a dispatch). Note: `workflow_dispatch` runs the workflow version on the target branch, so this works once the branch is pushed.

Then merge via the `merge-pr` skill.

---

### Task 5: Cut release 0.247.0 with honest notes (live ops — run AFTER Tasks 1–4 merge to `main`)

> **This task pushes to `main` and merges a production release. Confirm with the user before each
> outward-facing step (the empty `Release-As` commit push, and the release-PR merge).** Not part of
> the feature branch — these operate on `main` and the live release PR.

**Files:** none committed to the feature branch. Uses a scratch notes file.

- [ ] **Step 1: Write the enriched release notes to a scratch file**

Create `/tmp/koine-0.247.0-notes.md`:

```markdown
## Features

* **emit:** consolidate repo-wide `MembersOf`/identifier-char helpers onto the shared #356 helpers ([#581](https://github.com/Atypical-Consulting/Koine/issues/581))
* **emit:** hoist per-emitter csproj boilerplate into a shared `src/Koine.Emit.props` ([#977](https://github.com/Atypical-Consulting/Koine/issues/977))
* **emit:** migrate C#/TypeScript/Python emitters to the unified `NeedsAdd` operator-needs model ([#902](https://github.com/Atypical-Consulting/Koine/issues/902))

## Bug Fixes

* **emit:** qualify ambiguous multi-owner cross-context type references (KOI1419 diagnostic) ([#1091](https://github.com/Atypical-Consulting/Koine/issues/1091))

## Downloads

This release ships prebuilt executables — see the assets below.

**Koine CLI** (self-contained, no .NET runtime needed): `koine-v0.247.0-<os>.{tar.gz,zip}` for linux-x64, win-x64, osx-arm64.

**Koine Studio desktop** installers per OS. These are **unsigned**:
- **macOS**: right-click the app → **Open** (Gatekeeper) the first time.
- **Windows**: on the SmartScreen prompt, **More info → Run anyway**.
```

- [ ] **Step 2: Bump the version to 0.247.0 via `Release-As` (needs user confirmation to push to main)**

From an up-to-date `main`:
```bash
git fetch origin main
git switch main && git pull --ff-only
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit --allow-empty -m "chore: release 0.247.0" -m "Release-As: 0.247.0"
git push origin main
```
Expected: release-please workflow runs; the release PR is regenerated as `chore(main): release 0.247.0`.

- [ ] **Step 3: Verify release-please regenerated the PR at 0.247.0**

Run: `gh pr list --search "release 0.247.0 in:title" --state open`
Expected: one PR titled `chore(main): release 0.247.0`. Capture its number as `$PR`.

- [ ] **Step 4: Enrich the release PR's CHANGELOG + body**

On the release-please branch, edit `CHANGELOG.md`'s 0.247.0 section to the grouped Features/Bug Fixes above, and set the PR body to match:
```bash
gh pr view "$PR" --json headRefName --jq .headRefName   # note the branch
# edit CHANGELOG.md on that branch (Features/Bug Fixes grouping), commit with the standard identity, push
gh pr edit "$PR" --body-file /tmp/koine-0.247.0-notes.md
```

- [ ] **Step 5: Merge the release PR (needs user confirmation — cuts the release)**

Merge the release PR. release-please tags `v0.247.0`, creates the GitHub Release, and — because Tasks 1–3 are on `main` — the same run builds and attaches the CLI + Studio assets.
```bash
gh pr merge "$PR" --squash
```

- [ ] **Step 6: Wait for the build jobs and finalize the published notes**

```bash
gh run watch "$(gh run list --workflow=release-please.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
gh release edit v0.247.0 --notes-file /tmp/koine-0.247.0-notes.md
```
release-please recomputes the GitHub Release body from commits, so this `gh release edit` guarantees the final published notes regardless of that computation.

- [ ] **Step 7: Verify the release**

Run:
```bash
gh release view v0.247.0 --json tagName,assets --jq '{tag: .tagName, assets: [.assets[].name]}'
```
Expected: `tag: v0.247.0`; assets include 3 `koine-v0.247.0-*.{tar.gz,zip}`, 1 `.nupkg`, and the Studio installers (`.dmg`, `.msi`/`.exe`, `.AppImage`/`.deb`). Confirm the release notes show the grouped Features/Bug Fixes + Downloads section.

---

## Self-Review

**Spec coverage:**
- Decision 1 (minor 0.247.0 + enriched notes) → Task 5. ✅
- Decision 2 (both CLI + Studio) → Tasks 2 (CLI), 1+3 (Studio). ✅
- Decision 3 (3 RIDs) → Task 2 matrix + Global Constraints. ✅
- Decision 4 (unsigned + note) → Task 1 (no signing), Task 5 install note. ✅
- Decision 5 (reusable workflow) → Task 1. ✅
- Decision 6 (fold + delete release.yml) → Task 2 (`nupkg` job + `git rm`). ✅
- Decision 7 (prevention guard) → Task 4. ✅
- Trigger-can't-fire constraint → Tasks 2+3 gate on `release_created` inside the release-please run. ✅
- Testing/de-risking (actionlint, workflow_dispatch dry-run) → Task 1 Step 4, Task 2 Step 5/6, Task 4 Step 5. ✅

**Placeholder scan:** No TBD/TODO-in-requirements. The single `# TODO:` in the `nupkg` job is a verbatim carry-over of the existing NuGet-push deferral (explicitly out of scope), not a plan gap.

**Type/name consistency:** reusable workflow inputs `bundle`/`publish`/`tag` are declared in Task 1 and consumed identically in Task 3. Job outputs `release_created`/`tag_name` are declared in Task 2 Step 2 and referenced with the same names in Tasks 2 and 3. Publish-dir path `src/Koine.Cli/bin/publish/<rid>/koine[.exe]` matches the profiles and the existing sidecar-stage step. ✅

**Verification items to confirm during execution (from the spec):**
1. `npm run tauri -- build` is the correct local-CLI invocation (vs `npx tauri build`); confirm on Task 1's first dry-run.
2. Tauri bundle output paths per OS (`bundle/dmg`, `bundle/msi`/`bundle/nsis`, `bundle/appimage`/`bundle/deb`); confirm from the dry-run's "Collected installers" listing and widen the globs if a target dir differs.
3. Whether release-please splits a multi-line squash body into multiple entries (Task 4) — if not, the guard degrades to "don't bundle unrelated issues."
