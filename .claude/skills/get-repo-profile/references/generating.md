# Generating the profile (the rare path)

You're here because `repo-profile.sh show` printed `NO_PROFILE`, or the user asked to `--refresh` / set up
/ regenerate. The goal: produce `.claude/skills/repo-profile.md` from evidence, not guesswork. The
deterministic gathering is already scripted — your job is interpretation and synthesis.

## 1. Gather the facts in one pass

```bash
bash .claude/skills/get-repo-profile/scripts/repo-profile.sh detect
```

This emits a compact, labelled facts block: repo slug, default branch, commit identity (and any
`CLAUDE.md` rule that overrides git config), build-system marker files, the command lines CI runs, branch
protection + recent commit subjects, the live label list, issue templates, conflict-hot-spot candidates,
and architecture-grain hits from `CLAUDE.md`/`README`. Any field the probe couldn't answer is printed as
`TODO: <hint>` — carry those straight through to `<!-- TODO -->` markers in the profile.

If `detect` exits 4 you're not in a git repo — stop, nothing to profile. If the labels / branch-protection
lines say the gh probe failed, `gh` is unauthenticated: detect-everything-else, mark the gh-only fields
TODO, and tell the user to run `! gh auth login -h github.com` for a complete profile.

## 2. Interpret the facts into the schema

Open `references/profile-template.md` — it holds the full schema and a worked Koine example showing the
grain each field wants. Most fields map straight from `detect`'s output; these need a judgement call:

| Field | How to turn facts into the value |
|---|---|
| **Commit identity** | If `detect` surfaced a `CLAUDE.md` commit rule, that **wins** over git config — record it and name the source. Otherwise use git config, cross-checked against the recent-log authors. |
| **Build/test/format commands** | Don't transcribe CI noise verbatim — pick the *real gates* from the CI-gates lines (the `build`, `test`, and `--verify-no-changes`/`--check` commands CI fails on) and the canonical local commands for the stack (table below). Read `package.json` scripts (detect prints them) for Node repos rather than guessing. |
| **Single-suite filter** | The fast per-task command the lifecycle skills lean on (e.g. `dotnet test --filter "FullyQualifiedName~<Suite>"`, `cargo test <name>`, `pytest -k`, `go test ./pkg/...`). |
| **Integration style** | Infer from `detect`'s subjects + branch protection: `… (#N)` subjects on a linear `main` ⇒ **squash**; merge commits ⇒ **merge**; linear with neither ⇒ **rebase**. |
| **Labels** | Classify the live strings detect listed into *type* (bug/enhancement), *priority* tiers, *effort* sizes, and *scope/area*. Record the **exact** strings — the skills apply them verbatim. |
| **Conflict hot-spots** | From the candidates + the build system: version file (**take-higher**), changelog/docs (**union**), lockfiles & generated/snapshot files (**regenerate**, never hand-merge). State the rule per file. |
| **Architecture grain** | Distil the `CLAUDE.md`/`README` hits into the few "keep X agnostic / touch layers in order / never do Y" rules that should shape a plan. Blank-with-TODO is fine if the repo states none. |

**Build-system → canonical commands** (the stack is in detect's marker-files section):

| Stack | Build · Test · Format/lint gate |
|---|---|
| .NET (`*.slnx`/`*.sln`/`*.csproj`) | `dotnet build` · `dotnet test` (+ `--filter`) · `dotnet format <sln> --verify-no-changes` |
| Node (`package.json`) | read `scripts` for `build`/`test`/`lint`/`format`; pick the runner from the lockfile (pnpm/yarn/npm) |
| Rust (`Cargo.toml`) | `cargo build` · `cargo test` · `cargo fmt --check` · `cargo clippy` |
| Go (`go.mod`) | `go build ./...` · `go test ./...` · `gofmt -l` / `go vet` |
| Python (`pyproject.toml`/`setup.py`) | the runner (pytest/unittest) · `ruff`/`black --check`; note the env manager (uv/poetry/pip) |
| JVM (`pom.xml`/`build.gradle`) | `mvn`/`gradle` `verify`/`test` · spotless/checkstyle |

A monorepo may show several markers — record each relevant one, scoped by path.

## 3. Write and report

Fill the schema and write it:

```bash
mkdir -p .claude/skills
# (write the filled template to .claude/skills/repo-profile.md)
bash .claude/skills/get-repo-profile/scripts/repo-profile.sh show >/dev/null && echo "profile written"
```

Keep **every** schema section; leave an explicit `<!-- TODO: <what's needed and where to find it> -->`
for anything `detect` couldn't prove. On `--refresh`, preserve human-filled TODO answers you can still see
in the existing file.

Then report, short and concrete:
- Where it lives and whether you generated it or read it back.
- The headline values: repo slug, commit identity (+ source), build/test/format commands, integration
  style, label axes found.
- Every `TODO` you left — these are facts you couldn't prove, not optional.
- That the file is meant to be **committed** (it's repo config, like `.github/`); don't commit it yourself
  unless asked — committing is the lifecycle skills' job. Once committed it travels with the repo and the
  lifecycle skills read it with a plain `cat`.

## Why it's built this way

- **Read, don't guess.** `detect` reads the CI workflow, `package.json` scripts, and `gh label list` so
  the values are the repo's real ones. An inferred-but-wrong build command silently breaks every
  downstream skill.
- **TODOs beat fabrication.** A flagged blank is honest and fixable; a confident wrong value is a
  landmine. Never write a commit identity or merge style you didn't verify.
- **The profile is the source of truth; the skills' inline values are defaults.** Where a lifecycle skill
  shows a concrete value (a commit email, `dotnet test`, the `studio` label), that's the *Koine* profile's
  value as a worked example — another repo's profile overrides it.
