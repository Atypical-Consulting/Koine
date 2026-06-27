#!/usr/bin/env bash
# auto-dev reconcile — one-shot GitHub ground truth for the supervisor loop (Step 4).
#
# Why this exists: on EVERY wake the supervisor must reconcile its slots against the
# real merge state on GitHub. Doing that as natural-language reasoning (emit two gh
# queries + jq, read them, classify) is a deterministic sequence re-derived every tick —
# and every supervisor turn re-reads the whole context from cache (the dominant cost).
# Collapsing the query+classify into one command removes those turns. The supervisor
# still does the judgment (cross-ref the state file, decide end/refill/nudge/escalate).
#
# Usage: scripts/reconcile.sh
# Prints: open PRs (draft/ready + mergeStateStatus) and recently merged PRs.

set -euo pipefail

echo "== OPEN PRs (number | DRAFT/READY | mergeState | branch | title) =="
gh pr list --state open --limit 50 \
  --json number,isDraft,headRefName,mergeStateStatus,title \
  --jq '.[] | "#\(.number)\t\(if .isDraft then "DRAFT" else "READY" end)\t\(.mergeStateStatus)\t\(.headRefName)\t\(.title)"' \
  | sort -n || true

echo
echo "== RECENTLY MERGED (last 10: number | mergedAt | title) =="
gh pr list --state merged --limit 10 \
  --json number,title,mergedAt \
  --jq '.[] | "#\(.number)\t\(.mergedAt)\t\(.title)"' || true
