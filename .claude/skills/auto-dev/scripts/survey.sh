#!/usr/bin/env bash
# auto-dev survey — one-shot eligible-issue queue for Step 2 and the every-~5-merges re-survey.
#
# Why this exists: the survey (list issues → check each for a plan → classify effort →
# drop manual-QA → order small-before-medium) is a deterministic sequence the supervisor
# otherwise re-reasons from natural language every few merges. One `gh issue list` that
# fetches bodies, then jq does plan-detection + effort/eligibility classification — so the
# supervisor reads a ready-made, ordered queue instead of re-deriving it (fewer turns =
# less per-turn cache re-read, the dominant cost). The ONE judgment left to the model is
# area-tagging for conflict-avoidance, which is fuzzy — do that on the QUEUE rows below.
#
# Output, one row per issue, already ordered (effort:S before effort:M, then by number):
#   QUEUE  #N  effort  plan=true  qa=false  [labels]  title   ← eligible, area-tag + dispatch
#   HOLD   #N  ...                                            ← effort L/XL, out of default fleet
#   SKIP   #N  ...                                            ← no plan, or manual-QA only
#
# Usage: scripts/survey.sh

set -euo pipefail

gh issue list --state open --limit 300 \
  --json number,title,labels,body \
  --jq '
    def eff:       (.labels | map(.name) | map(select(startswith("effort:"))) | (.[0] // "effort: ?"));
    def haveplan:  ((.body  // "") | test("Implementation plan|### Task|- \\[ \\]"));
    def manualqa:  ((.title // "") | test("visually|verify by hand|manual QA|by hand"; "i"));
    def tier:      (eff | if test("S") then 1 elif test("M") then 2 elif test("L") then 3 else 4 end);
    map({n:.number, title:.title, e:eff, plan:haveplan, qa:manualqa,
         labels:(.labels|map(.name)|join(",")), t:tier})
    | sort_by(.t, .n)
    | .[]
    | (if   (.t > 2)                      then "HOLD "
       elif (.plan and (.qa | not))       then "QUEUE"
       else                                    "SKIP "
       end) as $bucket
    | "\($bucket)\t#\(.n)\t\(.e)\tplan=\(.plan)\tqa=\(.qa)\t[\(.labels)]\t\(.title)"
  '
