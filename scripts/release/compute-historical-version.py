#!/usr/bin/env python3
"""Replay every Conventional Commit on a ref and print the semver that
release-please's DefaultVersioningStrategy would have produced if each
commit had triggered its own release, starting from 0.0.0.

Used once by .github/workflows/release-please.yml to bootstrap the real
baseline version (see adr/0002-conventional-commits-and-automated-semver.md)
instead of hand-picking one. Reads bump-minor-pre-major /
bump-patch-for-minor-pre-major from release-please-config.json so it stays
in sync with the configured versioning strategy.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CONVENTIONAL_COMMIT_RE = re.compile(r"^(\w+)(\([^)]*\))?(!)?:\s*(.*)$")
BREAKING_FOOTER_RE = re.compile(r"^BREAKING[ -]CHANGE:", re.MULTILINE)


def load_release_please_config():
    config = json.loads((REPO_ROOT / "release-please-config.json").read_text())
    package = config["packages"]["."]
    if package.get("release-type", "simple") != "simple":
        raise SystemExit(
            f"release-type {package.get('release-type')!r} isn't 'simple' — "
            "this script only implements the default versioning strategy."
        )
    return {
        "bump_minor_pre_major": bool(config.get("bump-minor-pre-major", False)),
        "bump_patch_for_minor_pre_major": bool(
            config.get("bump-patch-for-minor-pre-major", False)
        ),
    }


def iter_commits(ref):
    raw = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "log", "--reverse", "--format=%H%x01%s%x01%B%x02", ref],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    for record in raw.split("\x02"):
        if not record.strip():
            continue
        sha, subject, body = record.split("\x01", 2)
        yield sha.strip(), subject, body


def classify(subject, body):
    match = CONVENTIONAL_COMMIT_RE.match(subject.strip())
    if not match:
        raise SystemExit(f"commit subject isn't Conventional Commits form: {subject!r}")
    commit_type = match.group(1).lower()
    breaking = bool(match.group(3)) or bool(BREAKING_FOOTER_RE.search(body))
    return commit_type, breaking


def bump(major, minor, patch, commit_type, breaking, strategy):
    if breaking:
        if major == 0 and strategy["bump_minor_pre_major"]:
            return major, minor + 1, 0
        return major + 1, 0, 0
    if commit_type in ("feat", "feature"):
        if major == 0 and strategy["bump_patch_for_minor_pre_major"]:
            return major, minor, patch + 1
        return major, minor + 1, 0
    return major, minor, patch + 1


def compute(ref):
    strategy = load_release_please_config()
    major, minor, patch = 0, 0, 0
    seen = 0
    for sha, subject, body in iter_commits(ref):
        commit_type, breaking = classify(subject, body)
        major, minor, patch = bump(major, minor, patch, commit_type, breaking, strategy)
        seen += 1
    if seen == 0:
        raise SystemExit(f"no commits found on ref {ref!r}")
    return major, minor, patch


def main():
    ref = sys.argv[1] if len(sys.argv) > 1 else "HEAD"
    major, minor, patch = compute(ref)
    print(f"{major}.{minor}.{patch}")


if __name__ == "__main__":
    main()
