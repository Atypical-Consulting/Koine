# Shared Preconditions: Profile Load, Auth, & Commit Identity

This reference is used by every lifecycle skill to establish preconditions at Step 1. Each skill
links here and adds only its skill-specific extras.

## Load the repo profile

The repo profile is the single source of truth for repo-specific facts — commit identity, labels, CI
gates, conflict hot-spots, architecture grain. Read it directly from the committed file
**`.claude/skills/repo-profile.md`**:

```bash
cat .claude/skills/repo-profile.md
```

Only if that file is **missing** (or the user asks to refresh it), run **`get-repo-profile`** to
generate it first, then read it. If you genuinely can't obtain it, say so in the report rather than
inventing repo specifics.

## Verify authentication

Check that your `gh` authentication works and you're targeting the correct repo:

```bash
gh api user --jq .login                                  # prints a login, or 401 → not authed
gh repo view --json nameWithOwner --jq .nameWithOwner    # confirm it's the repo the profile names
```

If the auth check fails with a 401 error, stop and tell the user to run this in the prompt:

```bash
! gh auth login -h github.com
```

The `!` prefix runs the command in the current session, so the token lands in your environment. Then
re-check the `gh api user` command before continuing.

## Commit identity shorthand

Throughout the skill's commands, **`git <commit-identity>`** is a shorthand that expands to the
author line from the profile's *Commit identity* section. It looks like:

```bash
git -c user.email=<email> -c user.name="<name>"
```

Substitute it in every commit/merge/rebase command. Example:

```bash
git <commit-identity> commit -m "message here"
git <commit-identity> merge origin/main
```

This ensures commits are authored with the canonical identity (usually GitHub, not work email).

---

**Each lifecycle skill's Step 1 links to this file and adds only its own required profile sections.**
