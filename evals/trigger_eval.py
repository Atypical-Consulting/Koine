#!/usr/bin/env python3
"""Safe trigger-eval runner for the lifecycle skills (issue #372).

Measures whether a skill's *description* causes Claude to invoke that skill for a
set of queries, without ever executing the skill's body. It is a regression check
for the installed `create-issue` / `implement-issue` / `merge-pr` / `get-repo-profile`
descriptions: a description edit that starts over- or under-firing (or blurs the
`implement-issue` vs `merge-pr` boundary) shows up as a changed trigger rate.

WHY THIS EXISTS (and why we don't just use skill-creator's run_eval here)
------------------------------------------------------------------------
skill-creator's `scripts/run_eval.py` writes the candidate description as a
*uniquified* synthetic command file `<skill>-skill-<uuid>.md` and counts a trigger
only when that exact uuid-suffixed name appears in the model's `Skill`/`Read` tool
input. That assumes the model invokes the synthetic command by name. But in THIS
repo all four lifecycle skills are already installed under `.claude/skills/`, so a
should-trigger query makes the model invoke the *canonical* skill — e.g.
`Skill(skill="get-repo-profile")` — never `get-repo-profile-skill-<uuid>`. The
substring test therefore never matches and every query scores 0 triggers, for every
description. (See evals/README.md for the full diagnosis; issue #372.)

THE FIX: match the canonical installed skill name (in addition to the synthetic
uuid-suffixed one). Detection then registers real triggers.

SAFETY (critical — this is what makes it safe for the *action* skills)
---------------------------------------------------------------------
A should-trigger query like "merge PR 279" makes the model invoke the REAL
`merge-pr` skill. We must never let that execute. Safety comes from killing the
`claude -p` subprocess at the instant a tool-use *intent* is detected in the stream
(`content_block_start` / `content_block_delta` / `content_block_stop`), which is
emitted while the assistant message is still streaming — strictly BEFORE the harness
executes the tool. At most one tool-use is ever observed per run, and the process is
killed before it runs. The synthetic command file is kept for faithfulness to the
skill-creator approach, but it is the early kill — not the command file — that makes
this safe when the real skills are installed.
"""

import argparse
import json
import os
import re
import select
import subprocess
import sys
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

# The lifecycle skills this harness reasons about; used to report WHICH skill fired
# (so the implement-issue vs merge-pr boundary can be read off a single run).
DEFAULT_KNOWN = ["create-issue", "implement-issue", "merge-pr", "get-repo-profile"]


def find_project_root(start: Path | None = None) -> Path:
    """Walk up from `start` (or cwd) to the nearest dir containing `.claude/`."""
    current = (start or Path.cwd()).resolve()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def sweep_stale_command_files(project_root: Path) -> int:
    """Remove leftover synthetic command files (`*-skill-*.md`) from `.claude/commands/`.

    Each run cleans up its own file, but a hard interrupt (Ctrl-C SIGKILLs the
    pool's workers, so their `finally` never runs) can orphan them in the live
    repo's command namespace. Sweeping at the start/end of a run keeps it clean."""
    commands_dir = project_root / ".claude" / "commands"
    if not commands_dir.is_dir():
        return 0
    removed = 0
    for stale in commands_dir.glob("*-skill-*.md"):
        try:
            stale.unlink()
            removed += 1
        except OSError:
            pass
    return removed


def read_skill_description(project_root: Path, skill_name: str) -> str:
    """Pull the `description:` block scalar out of the installed SKILL.md."""
    skill_md = project_root / ".claude" / "skills" / skill_name / "SKILL.md"
    text = skill_md.read_text()
    # description: >-  (or |, or plain) followed by indented continuation lines.
    m = re.search(r"^description:\s*[>|]?-?\s*\n((?:[ \t]+.*\n?)+)", text, re.M)
    if m:
        lines = [ln.strip() for ln in m.group(1).splitlines()]
        return " ".join(ln for ln in lines if ln)
    # single-line form: `description: ...`
    m = re.search(r"^description:\s*(.+)$", text, re.M)
    return m.group(1).strip() if m else ""


def _tool_target(acc: str, tool: str) -> str:
    """Extract the structured value a Skill/Read tool-use refers to, from the
    (possibly still-streaming, unterminated) input JSON.

    For `Skill` that is the `"skill"` argument (a skill/command name); for `Read`
    it is the `"file_path"`. Matching this *field* — not a bare substring of the
    whole JSON blob — avoids counting an incidental mention of a skill name as a
    trigger (e.g. a Read whose path happens to contain another skill's name)."""
    if tool == "Skill":
        m = re.search(r'"skill"\s*:\s*"([^"]*)', acc)
        return m.group(1) if m else ""
    if tool == "Read":
        m = re.search(r'"file_path"\s*:\s*"([^"]*)', acc)
        return m.group(1) if m else ""
    return ""


def _names_match(target: str, tool: str, name: str) -> bool:
    """Does a Skill/Read `target` name/path invoke the skill `name`?

    Skill: the arg equals the name (allowing a `plugin:name` prefix). Read: the
    path is under that skill's own dir (or the synthetic command file)."""
    if not target:
        return False
    if tool == "Skill":
        return target == name or target.split(":")[-1] == name
    if tool == "Read":
        return (f"/skills/{name}/" in target) or (f"/commands/{name}." in target) or target.endswith(f"/{name}.md")
    return False


def _fired_name(acc: str, tool: str, candidates: list[str]) -> str | None:
    """Which of `candidates` the Skill/Read tool-use actually invoked (or None)."""
    target = _tool_target(acc, tool)
    for name in candidates:
        if _names_match(target, tool, name):
            return name
    return None


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    known: list[str],
    model: str | None = None,
) -> dict:
    """Run one `claude -p <query>` and report what skill (if any) it invoked.

    Returns {"triggered": bool, "fired": str|None, "first_tool": str|None}.
    `triggered` is True iff the TARGET skill (`skill_name`) was the one invoked.
    `fired` is whichever known skill the model invoked (for boundary analysis).
    The subprocess is killed at the first tool-use intent — before any tool runs.
    """
    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    project_commands_dir = Path(project_root) / ".claude" / "commands"
    command_file = project_commands_dir / f"{clean_name}.md"

    def result(triggered: bool, fired: str | None, first_tool: str | None,
               timed_out: bool = False) -> dict:
        return {"triggered": triggered, "fired": fired,
                "first_tool": first_tool, "timed_out": timed_out}

    try:
        project_commands_dir.mkdir(parents=True, exist_ok=True)
        indented_desc = "\n  ".join(skill_description.split("\n"))
        command_file.write_text(
            f"---\ndescription: |\n  {indented_desc}\n---\n\n"
            f"# {skill_name}\n\nThis skill handles: {skill_description}\n"
        )

        cmd = [
            "claude", "-p", query,
            "--output-format", "stream-json",
            "--verbose", "--include-partial-messages",
            # Defense-in-depth: even if the early kill ever lost the race (e.g. a
            # future CLI stopped emitting partial tool_use events, so detection
            # fell to the buffered `assistant` fallback), the action skills could
            # not actually mutate anything — the tools that do are denied. This
            # does not change which *skill* the model invokes (what we measure);
            # the Skill tool itself stays allowed and fires before any of these.
            "--disallowedTools", "Bash", "Edit", "Write", "NotebookEdit",
        ]
        if model:
            cmd.extend(["--model", model])

        # CLAUDECODE guards interactive terminals; strip it so claude -p can nest.
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=project_root, env=env,
        )

        start = time.time()
        buffer = ""
        pending_tool = None
        acc = ""
        targets = (skill_name, clean_name)

        def matched(a: str, tool: str) -> bool:
            """Did the pending Skill/Read tool-use invoke OUR target skill?"""
            return any(_names_match(_tool_target(a, tool), tool, t) for t in targets)

        try:
            while time.time() - start < timeout:
                if process.poll() is not None:
                    # Drain via os.read on the same fd we stream from — never mix
                    # buffered `.read()` here, or bytes already pulled into the
                    # stdio buffer would be lost and a JSON line silently dropped.
                    while True:
                        rest = os.read(process.stdout.fileno(), 8192)
                        if not rest:
                            break
                        buffer += rest.decode("utf-8", errors="replace")
                    break
                ready, _, _ = select.select([process.stdout], [], [], 1.0)
                if not ready:
                    continue
                chunk = os.read(process.stdout.fileno(), 8192)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    etype = event.get("type")
                    if etype == "stream_event":
                        se = event.get("event", {})
                        se_type = se.get("type", "")
                        if se_type == "content_block_start":
                            cb = se.get("content_block", {})
                            if cb.get("type") == "tool_use":
                                tool = cb.get("name", "")
                                if tool in ("Skill", "Read"):
                                    pending_tool, acc = tool, ""
                                else:
                                    # Model reached for a non-skill tool first: it
                                    # did not invoke a skill. Stop now (and kill),
                                    # before that tool can execute.
                                    return result(False, None, tool)
                        elif se_type == "content_block_delta" and pending_tool:
                            delta = se.get("delta", {})
                            if delta.get("type") == "input_json_delta":
                                acc += delta.get("partial_json", "")
                                if matched(acc, pending_tool):
                                    return result(True, skill_name, pending_tool)
                        elif se_type in ("content_block_stop", "message_stop"):
                            if pending_tool:
                                m = matched(acc, pending_tool)
                                fired = skill_name if m else _fired_name(acc, pending_tool, known)
                                return result(m, fired, pending_tool)
                            if se_type == "message_stop":
                                return result(False, None, None)

                    elif etype == "assistant":
                        # Non-partial fallback: a fully-formed tool_use message.
                        for c in event.get("message", {}).get("content", []):
                            if c.get("type") != "tool_use":
                                continue
                            tool = c.get("name", "")
                            inp = json.dumps(c.get("input", {}))
                            if tool in ("Skill", "Read"):
                                m = matched(inp, tool)
                                return result(m, skill_name if m else _fired_name(inp, tool, known), tool)
                            return result(False, None, tool)
                    elif etype == "result":
                        return result(False, None, None)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

        # Reached without a decisive event: distinguish a real timeout (slow run,
        # reported so it can be retried) from a clean stream that simply ended.
        return result(False, None, None, timed_out=(time.time() - start >= timeout))
    finally:
        if command_file.exists():
            command_file.unlink()


def run_eval(eval_set, skill_name, description, known, workers, timeout,
             project_root, runs_per_query, threshold, model):
    seen = set()
    for it in eval_set:
        if it["query"] in seen:
            print(f"Warning: duplicate query collapses runs/expectations: {it['query'][:60]!r}",
                  file=sys.stderr)
        seen.add(it["query"])

    sweep_stale_command_files(Path(project_root))
    futures = {}
    per_query: dict[str, list[dict]] = {}
    try:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            for item in eval_set:
                for run_idx in range(runs_per_query):
                    fut = ex.submit(
                        run_single_query, item["query"], skill_name, description,
                        timeout, str(project_root), known, model,
                    )
                    futures[fut] = item["query"]

            for fut in as_completed(futures):
                q = futures[fut]
                try:
                    per_query.setdefault(q, []).append(fut.result())
                except Exception as e:  # noqa: BLE001 - a crashed run counts as no-trigger
                    print(f"Warning: query failed: {e}", file=sys.stderr)
                    per_query.setdefault(q, []).append(
                        {"triggered": False, "fired": None, "first_tool": None, "timed_out": False})
    finally:
        sweep_stale_command_files(Path(project_root))

    timed_out = sum(1 for runs in per_query.values() for r in runs if r.get("timed_out"))
    if timed_out:
        print(f"Warning: {timed_out} run(s) timed out (counted as no-trigger) — "
              f"raise --timeout if recall looks low", file=sys.stderr)

    by_query = {it["query"]: it for it in eval_set}
    results = []
    for q, runs in per_query.items():
        item = by_query[q]
        triggers = sum(1 for r in runs if r["triggered"])
        rate = triggers / len(runs)
        should = item["should_trigger"]
        did_pass = (rate >= threshold) if should else (rate < threshold)
        fired_counts: dict[str, int] = {}
        for r in runs:
            key = r["fired"] or "(none)"
            fired_counts[key] = fired_counts.get(key, 0) + 1
        results.append({
            "query": q,
            "note": item.get("note", ""),
            "should_trigger": should,
            "trigger_rate": rate,
            "triggers": triggers,
            "runs": len(runs),
            "fired": fired_counts,
            "pass": did_pass,
        })

    results.sort(key=lambda r: (not r["should_trigger"], r["query"]))
    pos = [r for r in results if r["should_trigger"]]
    neg = [r for r in results if not r["should_trigger"]]
    recall = sum(r["pass"] for r in pos) / len(pos) if pos else None
    specificity = sum(r["pass"] for r in neg) / len(neg) if neg else None
    return {
        "skill_name": skill_name,
        "runs_per_query": runs_per_query,
        "threshold": threshold,
        "results": results,
        "summary": {
            "total": len(results),
            "passed": sum(r["pass"] for r in results),
            "failed": sum(not r["pass"] for r in results),
            "should_trigger": len(pos),
            "should_not": len(neg),
            "recall": recall,
            "specificity": specificity,
        },
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skill", required=True, help="Target skill name (e.g. implement-issue)")
    ap.add_argument("--eval-set", required=True, help="Path to eval-set JSON (list of {query, should_trigger, note?})")
    ap.add_argument("--project-root", default=None, help="Repo root (default: walk up to .claude/)")
    ap.add_argument("--known", default=None, help="Comma list of skill names to report as 'fired' (default: the four lifecycle skills)")
    ap.add_argument("--runs-per-query", type=int, default=3)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--timeout", type=int, default=90, help="Per-query timeout (s)")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--model", default=None)
    ap.add_argument("--out", default=None, help="Write results JSON here (also printed to stdout)")
    ap.add_argument("--description", default=None, help="Override the description under test (default: read SKILL.md)")
    args = ap.parse_args()

    project_root = Path(args.project_root) if args.project_root else find_project_root()
    known = [s.strip() for s in args.known.split(",")] if args.known else list(DEFAULT_KNOWN)
    if args.skill not in known:
        known = [args.skill, *known]
    description = args.description or read_skill_description(project_root, args.skill)
    if not description:
        print(f"Error: no description found for skill '{args.skill}'", file=sys.stderr)
        sys.exit(1)

    eval_set = json.loads(Path(args.eval_set).read_text())
    out = run_eval(
        eval_set=eval_set, skill_name=args.skill, description=description, known=known,
        workers=args.workers, timeout=args.timeout, project_root=project_root,
        runs_per_query=args.runs_per_query, threshold=args.threshold, model=args.model,
    )

    s = out["summary"]
    print(f"[{args.skill}] {s['passed']}/{s['total']} pass  "
          f"recall={s['recall']}  specificity={s['specificity']}", file=sys.stderr)
    for r in out["results"]:
        status = "PASS" if r["pass"] else "FAIL"
        fired = ",".join(f"{k}:{v}" for k, v in r["fired"].items())
        print(f"  [{status}] {r['triggers']}/{r['runs']} exp={r['should_trigger']!s:5} "
              f"fired=[{fired}]  {r['query'][:64]}", file=sys.stderr)

    payload = json.dumps(out, indent=2)
    if args.out:
        Path(args.out).write_text(payload + "\n")
    print(payload)


if __name__ == "__main__":
    main()
