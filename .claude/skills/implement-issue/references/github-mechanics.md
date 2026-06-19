# GitHub mechanics for `implement-issue`

The fiddly, easy-to-get-wrong `gh`/`jq`/`git` snippets the main workflow leans on. Read this when
you hit any of: resolving the issue from a weird input, locating the right plan comment, ticking a
single task's checkboxes without touching the others, or resuming onto an existing branch/PR.

Throughout, `{owner}/{repo}` is a literal `gh` placeholder it resolves from the repo's `origin`
(here `Atypical-Consulting/Koine`) — you can paste it as-is.

---

## 1. Resolve the issue number from whatever the user gave you

The user may pass a bare number, an issue URL, or a link to the plan comment. Normalize to a number.

```bash
ARG="$1"   # e.g. 21  |  https://github.com/Atypical-Consulting/Koine/issues/21
           #          |  https://github.com/Atypical-Consulting/Koine/issues/21#issuecomment-3098…
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

## 2. Locate the implementation-plan comment (and its REST id)

You need the comment's **numeric REST id** (the database id) — that's what the PATCH endpoint in §4
edits. `gh issue view --json comments` returns GraphQL **node ids** (`IC_kw…`), which the REST PATCH
will reject. Always go through the REST comments endpoint:

```bash
# All comments, newest-relevant plan comment wins. The marker is the bold header create-issue posts.
PLAN_COMMENT_ID=$(gh api "repos/{owner}/{repo}/issues/$ISSUE/comments" --paginate \
  --jq 'map(select(.body | contains("🛠️ Implementation plan"))) | last | .id')

# Fallback if no marker (older/hand-written plan): latest comment that has checkbox lines.
if [ -z "$PLAN_COMMENT_ID" ]; then
  PLAN_COMMENT_ID=$(gh api "repos/{owner}/{repo}/issues/$ISSUE/comments" --paginate \
    --jq 'map(select(.body | (contains("- [ ]") or contains("- [x]")))) | last | .id')
fi

# Nothing? Stop — there is no plan to execute (Autonomy contract).
[ -z "$PLAN_COMMENT_ID" ] && { echo "No implementation-plan comment on #$ISSUE"; exit 1; }

# Pull the body to a working file.
gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" --jq .body > /tmp/koine-plan-$ISSUE.md
```

`--paginate` matters: a busy issue can have >30 comments and the plan may not be on page one.

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

Then PATCH the whole body back. Use `jq -Rs` to wrap the file as a JSON string so backticks,
quotes, and newlines survive intact:

```bash
jq -Rs '{body: .}' /tmp/koine-plan-$ISSUE.md \
  | gh api "repos/{owner}/{repo}/issues/comments/$PLAN_COMMENT_ID" -X PATCH --input -
```

`--input -` reads the JSON body from stdin; this is far more robust than `-f body=...` for large,
Markdown-heavy bodies. After the PATCH, the issue re-renders with this task's boxes ticked.

Re-fetch isn't needed within a single run — you own the comment and hold the canonical copy in the
temp file. (If you ever suspect a concurrent edit, re-fetch the body, re-apply your flips, re-PATCH.)

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
git -c user.email=phmatray@gmail.com -c user.name="Philippe Matray" \
  commit --allow-empty -m "chore(#$ISSUE): scaffold draft PR"
git push -u origin "$BRANCH"
gh pr create --draft --base main --head "$BRANCH" --title "<title>" --body "<body, Closes #$ISSUE>"
```

---

## 6. Mark ready (only after green)

```bash
gh pr ready "$PR_NUMBER"          # number from `gh pr create`, or `gh pr list --head "$BRANCH"`
```

`gh pr ready` with no extra flag flips draft → ready-for-review. There's no separate "approve" — the
human reviewer takes it from there.

---

## Gotchas, collected

- **Node id vs REST id.** `gh issue view --json comments` → GraphQL `IC_kw…` ids; the PATCH endpoint
  needs the **numeric** id from `gh api .../comments`. Mixing them up is the #1 way the tick fails.
- **Pagination.** Always `--paginate` the comments call; the plan comment may be past comment 30.
- **The emoji marker is the anchor.** `create-issue` posts `**🛠️ Implementation plan**`. Match on
  the `🛠️ Implementation plan` substring; keep the §2 checkbox fallback for older issues.
- **`jq -Rs` for the body.** Hand-building the JSON (or `-f body=`) mangles plans full of backticks,
  code fences, and `<` `>`. `jq -Rs '{body:.}'` is lossless.
- **Whole-file sed is forbidden.** Tick per task, not per repo — see §4.
- **Empty commit is intentional.** It exists only so a draft PR can open before any code lands; the
  first real task commit immediately makes it meaningful. Don't squash it away mid-run.
