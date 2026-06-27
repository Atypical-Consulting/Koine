---
name: get-repo-profile
description: >-
  Generate or load a per-repo configuration profile (`.claude/skills/repo-profile.md`) that the
  issue/PR lifecycle skills — `create-issue`, `implement-issue`, `merge-pr` — read for the
  repo-specific facts they would otherwise hardcode: commit identity, build/test/format/lint commands,
  label taxonomy, integration style (squash/merge/rebase), conflict hot-spots, issue-template location,
  and the project's architecture grain. The whole point is to make those three skills work in ANY
  repository, not just Koine. ALWAYS reach for this whenever you're about to run `create-issue` /
  `implement-issue` / `merge-pr` and no profile exists yet, whenever the user wants to PORT those skills
  to a new repo, "set up the repo profile", "make these skills generic", or asks to refresh/regenerate
  the profile after the repo's toolchain, labels, or CI gates changed — including loose phrasings like
  "configure this repo for the issue skills" or "make create-issue/merge-pr work in my other repo". On
  first call it inspects the repo (build system, CI workflow, `gh` labels, issue templates, git identity,
  merge style) and writes the profile; later calls just read it back. Does NOT file issues, implement
  code, or merge PRs itself — it only produces the config those skills consume.
---

# Resolve the repo profile (config for the issue/PR lifecycle skills)

## What this does

`create-issue`, `implement-issue`, and `merge-pr` are generic *workflows* wrapped around a thin layer
of **repo-specific facts** — the commit author line, how to build and test, which label means "high
priority", whether the repo squashes or rebases, which files conflict and how to resolve them.
Hardcoding those welds the skills to one repo. This skill lifts them into a single committed file,
**`.claude/skills/repo-profile.md`**, that the three skills read at their preconditions step. Drop the
four skills into a new repo, run this once, and the lifecycle skills speak that repo's language.

The profile is **data, not a skill** — a plain markdown file with no `SKILL.md`, so the loader ignores
it; being committed, it travels with the repo. **Idempotent:** the first call detects-and-writes; later
calls just read it back. Only `--refresh` (or an explicit ask) regenerates it.

## Autonomy contract

Run **hands-off**. Detection is best-effort inference, not interrogation: inspect the repo, fill what
you can prove, and for anything you can't determine write a clearly-marked `<!-- TODO: ... -->`
placeholder and flag it in the report rather than stopping. Stop only for a real blocker:

- Not inside a git repository (nothing to profile).
- `gh` unauthenticated *and* the facts you need (labels, repo slug, merge style) can't be read another way — say so and tell the user to run `! gh auth login -h github.com`.

A profile with a few honest TODOs beats no profile. Never invent a value you couldn't verify — a wrong
build command or commit identity is worse than a flagged blank.

## Inputs

- **`--refresh`** (optional) — regenerate even if a profile exists (re-detect everything, preserving any human-edited TODO answers you can still see).
- A path argument (optional) — profile a repo other than the current directory.

## Checklist

Create a task per item and work them in order.

1. **Locate the profile** — if `.claude/skills/repo-profile.md` exists and `--refresh` wasn't asked, read it, return its values, stop (fast path).
2. **Preconditions** — confirm you're in a git repo; check `gh` (needed for labels / slug / merge style).
3. **Detect the facts** — repo identity, commit identity, build system + commands, CI gates, integration style, labels, issue templates, conflict hot-spots, architecture grain (Step 3).
4. **Write the profile** — fill `references/profile-template.md`'s schema, save to `.claude/skills/repo-profile.md`.
5. **Report** — where it wrote, the key detected values, every TODO left for the user.

---

## Step 1 — Locate the profile (fast path)

```bash
PROFILE=.claude/skills/repo-profile.md
if [ -f "$PROFILE" ]; then echo "profile exists"; else echo "no profile — will generate"; fi
```

If it exists and the user didn't ask to refresh: **read it and return.** Surface its headline values
(commit identity, build/test/format commands, integration style) so the caller sees what's in force.
Don't regenerate. If missing, or `--refresh` was passed, continue to detection.

## Step 2 — Preconditions

```bash
git rev-parse --is-inside-work-tree            # must print true
gh api user --jq .login                        # a login, or 401 → not authed
gh repo view --json nameWithOwner --jq .nameWithOwner   # the owner/repo slug
```

Not a git repo → stop. `gh` unauthenticated → you can still detect most things from the filesystem and
git, so continue, but mark the gh-only fields (labels, merge style via branch protection) TODO and tell
the user to authenticate for a complete profile.

## Step 3 — Detect the facts

Infer each field from evidence. The table says where to look; `references/profile-template.md` holds the
full schema and a worked Koine example.

| Field | How to detect |
|---|---|
| **Repo slug** | `gh repo view --json nameWithOwner`. |
| **Default branch** | `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` (usually `main`). |
| **Commit identity** | A workspace/repo `CLAUDE.md` rule wins if present (grep for a `user.email=`/commit-identity line). Otherwise `git config user.email` / `user.name`, cross-checked against recent `git log` authors. State the source. |
| **Build system + commands** | Detect by marker files (below), then read the real scripts. Don't guess the test command — read it. |
| **CI gates** | `.github/workflows/*.yml` — the exact `build` / `test` / `format`/`lint` commands CI runs and **fails on**. These are the gates `implement-issue` Step 9 and `merge-pr` Step 4 must satisfy locally. |
| **Integration style** | Branch protection: `gh api repos/{owner}/{repo}/branches/<default> --jq .protection` for `required_*`; and inspect history — squash leaves `… (#N)` subjects on a linear `main`; merge commits → merge; linear with none → rebase. |
| **Label taxonomy** | `gh label list --limit 200` → classify into type (bug/enhancement), priority tiers, effort sizes, scope/area labels. Record the *exact* live strings (e.g. `priority: high`), since the skills apply them verbatim. |
| **Issue templates** | `ls .github/ISSUE_TEMPLATE/` — record which forms exist so `create-issue` reconstructs them. |
| **Conflict hot-spots** | Derive from the build system: version file, changelog, dependency lockfile, generated/snapshot files. Note the resolution rule per file (union / regenerate / take-higher). |
| **Architecture grain / invariants** | Best-effort from `CLAUDE.md` / `README` — any "keep X target-agnostic", "touch layers in order", "never do Y" rules that should shape a plan. Blank-with-TODO is fine if the repo states none. |
| **Test framework + filter idiom** | From the test runner: how to run *one* suite fast (the per-task filter the lifecycle skills rely on) and any local-vs-CI caveats. |
| **Worktree home** | The repo's conventional ignored worktree dir if any (e.g. `.claude/worktrees/`), else the skills' default. |
| **Environment gotchas** | Anything that bites automation: sandboxed git network, a workload that must be installed, CI-only steps. Check a repo `CLAUDE.md` and the memory index. |

**Build-system detection (first match wins; a monorepo may have several — record each relevant one, scoped by path):**

| Marker file(s) | Stack | Typical commands to read/record |
|---|---|---|
| `*.slnx`, `*.sln`, `*.csproj` | .NET | `dotnet build` · `dotnet test` (+ `--filter`) · `dotnet format <sln> --verify-no-changes` |
| `package.json` | Node | read `scripts`: `build`/`test`/`lint`/`format`; detect pnpm/yarn/npm by lockfile |
| `Cargo.toml` | Rust | `cargo build` · `cargo test` · `cargo fmt --check` · `cargo clippy` |
| `go.mod` | Go | `go build ./...` · `go test ./...` · `gofmt -l` / `go vet` |
| `pyproject.toml`, `setup.py` | Python | read the runner (pytest/unittest); `ruff`/`black --check`; the env manager (uv/poetry/pip) |
| `pom.xml`, `build.gradle` | JVM | `mvn`/`gradle` `verify`/`test`; spotless/checkstyle |

## Step 4 — Write the profile

Fill the schema in `references/profile-template.md` with the detected values and write it to
`.claude/skills/repo-profile.md`. Keep every field; for undetectable ones leave an explicit
`<!-- TODO: <what's needed and where to find it> -->`. Read it back to confirm it wrote.

```bash
mkdir -p .claude/skills
# (write the filled template to .claude/skills/repo-profile.md, then:)
test -f .claude/skills/repo-profile.md && echo "profile written"
```

The file is meant to be **committed** — it's repo config, like `.github/` or `settings.json`. Mention
that in the report; don't commit it yourself unless asked (committing is the lifecycle skills' job).

## Step 5 — Report

Short and concrete:
- Where the profile lives and whether you generated it or read it back.
- The headline values: repo slug, commit identity (+ source), build/test/format commands, integration style, label axes found.
- Every `TODO` you left — these are facts you couldn't prove, not optional.
- A reminder that the three lifecycle skills read this file at their preconditions step, and that committing it makes it travel with the repo.

---

## Notes on quality

- **Read, don't guess.** Read the CI workflow for the real gates, `package.json` scripts for the real test command, `gh label list` for the real strings. An inferred-but-wrong build command silently breaks every downstream skill.
- **TODOs beat fabrication.** A flagged blank is honest and fixable; a confident wrong value is a landmine. Never write a commit identity or merge style you didn't verify.
- **Idempotent by design.** The fast path returns the existing file untouched; only `--refresh` regenerates, and even then preserve human-filled TODO answers where you can.
- **The profile is the source of truth; the skills' inline values are defaults.** Where a lifecycle skill shows a concrete value (a commit email, `dotnet test`, the `studio` label), that's the *Koine* profile's value as a worked example — another repo's profile overrides it.
