---
name: get-repo-profile
description: >-
  Generate or load a per-repo configuration profile (`.claude/skills/repo-profile.md`) that the
  issue/PR lifecycle skills — `create-issue`, `implement-issue`, `merge-pr` — read for the
  repo-specific facts they would otherwise hardcode: commit identity, build/test/format/lint commands,
  label taxonomy, integration style (squash/merge/rebase), conflict hot-spots, issue-template location,
  and the project's architecture grain. The whole point is to make those three skills work in ANY
  repository, not just Koine. Those skills normally `cat` the committed profile directly; reach for THIS
  skill when no profile exists yet, when the user wants to PORT those skills to a new repo, "set up the
  repo profile", "make these skills generic", or to refresh/regenerate the profile after the repo's
  toolchain, labels, or CI gates changed — including loose phrasings like "configure this repo for the
  issue skills" or "make create-issue/merge-pr work in my other repo". On first call it inspects the repo
  (build system, CI workflow, `gh` labels, issue templates, git identity, merge style) and writes the
  profile; later calls just read it back. Does NOT file issues, implement code, or merge PRs itself — it
  only produces the config those skills consume.
---

# Resolve the repo profile (config for the issue/PR lifecycle skills)

`create-issue`, `implement-issue`, and `merge-pr` are generic *workflows* wrapped around a thin layer of
**repo-specific facts** — the commit author line, how to build and test, which label means "high
priority", whether the repo squashes or rebases, which files conflict and how to resolve them. Hardcoding
those welds the skills to one repo. This skill lifts them into a single committed file,
**`.claude/skills/repo-profile.md`**, that the three skills read at their preconditions step. Drop the
four skills into a new repo, run this once, and the lifecycle skills speak that repo's language.

The profile is **data, not a skill** — plain markdown with no `SKILL.md`, so the loader ignores it; being
committed, it travels with the repo. Because it exists, the lifecycle skills read it with a plain `cat`
and only fall back to this skill when it's missing — so most of the time this skill isn't even invoked.

## Do this

A bundled script does the deterministic work so you spend tokens on judgement, not probing. Run it from
anywhere in the repo (it anchors to the git root):

```bash
bash .claude/skills/get-repo-profile/scripts/repo-profile.sh show
```

- **It printed the profile** (and no `--refresh` was asked) → **you're done.** Relay the headline values
  (repo slug, commit identity, build/test/format commands, integration style) so the caller sees what's
  in force. Don't regenerate.
- **It printed `NO_PROFILE`** (exit 3), or the user asked to **`--refresh`** / "set up" / "regenerate" →
  this is the rare generation path. **Read `references/generating.md` and follow it.** In short: run
  `scripts/repo-profile.sh detect`, fill `references/profile-template.md` from the facts it emits, write
  the result to `.claude/skills/repo-profile.md`, and report what you wrote + every TODO you left.

## Autonomy contract

Run **hands-off**. The `show` path is a file read — no need for a task list or precondition ceremony. The
generation path is best-effort inference, not interrogation: fill what `detect` proves, and for anything
it couldn't (a `TODO:` line in its output) write a clearly-marked `<!-- TODO: ... -->` placeholder and
flag it in the report rather than stopping. A profile with a few honest TODOs beats no profile; never
invent a value you couldn't verify — a wrong build command or commit identity is worse than a flagged
blank. Stop only for a real blocker: not inside a git repo (nothing to profile — `detect` exits 4), or
`gh` unauthenticated *and* the gh-only facts can't be read another way (tell the user to run
`! gh auth login -h github.com`).

## Inputs

- **`--refresh`** — regenerate even if a profile exists (re-detect everything; preserve any human-edited
  TODO answers you can still see in the current file).
- A path argument — profile a repo other than the current directory (pass it as the `[dir]` arg to the
  script: `repo-profile.sh show /path/to/repo`).
