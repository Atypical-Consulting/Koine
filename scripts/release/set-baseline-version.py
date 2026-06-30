#!/usr/bin/env python3
"""Write a computed baseline version into .release-please-manifest.json and the
x-release-please-version-marked fields in Directory.Build.props. Called once by
the bootstrap-baseline job in .github/workflows/release-please.yml with the
output of compute-historical-version.py.
"""

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def main():
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <version>")
    version = sys.argv[1]

    manifest_path = REPO_ROOT / ".release-please-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["."] = version
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    props_path = REPO_ROOT / "Directory.Build.props"
    props = props_path.read_text()
    for tag in ("Version", "InformationalVersion"):
        props, count = re.subn(
            rf"<{tag}>[^<]*</{tag}> <!-- x-release-please-version -->",
            f"<{tag}>{version}</{tag}> <!-- x-release-please-version -->",
            props,
        )
        if count != 1:
            raise SystemExit(f"expected exactly one x-release-please-version {tag} marker, found {count}")
    props_path.write_text(props)


if __name__ == "__main__":
    main()
