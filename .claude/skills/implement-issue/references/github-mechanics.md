# GitHub mechanics for `implement-issue`

The fiddly, easy-to-get-wrong `gh`/`jq`/`git` snippets the main workflow leans on. Read this when
you hit any of: resolving the issue from a weird input, locating the plan (in the issue body or, on
older issues, a comment), ticking a single task's checkboxes without touching the others, or resuming
onto an existing branch/PR.

Throughout, `{owner}/{repo}` is a literal `gh` placeholder it resolves from the repo's `origin`
(the repo the profile names) — you can paste it as-is. And `git <commit-identity>` is shorthand for the
author line from the profile's *Commit identity* (SKILL.md Step 1) — substitute its `-c user.email=… -c
user.name="…"` flags in the commit/merge commands below.

---

## 1. Resolve the issue number from whatever the user gave you

The user may pass a bare number, an issue URL, or a link to the plan comment. Normalize to a number.

```bash
ARG="$1"   # e.g. 21  |  https://github.com/<owner>/<repo>/issues/21
           #          |  https://github.com/<owner>/<repo>/issues/21#issuecomment-3098…
ISSUE=$(printf '%s' "$ARG" | grep -oE '[0-9]+' | head -1)   # first run of digits = issue number
```

If the link is a comment permalink (`#issuecomment-<id>`), you can also pull that comment id
directly and skip the search in §2:

```bash
COMMENT_ID=$(printf '%s' "$ARG" | sed -n 's/.*issuecomment-\([0-9]*\).*/\1/p')   # empty if not a comment link
```

Confirm the issue exists and is the right one before doing anything destructive:

```bash
gh issue view "$ISSUE" --json number,title,state --jq '"\(.number) [\(.state)] \(.title)"'
```

---

## 2. Locate the plan (issue body first, comment fallback)

`create-issue` writes the plan into the **issue body**, so look there first — and when the plan lives
in the body, you tick boxes by PATCHing the issue itself (§4), no comment id needed. Only fall back to
the comment trail for issues filed by older versions.

```bash
# Preferred: the plan is in the description.
gh api "repos/{owner}/{repo}/issues/$ISSUE" --jq .body > /tmp/koine-plan-$ISSUE.md
if grep -q '🛠️ Implementation plan' /tmp/koine-plan-$ISSUE.md; then
  PLAN_SRC=body
else
  PLAN_SRC=comment
fi
```

When `PLAN_SRC=comment`, you need the comment's **numeric REST id** (the database id) — that's what
the PATCH endpoint in §4 edits. `gh issue view --json comments` returns GraphQL **node ids** (`IC_kw…`),
which the REST PATCH rejects. Always go through the REST comments endpoint:

```bash
if [ "$PLAN_SRC" = comment ]; then
  # All comments, newest-relevant plan comment wins. The marker is the bold header create-issue posted.
  # --slurp piped to a separate jq (gh's --jq can't combine with --slurp) flattens every page's
  # array into one list before `last` picks the actual latest match — `--paginate --jq` alone runs
  # the filter independently per page and concatenates the results, so `last` only sees whichever
  # page happens to print after the others.
  PLAN_COMMENT_ID=$(gh api "repos/{owner}/{repo}/issues/$ISSUE/comments" --paginate --slurp \
    | jq -r '[.[][] | select(.body | contains("🛠️ Implementation plan"))] | last | .id')

  # Fallback if no marker (older/hand-written plan): latest comment that has checkbox lines.
  if [ -z "$PLAN_COMMENT_ID" ]; then
    PLAN_COMMENT_ID=$(gh api "repos/{owner}/{repo}/issues/$ISSUE/comments" --paginate --slurp \
      | jq -r '[.[][] | select(.body | (contains("- [ ]") or contains("- [x]")))] | last | .id')
  fi

  # Nothing in the body AND nothing in comments? Stop — there is no plan to execute (Autonomy contract).
  [ -z "$PLAN_COMMENT_ID" ] && { echo "No implementation plan on #$ISSUE"; exit 1; }

  # Pull the comment body to the same working file.
  gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" --jq .body > /tmp/koine-plan-$ISSUE.md
fi
```

`--paginate` matters: a busy issue can have >30 comments and the plan may not be on page one. And it
must be `--paginate --slurp` piped to a separate `jq`, not `--paginate --jq` — `gh api`'s `--jq` runs
its filter independently *per page* and concatenates the results rather than merging pages first, so a
`last | .id` filter picks the last match on whichever page happens to print last, not the true latest
match across the whole comment history; `--slurp` (which can't combine with `--jq`) flattens every
page into one array before `jq` sees it. Either way `/tmp/koine-plan-$ISSUE.md` now holds the plan
text; a body-sourced file also carries the template fields and collapsed brainstorm/spec above it,
which is fine — §3/§4 only ever touch `### Task` checkbox lines.

---

## 3. Decide which tasks are already done (resume + progress)

A task is **done** when every checkbox in its block is ticked. Quick whole-comment progress:

```bash
done=$(grep -c '^- \[x\]' /tmp/koine-plan-$ISSUE.md)
todo=$(grep -c '^- \[ \]' /tmp/koine-plan-$ISSUE.md)
echo "$done done / $((done+todo)) steps"
[ "$todo" -eq 0 ] && echo "All tasks already complete."
```

To find the first unchecked task, scan `### Task` headings and look for the first block that still
contains a `- [ ]` line. Implement from there; skip blocks that are all `- [x]`.

---

## 4. Tick one task's checkboxes — precisely

**Never** `sed -i 's/\[ \]/[x]/g'` the whole file — that ticks unfinished tasks too and turns the
issue's progress board into a lie. Flip only the lines belonging to the task you just committed.

Preferred: edit `/tmp/koine-plan-$ISSUE.md` line by line with the **Edit tool**, changing each of
that task's `- [ ] **Step k:** …` lines to `- [x] **Step k:** …`. The step text is unique, so each
Edit targets exactly one line and fails loudly if something drifted — which is the safety you want.

Then PATCH the whole body back — the **issue** when the plan lives in its description, or the
**comment** on a legacy issue. Use `jq -Rs` to wrap the file as a JSON string so backticks, quotes,
and newlines survive intact:

```bash
if [ "$PLAN_SRC" = body ]; then
  jq -Rs '{body: .}' /tmp/koine-plan-$ISSUE.md \
    | gh api "repos/{owner}/{repo}/issues/$ISSUE" -X PATCH --input -
else
  jq -Rs '{body: .}' /tmp/koine-plan-$ISSUE.md \
    | gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" -X PATCH --input -
fi
```

`--input -` reads the JSON body from stdin; this is far more robust than `-f body=...` for large,
Markdown-heavy bodies. The body-sourced file holds the *whole* description, so flipping only this
task's checkbox lines and PATCHing it back leaves the template fields and brainstorm/spec untouched.
After the PATCH, the issue re-renders with this task's boxes ticked — and because the plan is in the
body, the progress meter advances too.

Re-fetch isn't needed within a single run — you own the source and hold the canonical copy in the
temp file. (If you ever suspect a concurrent edit, re-fetch, re-apply your flips, re-PATCH.)

---

## 5. Worktree, branch, draft PR — and reusing them on resume

Branch naming ties the worktree, branch, and PR to the issue:

```bash
SLUG=$(gh issue view "$ISSUE" --json title --jq .title \
  | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
BRANCH="feat/$ISSUE-$SLUG"
```

Before creating anything, check whether a prior run already set things up (resume):

```bash
git worktree list | grep "$BRANCH"                       # worktree already present?
gh pr list --head "$BRANCH" --json number,url,isDraft --jq '.[0]'   # PR already open?
```

If they exist, `cd` into the worktree and reuse the PR — don't open a second one. Otherwise create
the worktree via `superpowers:using-git-worktrees`, then the draft PR (empty scaffold commit so the
branch is ahead of `main`):

```bash
git <commit-identity> \
  commit --allow-empty -m "chore(#$ISSUE): scaffold draft PR"
git push -u origin "$BRANCH"
gh pr create --draft --base main --head "$BRANCH" \
  --title "<type>(<scope>): <subject> (#$ISSUE)" --body "<body, Closes #$ISSUE>"
# Title needs a Conventional Commits prefix (feat|fix|docs|…) — CI's pr-title-lint rejects a bare
# title, and the squash-merged title feeds release-please. Never pass the issue title through verbatim.
```

---

## 6. Mark ready (only after green)

```bash
gh pr ready "$PR_NUMBER"          # number from `gh pr create`, or `gh pr list --head "$BRANCH"`
```

`gh pr ready` with no extra flag flips draft → ready-for-review. There's no separate "approve" — the
human reviewer takes it from there.

---

## 7. Sync with `main` and resolve conflicts (before the ready-flip)

Issues run in parallel and `main` advances while the PR sits in draft, so it drifts out of
mergeability. Before the ready-flip, merge the latest `main` into the branch, resolve conflicts, and
re-verify on the merged tree.

The procedure itself — merge-not-rebase, the union/regenerate/take-the-higher rule-of-thumb keyed off
the profile's *Conflict hot-spots* table, and the finish-and-verify step — is shared with `merge-pr`
and lives in [`../../_shared/sync-with-main.md`](../../_shared/sync-with-main.md). Follow it, then
continue to Step 9 (full build/tests + format gate) — never push a merge you haven't at least built.

---

## Gotchas, collected

- **Body first, comment fallback.** `create-issue` writes the plan into the issue **body** now, so
  `PLAN_SRC=body` is the normal path and you PATCH the issue (`.../issues/$ISSUE`). The comment path
  is only for issues filed by older versions. Ticking a body plan also advances the progress meter,
  which a comment plan never did.
- **Node id vs REST id (comment path only).** `gh issue view --json comments` → GraphQL `IC_kw…` ids;
  the PATCH endpoint needs the **numeric** id from `gh api .../comments`. Mixing them up is the #1 way
  the comment tick fails. Irrelevant when the plan is in the body.
- **Pagination (comment path only).** Always `--paginate` the comments call; the plan comment may be
  past comment 30.
- **The emoji marker is the anchor.** `create-issue` writes `## 🛠️ Implementation plan` (older issues:
  a `**🛠️ Implementation plan**` comment). Match on the `🛠️ Implementation plan` substring; keep the
  §2 checkbox fallback for hand-written plans.
- **`jq -Rs` for the body.** Hand-building the JSON (or `-f body=`) mangles plans full of backticks,
  code fences, and `<` `>`. `jq -Rs '{body:.}'` is lossless.
- **Whole-file sed is forbidden.** Tick per task, not per repo — see §4.
- **Empty commit is intentional.** It exists only so a draft PR can open before any code lands; the
  first real task commit immediately makes it meaningful. Don't squash it away mid-run.
- **Sync before ready — merge, not rebase.** The full procedure (and the why) is in
  [`../../_shared/sync-with-main.md`](../../_shared/sync-with-main.md), summarized at §7; the one thing
  to remember here is that a clean text merge can still be a broken compile, so re-build after resolving.
- **Raw `git` network ops can be sandbox-blocked while `gh` works.** `gh api`/`gh pr …` succeed, but
  `git fetch`/`git push` (every per-task push in Step 6, and the `git fetch origin main` in Step 8) may
  time out with `Failed to connect to github.com port 443`. `gh` proves the host is reachable, so it's a
  sandbox restriction on git's traffic, not an outage — re-run just those commands with the sandbox
  disabled. Local git (`merge`, `commit`, conflict resolution, `worktree`) needs no network and runs
  normally. Use `git -C <path>` rather than `cd <path> && …` — a `cd` in a compound command gets reset
  between calls here.
