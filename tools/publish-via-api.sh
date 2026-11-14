#!/usr/bin/env bash
# Rebuild the repository through the GitHub git-data API so every commit carries
# the noreply address instead of a real mailbox.
#
# The bundled git cannot reach github.com (schannel credential failure), so all
# writes go through `gh api`, which uses its own HTTP stack.
set -euo pipefail

REPO="tuifeibenfeifei/dsh-file-outline"
AUTHOR_NAME="tuifeibenfeifei"
AUTHOR_EMAIL="238186998+tuifeibenfeifei@users.noreply.github.com"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "1/4 uploading blobs"
python - "$WORK/tree.json" "$REPO" <<'PY'
import base64, json, os, subprocess, sys

repo = sys.argv[2]
root = os.getcwd()
ignored = set()
try:
    out = subprocess.run(["git", "ls-files", "--others", "--cached", "--ignored",
                          "--exclude-standard"], capture_output=True, text=True)
    ignored = {line.strip() for line in out.stdout.splitlines() if line.strip()}
except Exception:
    pass

entries = []
for dirpath, dirnames, filenames in os.walk(root):
    if ".git" in dirnames:
        dirnames.remove(".git")
    for name in sorted(filenames):
        full = os.path.join(dirpath, name)
        rel = os.path.relpath(full, root).replace(os.sep, "/")
        if rel in ignored:
            continue
        with open(full, "rb") as handle:
            data = handle.read()
        payload = json.dumps({
            "content": base64.b64encode(data).decode("ascii"),
            "encoding": "base64",
        })
        result = subprocess.run(
            ["gh", "api", "-X", "POST", f"repos/{repo}/git/blobs", "--input", "-", "--jq", ".sha"],
            input=payload, capture_output=True, text=True,
        )
        if result.returncode != 0:
            print(f"    FAIL {rel}: {result.stderr.strip()[:120]}", file=sys.stderr)
            sys.exit(1)
        entries.append({"path": rel, "mode": "100644", "type": "blob", "sha": result.stdout.strip()})
        print(f"    ok {rel}")

with open(sys.argv[1], "w") as handle:
    json.dump({"tree": entries}, handle)
print(f"    {len(entries)} blobs")
PY

echo "2/4 creating tree"
TREE_SHA=$(gh api -X POST "repos/$REPO/git/trees" --input "$WORK/tree.json" --jq .sha)
echo "    tree $TREE_SHA"

echo "3/4 creating commit"
python - "$WORK/commit.json" "$TREE_SHA" "$AUTHOR_NAME" "$AUTHOR_EMAIL" "$NOW" <<'PY'
import json, sys

message = """feat: structural map for large text files

Three read-only, deterministic tools that tell the agent where content lives
in a file too big to read whole, instead of making search faster.

- file_card: identity, size tier, heading tree, clipped head/tail samples,
  and a paragraph/prefix fallback for files with no headings
- outline: heading tree with line ranges; with a keyword, per-section hit
  attribution plus a global distribution view so the model can answer
  "where does this concentrate" without doing its own aggregation
- digest: a line range reduced to a token budget, stating what was left out
  and the exact lines= value that continues

Streaming throughout: memory is constant, a 14 MB file scans in ~165 ms.
Zero runtime dependencies. Windows only, declared via the os field.
219 local tests across nine suites, no model calls."""

payload = {
    "message": message,
    "tree": sys.argv[2],
    "author": {"name": sys.argv[3], "email": sys.argv[4], "date": sys.argv[5]},
    "committer": {"name": sys.argv[3], "email": sys.argv[4], "date": sys.argv[5]},
    "parents": [],
}
with open(sys.argv[1], "w") as handle:
    json.dump(payload, handle)
PY
COMMIT_SHA=$(gh api -X POST "repos/$REPO/git/commits" --input "$WORK/commit.json" --jq .sha)
echo "    commit $COMMIT_SHA"

echo "4/4 updating main"
gh api -X PATCH "repos/$REPO/git/refs/heads/main" \
  -f sha="$COMMIT_SHA" -F force=true --jq '.object.sha'

echo
echo "done: https://github.com/$REPO"
