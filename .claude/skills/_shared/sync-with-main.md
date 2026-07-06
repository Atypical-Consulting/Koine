# Sync a branch with `main` and resolve conflicts

Shared procedure for the issue/PR lifecycle skills. `implement-issue` reads it before the ready-flip
(Step 8); `merge-pr` reads it when the merge state reports `BEHIND`/`DIRTY` in its corrections loop
(Step 4). The two skills add their own trigger framing; the procedure itself lives **here**, once.

Throughout, `git <commit-identity>` is the author line from the repo profile's *Commit identity*
(its `-c user.email=… -c user.name="…"` flags) — substitute it in the merge/commit commands so the
auto-created merge commit carries the right identity too (it's squashed away at landing, but the rule
still holds).

---

## Why merge, not rebase

When the profile's *Integration style* is **squash-merge**, merge `main` into the branch — don't
rebase. The branch's history is collapsed to a single commit at landing anyway, so:

- a **merge** resolves each conflict **once**, needs **no force-push**, and the throwaway merge commit
  vanishes when the PR squashes;
- a **rebase** replays every conflict per-commit and needs `git push --force-with-lease` — only worth
  it if the repo actually rebases or merge-commits (follow the profile's *Integration style* then).

```bash
git fetch origin main
git <commit-identity> merge origin/main
```

Raw `git fetch`/`git push` can be sandbox-blocked while `gh` works — see the profile's *Environment
gotchas* for the re-run-with-sandbox-disabled note. Local git (the merge itself, conflict resolution,
`commit`) needs no network.

- **"Already up to date" / a clean merge** → skip to *Finish and verify*.
- **Conflicts** → resolve them per the rule-of-thumb below.

## Resolving conflicts — the rule-of-thumb

Most conflicts are mechanical and have one right answer. The profile's *Conflict hot-spots* table
lists them **per file** with the resolution for each — read it and resolve those yourself. The
resolution *shapes* it encodes, so you can reason about a file the table doesn't name:

- **union** additive files (docs, changelogs, test files, additive code) — keep **both** sides' new
  sections/methods/usings/tests; dropping a sibling PR's line loses real work, and the build catches a
  genuine duplicate or signature clash.
- **regenerate** derived files (snapshots, lockfiles, other generated artifacts) — do **not** hand-merge
  them. Take *either* side to clear the conflict, then regenerate (re-run the affected test and accept
  the fresh snapshot; reinstall deps to rebuild the lockfile). The regenerated artifact is ground truth;
  a hand-stitched one will mismatch.
- **take-the-higher** for a monotonic value (a version bump) — never stack both into a double increment;
  if both sides bumped to the same number, keep one.
- **same logic edited on both sides** is a real **semantic** conflict, not a mechanical one — resolve it
  by understanding *both* intents (a parallel PR's work is as real as yours), or, if picking a side would
  silently drop the other's work and you can't choose with confidence, **stop and surface it** with both
  sides shown rather than guessing (per each skill's Autonomy contract).

## Finish and verify

A clean **text** merge is not a clean **semantic** merge — `main` may have renamed a symbol your branch
still calls, or two unioned methods may now clash. Prove it builds before you push, with the profile's
*Build* command (plus the affected test filters; the full suite may need a prerequisite the profile
flags as CI-only):

```bash
git add -A
git <commit-identity> commit --no-edit   # completes the merge
# run the profile's Build command + the affected test filters
git push
```

Never push a merge you haven't at least built. If another PR lands *after* you sync but before yours
merges, you may have to re-run this whole procedure — it's cheap, and a re-sync right before merge is
the surest path to a clean integration.
