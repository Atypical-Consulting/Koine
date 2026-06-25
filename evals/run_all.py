#!/usr/bin/env python3
"""Run every lifecycle-skill trigger-eval set + the boundary, refresh the baseline.

Thin orchestration over `trigger_eval.py`: runs each `<skill>-trigger-eval.json`
set, writes per-skill results to `evals/results/<skill>.json`, runs the shared
boundary set against both `implement-issue` and `merge-pr`, and writes a compact
`evals/results/baseline.json` summary. See evals/README.md for the diagnosis,
safety model, and how the numbers are read.
"""

import argparse
import json
from pathlib import Path

import trigger_eval as te

SKILLS = ["create-issue", "implement-issue", "merge-pr", "get-repo-profile"]
EVALS_DIR = Path(__file__).resolve().parent
RESULTS_DIR = EVALS_DIR / "results"


def _run(skill, eval_set, project_root, runs, workers, timeout, threshold, model, known=None):
    description = te.read_skill_description(project_root, skill)
    return te.run_eval(
        eval_set=eval_set, skill_name=skill, description=description,
        known=known or list(te.DEFAULT_KNOWN), workers=workers, timeout=timeout,
        project_root=project_root, runs_per_query=runs, threshold=threshold, model=model,
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--runs-per-query", type=int, default=3)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--timeout", type=int, default=90)
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--model", default=None)
    ap.add_argument("--skills", default=None, help="Comma list to limit which skills run")
    args = ap.parse_args()

    project_root = te.find_project_root()
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    selected = args.skills is not None
    skills = [s.strip() for s in args.skills.split(",")] if selected else SKILLS

    # Merge into the existing baseline rather than overwrite it, so a scoped run
    # (`--skills create-issue`) refreshes only that entry and leaves the other
    # committed skills/boundary intact instead of dropping them.
    baseline_path = RESULTS_DIR / "baseline.json"
    baseline = json.loads(baseline_path.read_text()) if baseline_path.exists() else {}
    baseline["runs_per_query"] = args.runs_per_query
    baseline["threshold"] = args.threshold
    baseline.setdefault("skills", {})

    for skill in skills:
        eval_path = EVALS_DIR / f"{skill}-trigger-eval.json"
        if not eval_path.exists():
            print(f"! skipping {skill}: no {eval_path.name}")
            continue
        eval_set = json.loads(eval_path.read_text())
        out = _run(skill, eval_set, project_root, args.runs_per_query, args.workers,
                   args.timeout, args.threshold, args.model)
        (RESULTS_DIR / f"{skill}.json").write_text(json.dumps(out, indent=2) + "\n")
        s = out["summary"]
        baseline["skills"][skill] = {
            "passed": s["passed"], "total": s["total"],
            "recall": s["recall"], "specificity": s["specificity"],
        }
        print(f"[{skill}] {s['passed']}/{s['total']}  recall={s['recall']}  specificity={s['specificity']}")

    # Boundary: same queries, both skills. Each query carries a per-skill expectation.
    # Skip it on a scoped run that excludes both boundary skills, so `--skills
    # create-issue` doesn't fire the real boundary queries or churn its artifacts.
    boundary_path = EVALS_DIR / "boundary-trigger-eval.json"
    run_boundary = boundary_path.exists() and (
        not selected or bool({"implement-issue", "merge-pr"} & set(skills)))
    if run_boundary:
        boundary = json.loads(boundary_path.read_text())
        bres = {}
        for skill in ("implement-issue", "merge-pr"):
            eval_set = [{"query": q["query"], "should_trigger": q["expect"][skill], "note": q.get("note", "")}
                        for q in boundary]
            out = _run(skill, eval_set, project_root, args.runs_per_query, args.workers,
                       args.timeout, args.threshold, args.model,
                       known=["implement-issue", "merge-pr", "create-issue", "get-repo-profile"])
            (RESULTS_DIR / f"boundary-{skill}.json").write_text(json.dumps(out, indent=2) + "\n")
            bres[skill] = out["summary"]
            print(f"[boundary→{skill}] {out['summary']['passed']}/{out['summary']['total']}")
        baseline["boundary"] = bres

    (RESULTS_DIR / "baseline.json").write_text(json.dumps(baseline, indent=2) + "\n")
    print(f"\nWrote {RESULTS_DIR}/baseline.json")


if __name__ == "__main__":
    main()
